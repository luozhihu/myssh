import net, { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Proxy, ProxyAuth } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";

export const TCP_DIAL_TIMEOUT_MS = 10_000;
export const EDR_MAX_RETRIES = 2;
export const EDR_RETRY_DELAY_MS = 100;
const WSA_EACCES = 10013;

export type TcpDialer = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<net.Socket>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function splitHostPort(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(":");
  if (index < 0) throw new Error(`address ${addr}: missing port in address`);
  let host = addr.slice(0, index);
  const portText = addr.slice(index + 1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`address ${addr}: invalid port ${JSON.stringify(portText)}`);
  }
  return { host, port };
}

export function netDial(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`dial tcp ${host}:${port}: i/o timeout`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 奇安信天擎等 EDR 的 WFP filter 偶发本地拒绝 connect（WSAEACCES / 10013）。 */
export function isLocalPolicyReject(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.errno === WSA_EACCES || (process.platform === "win32" && e?.code === "EACCES");
}

export async function dialTcpWithRetry(
  dial: TcpDialer,
  host: string,
  port: number,
  timeoutMs: number,
  logger: Logger = nullLogger,
): Promise<net.Socket> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EDR_MAX_RETRIES; attempt += 1) {
    try {
      return await dial(host, port, timeoutMs);
    } catch (err) {
      lastError = err;
      if (!isLocalPolicyReject(err) || attempt === EDR_MAX_RETRIES) break;
      logger.warn("tcp dial rejected locally by policy (WSAEACCES), retrying", {
        addr: `${host}:${port}`,
        attempt: attempt + 1,
        max_retries: EDR_MAX_RETRIES,
      });
      await sleep(EDR_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** 在代理握手阶段按字节读取，并保留握手后的剩余字节。 */
export class SocketReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private error: Error | undefined;
  private ended = false;
  private readonly onData = (data: Buffer): void => {
    this.buf = Buffer.concat([this.buf, data]);
    this.notify();
  };
  private readonly onError = (err: Error): void => {
    this.error = err;
    this.notify();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.notify();
  };

  attach(socket: net.Socket): void {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }

  detach(socket: net.Socket): void {
    socket.off("data", this.onData);
    socket.off("error", this.onError);
    socket.off("end", this.onEnd);
    socket.off("close", this.onEnd);
  }

  leftover(): Buffer {
    return this.buf;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private wait(): Promise<void> {
    if (this.buf.length > 0 || this.error || this.ended) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private take(count: number): Buffer {
    const out = this.buf.subarray(0, count);
    this.buf = this.buf.subarray(count);
    return out;
  }

  async read(count: number): Promise<Buffer> {
    while (this.buf.length < count) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error("connection closed");
      await this.wait();
    }
    return this.take(count);
  }

  async readUntil(needle: string, maxBytes: number): Promise<Buffer> {
    const marker = Buffer.from(needle, "latin1");
    for (;;) {
      const index = this.buf.indexOf(marker);
      if (index >= 0) return this.take(index + marker.length);
      if (this.buf.length > maxBytes) throw new Error("response too large");
      if (this.error) throw this.error;
      if (this.ended) throw new Error("connection closed");
      await this.wait();
    }
  }
}

async function socks5Handshake(
  socket: net.Socket,
  target: string,
  auth: ProxyAuth | undefined,
): Promise<void> {
  const reader = new SocketReader();
  reader.attach(socket);
  const { host, port } = splitHostPort(target);

  const methods = auth?.user ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw new Error("socks5: bad version");
  const method = greeting[1]!;
  if (method === 0xff) throw new Error("socks5: no acceptable authentication methods");
  if (method === 0x02) {
    if (!auth?.user) throw new Error("socks5: server requires authentication");
    const user = Buffer.from(auth.user, "utf8");
    const pass = Buffer.from(auth.password ?? "", "utf8");
    socket.write(Buffer.concat([
      Buffer.from([0x01, user.length]), user,
      Buffer.from([pass.length]), pass,
    ]));
    const reply = await reader.read(2);
    if (reply[0] !== 0x01 || reply[1] !== 0x00) {
      throw new Error("socks5: authentication failed");
    }
  } else if (method !== 0x00) {
    throw new Error(`socks5: unsupported auth method ${method}`);
  }

  const ipVersion = isIP(host);
  let atyp: number;
  let address: Buffer;
  if (ipVersion === 4) {
    atyp = 0x01;
    address = Buffer.from(host.split(".").map((part) => Number(part)));
  } else if (ipVersion === 6) {
    atyp = 0x04;
    address = ipv6Bytes(host);
  } else {
    atyp = 0x03;
    const name = Buffer.from(host, "utf8");
    address = Buffer.concat([Buffer.from([name.length]), name]);
  }
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, atyp]), address, portBytes,
  ]));

  const head = await reader.read(4);
  if (head[0] !== 0x05) throw new Error("socks5: bad reply version");
  if (head[1] !== 0x00) throw new Error(`socks5 connect failed: reply code ${head[1]}`);
  const boundType = head[3]!;
  if (boundType === 0x01) await reader.read(4 + 2);
  else if (boundType === 0x04) await reader.read(16 + 2);
  else if (boundType === 0x03) {
    const length = (await reader.read(1))[0]!;
    await reader.read(length + 2);
  } else {
    throw new Error(`socks5: bad address type ${boundType}`);
  }

  const leftover = reader.leftover();
  reader.detach(socket);
  if (leftover.length > 0) socket.unshift(leftover);
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail] = host.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = host.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => {
    out.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2);
  });
  return out;
}

async function httpConnect(
  proxyAddr: string,
  auth: ProxyAuth | undefined,
  target: string,
  timeoutMs: number,
  logger: Logger,
): Promise<net.Socket> {
  const { host, port } = splitHostPort(proxyAddr);
  const socket = await dialTcpWithRetry(netDial, host, port, timeoutMs, logger);
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("proxy handshake timed out")));
  const reader = new SocketReader();
  reader.attach(socket);
  let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
  if (auth?.user) {
    const credentials = Buffer.from(`${auth.user}:${auth.password ?? ""}`).toString("base64");
    request += `Proxy-Authorization: Basic ${credentials}\r\n`;
  }
  request += "\r\n";
  socket.write(Buffer.from(request, "latin1"));
  let response: Buffer;
  try {
    response = await reader.readUntil("\r\n\r\n", 8192);
  } catch (err) {
    reader.detach(socket);
    socket.destroy();
    throw err;
  }
  const statusLine = response.toString("latin1").split("\r\n", 1)[0] ?? "";
  if (!statusLine.startsWith("HTTP/1.1 200") && !statusLine.startsWith("HTTP/1.0 200")) {
    reader.detach(socket);
    socket.destroy();
    throw new Error(`proxy CONNECT failed: ${statusLine}`);
  }
  const leftover = reader.leftover();
  reader.detach(socket);
  socket.setTimeout(0);
  if (leftover.length > 0) socket.unshift(leftover);
  return socket;
}

export async function connectUnderlying(
  addr: string,
  proxy: Proxy | undefined,
  logger: Logger = nullLogger,
): Promise<net.Socket> {
  if (!proxy) {
    const { host, port } = splitHostPort(addr);
    return dialTcpWithRetry(netDial, host, port, TCP_DIAL_TIMEOUT_MS, logger);
  }
  switch (proxy.type) {
    case "SOCKS5": {
      const { host, port } = splitHostPort(proxy.addr);
      const socket = await dialTcpWithRetry(
        netDial, host, port, TCP_DIAL_TIMEOUT_MS, logger,
      );
      socket.setTimeout(TCP_DIAL_TIMEOUT_MS, () => {
        socket.destroy(new Error("proxy handshake timed out"));
      });
      try {
        await socks5Handshake(socket, addr, proxy.auth);
      } catch (err) {
        socket.destroy();
        throw new Error(`socks5 dialer: ${message(err)}`);
      }
      socket.setTimeout(0);
      return socket;
    }
    case "HTTP":
      return httpConnect(proxy.addr, proxy.auth, addr, TCP_DIAL_TIMEOUT_MS, logger);
    default:
      throw new Error(`unknown proxy type ${JSON.stringify((proxy as Proxy).type)}`);
  }
}
