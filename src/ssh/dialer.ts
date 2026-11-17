import { readFileSync, statSync } from "node:fs";
import type net from "node:net";
import ssh2 from "ssh2";
import type { Client as SshClient, ClientChannel, ConnectConfig } from "ssh2";
import type { Proxy, SSHAuth } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import { KnownHostsStore } from "./known_hosts.js";
import { connectUnderlying, splitHostPort } from "./proxy.js";

const { Client, utils } = ssh2;

export interface DialOptions {
  addr: string;
  user: string;
  auth: SSHAuth;
  proxy?: Proxy;
  serverName?: string;
  hostKeyVerify: boolean;
}

export interface AuthConfig {
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 装配认证信息。private_key 优先，即使同时配置 password 也不回退。
 * 私钥权限必须 0600 或更严（Windows 跳过，交给 NTFS ACL）。
 */
export function loadAuth(auth: SSHAuth): AuthConfig {
  if (auth.private_key) {
    return {
      privateKey: loadPrivateKey(auth.private_key, auth.passphrase),
      passphrase: auth.passphrase,
    };
  }
  if (auth.password) return { password: auth.password };
  throw new Error("no auth method available (need password or private_key)");
}

export function loadPrivateKey(keyPath: string, passphrase?: string): Buffer {
  let info;
  try {
    info = statSync(keyPath);
  } catch (err) {
    throw new Error(`stat private key ${keyPath}: ${message(err)}`);
  }
  if (process.platform !== "win32") {
    const perm = info.mode & 0o777;
    if ((perm & 0o077) !== 0) {
      throw new Error(
        `private key ${keyPath} permissions too open: ${perm.toString(8)}, want 0600 or stricter (no group/other access)`,
      );
    }
  }
  let data: Buffer;
  try {
    data = readFileSync(keyPath);
  } catch (err) {
    throw new Error(`read private key ${keyPath}: ${message(err)}`);
  }
  const parsed = utils.parseKey(data, passphrase || undefined);
  if (parsed instanceof Error) {
    throw new Error(`parse private key ${keyPath}: ${parsed.message}`);
  }
  return data;
}

export class Dialer {
  constructor(
    private readonly knownHosts: KnownHostsStore,
    private readonly logger: Logger = nullLogger,
  ) {}

  async dial(opts: DialOptions): Promise<SshClient> {
    this.logger.debug("dialing", {
      server: opts.serverName,
      addr: opts.addr,
      user: opts.user,
      auth_method: opts.auth.private_key ? "private_key" : "password",
      via_proxy: !!opts.proxy,
    });
    const auth = loadAuth(opts.auth);

    let socket: net.Socket;
    try {
      socket = await connectUnderlying(opts.addr, opts.proxy, this.logger);
    } catch (err) {
      throw new Error(`dial ${opts.addr}: ${message(err)}`);
    }
    return this.connectOverSocket(socket, opts, auth);
  }

  /**
   * 在已有 socket / direct-tcpip channel 上完成 SSH 握手。
   * hostVerifier 记录 TOFU 错误；握手失败时优先抛出该错误。
   */
  private async connectOverSocket(
    socket: net.Socket | ClientChannel,
    opts: DialOptions,
    auth: AuthConfig,
  ): Promise<SshClient> {
    let hostKeyError: Error | undefined;
    const { host, port } = splitHostPort(opts.addr);
    const config: ConnectConfig = {
      host,
      port,
      username: opts.user,
      sock: socket as unknown as net.Socket,
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer): boolean => {
        if (!opts.hostKeyVerify) {
          this.logger.debug("host key verification disabled", {
            server: opts.serverName,
            addr: opts.addr,
          });
          return true;
        }
        try {
          const status = this.knownHosts.check(opts.addr, key);
          this.logger.debug("host key verified", {
            server: opts.serverName,
            addr: opts.addr,
            fingerprint: status,
          });
          return true;
        } catch (err) {
          hostKeyError = err instanceof Error ? err : new Error(String(err));
          this.logger.warn("host key check failed", {
            server: opts.serverName,
            addr: opts.addr,
            err: hostKeyError.message,
          });
          return false;
        }
      },
    };
    if (auth.password !== undefined) config.password = auth.password;
    if (auth.privateKey !== undefined) config.privateKey = auth.privateKey;
    if (auth.passphrase !== undefined) config.passphrase = auth.passphrase;

    const client = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(err);
        };
        client.once("ready", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        client.once("error", fail);
        client.once("close", () => fail(new Error("connection closed")));
        client.connect(config);
      });
    } catch (err) {
      if (hostKeyError) throw hostKeyError;
      throw new Error(`ssh connect to ${opts.addr}: ${message(err)}`);
    }
    client.on("error", (err: Error) => {
      this.logger.warn("ssh client error", {
        server: opts.serverName,
        addr: opts.addr,
        err: err.message,
      });
    });
    this.logger.debug("ssh connected", {
      server: opts.serverName,
      addr: opts.addr,
    });
    return client;
  }

  /** 经 jumphost 打开 direct-tcpip；10s 硬超时兜底。 */
  private openDirectTcpip(
    jumpClient: SshClient,
    host: string,
    port: number,
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("open direct-tcpip timed out after 10s"));
      }, 10_000);
      try {
        jumpClient.forwardOut("127.0.0.1", 0, host, port, (err, channel) => {
          if (settled) {
            if (!err && channel) channel.destroy();
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (err) reject(new Error(message(err)));
          else resolve(channel);
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /** 经 jumphost 的 direct-tcpip 通道拨号 target（ssh -J 语义）。 */
  async dialThrough(jumpClient: SshClient, opts: DialOptions): Promise<SshClient> {
    this.logger.debug("dialing through", {
      server: opts.serverName,
      addr: opts.addr,
      user: opts.user,
      auth_method: opts.auth.private_key ? "private_key" : "password",
      via_jumphost: true,
    });
    const auth = loadAuth(opts.auth);
    const { host, port } = splitHostPort(opts.addr);
    let channel: ClientChannel;
    try {
      channel = await this.openDirectTcpip(jumpClient, host, port);
    } catch (err) {
      throw new Error(`dial ${opts.addr} through jumphost: ${message(err)}`);
    }
    return this.connectOverSocket(channel, opts, auth);
  }
}
