import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { connectUnderlying, splitHostPort } from "../../src/ssh/proxy.js";

async function listen(
  onSocket: (socket: net.Socket) => void,
): Promise<{ addr: string; port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    addr: `127.0.0.1:${port}`,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startHttpProxy(respond: string, banner = "") {
  const requests: string[] = [];
  return listen((socket) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      requests.push(data.subarray(0, end + 4).toString("latin1"));
      socket.write(respond + banner);
      socket.on("data", (rest) => socket.write(rest));
    };
    socket.on("data", onData);
  }).then((server) => ({ ...server, requests }));
}

function startSocks5(opts: { user?: string; password?: string } = {}) {
  return listen((socket) => {
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "request" | "done" = "greeting";
    socket.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      for (;;) {
        if (stage === "greeting") {
          if (buf.length < 2) return;
          const count = buf[1]!;
          if (buf.length < 2 + count) return;
          const methods = buf.subarray(2, 2 + count);
          buf = buf.subarray(2 + count);
          if (opts.user) {
            if (!methods.includes(2)) {
              socket.end(Buffer.from([5, 0xff]));
              return;
            }
            socket.write(Buffer.from([5, 2]));
            stage = "auth";
          } else {
            socket.write(Buffer.from([5, 0]));
            stage = "request";
          }
          continue;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1]!;
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen]!;
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString("utf8");
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
          buf = buf.subarray(3 + ulen + plen);
          const ok = user === opts.user && pass === opts.password;
          socket.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) {
            socket.end();
            return;
          }
          stage = "request";
          continue;
        }
        if (stage === "request") {
          if (buf.length < 5) return;
          const atyp = buf[3]!;
          let need: number;
          if (atyp === 1) need = 4 + 2;
          else if (atyp === 4) need = 16 + 2;
          else if (atyp === 3) need = 1 + buf[4]! + 2;
          else {
            socket.end();
            return;
          }
          if (buf.length < 4 + need) return;
          buf = buf.subarray(4 + need);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]));
          stage = "done";
          continue;
        }
        if (stage === "done" && buf.length > 0) {
          socket.write(buf);
          buf = Buffer.alloc(0);
        }
        return;
      }
    });
  });
}

function readOnce(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("read timeout")), 1000);
    socket.once("data", (data: Buffer) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("splitHostPort", () => {
  it("parses hostname, IPv4 and bracketed IPv6", () => {
    expect(splitHostPort("example.com:22")).toEqual({ host: "example.com", port: 22 });
    expect(splitHostPort("1.2.3.4:2222")).toEqual({ host: "1.2.3.4", port: 2222 });
    expect(splitHostPort("[::1]:22")).toEqual({ host: "::1", port: 22 });
    expect(() => splitHostPort("nope")).toThrow();
  });
});

describe("HTTP CONNECT proxy", () => {
  it("sends the exact CONNECT request and forwards trailing bytes", async () => {
    const proxy = await startHttpProxy(
      "HTTP/1.1 200 Connection established\r\n\r\n",
      "SSH-2.0-fake\r\n",
    );
    try {
      const socket = await connectUnderlying("203.0.113.9:22", {
        name: "p", type: "HTTP", addr: proxy.addr,
        auth: { user: "u", password: "p" },
      });
      expect(proxy.requests[0]).toBe(
        "CONNECT 203.0.113.9:22 HTTP/1.1\r\n" +
        "Host: 203.0.113.9:22\r\n" +
        "Proxy-Authorization: Basic dTpw\r\n" +
        "\r\n",
      );
      expect((await readOnce(socket)).toString()).toBe("SSH-2.0-fake\r\n");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("reports the proxy status line on failure", async () => {
    const proxy = await startHttpProxy(
      "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
    );
    try {
      await expect(connectUnderlying("203.0.113.9:22", {
        name: "p", type: "HTTP", addr: proxy.addr,
      })).rejects.toThrow(
        "proxy CONNECT failed: HTTP/1.1 407 Proxy Authentication Required",
      );
    } finally {
      await proxy.close();
    }
  });
});

describe("SOCKS5 proxy", () => {
  it("connects without auth and forwards bytes", async () => {
    const proxy = await startSocks5();
    try {
      const socket = await connectUnderlying("203.0.113.9:22", {
        name: "p", type: "SOCKS5", addr: proxy.addr,
      });
      socket.write(Buffer.from("ping"));
      expect((await readOnce(socket)).toString()).toBe("ping");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("authenticates with username/password", async () => {
    const proxy = await startSocks5({ user: "u", password: "p" });
    try {
      const socket = await connectUnderlying("203.0.113.9:22", {
        name: "p", type: "SOCKS5", addr: proxy.addr,
        auth: { user: "u", password: "p" },
      });
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("rejects wrong credentials", async () => {
    const proxy = await startSocks5({ user: "u", password: "p" });
    try {
      await expect(connectUnderlying("203.0.113.9:22", {
        name: "p", type: "SOCKS5", addr: proxy.addr,
        auth: { user: "u", password: "wrong" },
      })).rejects.toThrow("socks5: authentication failed");
    } finally {
      await proxy.close();
    }
  });

  it("rejects an unknown proxy type", async () => {
    await expect(connectUnderlying("203.0.113.9:22", {
      name: "p", type: "FTP" as "HTTP", addr: "127.0.0.1:1",
    })).rejects.toThrow('unknown proxy type "FTP"');
  });
});
