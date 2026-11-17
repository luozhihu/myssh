import { Readable, Writable } from "node:stream";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { setupDirect } from "../../src/ssh/login.js";
import { Session, type SessionConn } from "../../src/session/session.js";
import type { SSHServer } from "../../src/config/types.js";
import type { SftpTransfer, SftpStat, TransferOutcome } from "../../src/sftp/types.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";
import { tempDir } from "../helpers/config.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function fakeConn(): SessionConn {
  return {
    mode: "shell",
    async run() {
      return {
        output: "", exitCode: 0, timedOut: false, truncated: false,
        totalBytes: 0, rawOutput: "", ctrlCSent: false, connUnusable: false,
      };
    },
    async sendRaw() {},
    async readRaw() { return { output: "", more: false, idleMs: 0 }; },
    close() {},
  };
}

function fakeSftp(overrides: Partial<SftpTransfer> = {}): SftpTransfer {
  return {
    available: true,
    async stat(): Promise<SftpStat> {
      return { size: 0, isDirectory: false, isFile: true, isSymbolicLink: false };
    },
    async lstat(): Promise<SftpStat> {
      return { size: 0, isDirectory: false, isFile: true, isSymbolicLink: false };
    },
    async readdir() { return []; },
    async mkdir() {},
    async upload(): Promise<TransferOutcome> { return { bytes: 0, timedOut: false }; },
    async download(): Promise<TransferOutcome> { return { bytes: 0, timedOut: false }; },
    async downloadToFile(): Promise<TransferOutcome> { return { bytes: 0, timedOut: false }; },
    close() {},
    ...overrides,
  };
}

describe("Session sftp state machine", () => {
  it("marks the session running during a transfer and idle afterwards", async () => {
    let release!: (value: TransferOutcome) => void;
    const pending = new Promise<TransferOutcome>((resolve) => { release = resolve; });
    const sftp = fakeSftp({ upload: () => pending });
    const session = new Session("s1", "srv", fakeConn(), { sftp });

    const running = session.upload(Readable.from([Buffer.from("x")]), "/x");
    expect(session.state).toBe("running");
    release({ bytes: 1, timedOut: false });
    await expect(running).resolves.toEqual({ bytes: 1, timedOut: false });
    expect(session.state).toBe("idle");
  });

  it("rejects transfers while busy or closed", async () => {
    let releaseRun!: () => void;
    const conn = fakeConn();
    conn.run = () => new Promise((resolve) => {
      releaseRun = () => resolve({
        output: "", exitCode: 0, timedOut: false, truncated: false,
        totalBytes: 0, rawOutput: "", ctrlCSent: false, connUnusable: false,
      });
    });
    const session = new Session("s1", "srv", conn, { sftp: fakeSftp() });
    const run = session.run("sleep", 0, 0);
    await expect(session.upload(Readable.from([Buffer.from("x")]), "/x"))
      .rejects.toThrow("session busy");
    releaseRun();
    await run;
    session.close();
    await expect(session.upload(Readable.from([Buffer.from("x")]), "/x"))
      .rejects.toThrow("session closed");
  });

  it("returns the unavailable error without throwing for sftp operations", async () => {
    const session = new Session("s1", "srv", fakeConn(), { sftp: null });
    const outcome = await session.upload(Readable.from([Buffer.from("x")]), "/x");
    expect(outcome.error?.message).toBe("sftp not available for this session");
    const dir = await session.uploadDir("/tmp/nope", "/x");
    expect(dir.error?.message).toBe("sftp not available for this session");
  });

  it("closes the sftp client with the session", () => {
    let closed = false;
    const session = new Session("s1", "srv", fakeConn(), {
      sftp: fakeSftp({ close: () => { closed = true; } }),
    });
    session.close();
    expect(closed).toBe(true);
  });
});

describe("setupDirect sftp", () => {
  async function setupClient() {
    const server = await FakeSshServer.start({ allowSftp: true });
    const temp = await tempDir();
    cleanupFns.push(() => server.close(), temp.cleanup);
    return { server, dir: temp.dir };
  }

  it("returns a persistent sftp client and keeps it usable", async () => {
    const { server, dir } = await setupClient();
    const setup = await setupDirect({
      server: {
        name: "local", addr: server.addr, user: "test", auth: { password: "secret" },
      } as SSHServer,
      sid: "ab12",
      knownHosts: new KnownHostsStore(path.join(dir, "known_hosts")),
    });
    cleanupFns.push(async () => { setup.conn.close(); setup.sftp?.close(); });
    expect(setup.sftpAvailable).toBe(true);
    expect(setup.sftp).not.toBeNull();
    await writeFile(path.join(server.sftpRoot, "a.txt"), "via-sftp");
    const chunks: Buffer[] = [];
    const outcome = await setup.sftp!.download("/a.txt", new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }));
    expect(outcome.bytes).toBe(8);
    expect(Buffer.concat(chunks).toString()).toBe("via-sftp");
  });
});
