import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { openSftp, type SftpClient } from "../../src/sftp/client.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

async function setup(fake: FakeSshOptions = { allowSftp: true }) {
  const server = await FakeSshServer.start(fake);
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-m4-"));
  cleanupFns.push(
    () => server.close(),
    async () => rm(dir, { recursive: true, force: true }),
  );
  const client: Client = await new Dialer(
    new KnownHostsStore(path.join(dir, "known_hosts")),
  ).dial({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  cleanupFns.push(async () => { client.end(); });
  const sftp = await openSftp(client);
  if (!sftp) throw new Error("sftp unavailable");
  cleanupFns.push(async () => { sftp.close(); });
  return { server, dir, sftp: sftp as SftpClient };
}

async function localFile(dir: string, name: string, data: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
}

async function uploadFile(sftp: SftpClient, file: string, remote: string, timeoutMs = 0) {
  const { createReadStream } = await import("node:fs");
  return sftp.upload(createReadStream(file), remote, timeoutMs);
}

describe("SftpClient upload", () => {
  it("writes a file atomically and leaves no temp file behind", async () => {
    const { server, dir, sftp } = await setup();
    await sftp.mkdir("/upload");
    const file = await localFile(dir, "a.txt", "hello upload");
    const outcome = await uploadFile(sftp, file, "/upload/a.txt");

    expect(outcome.error).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.bytes).toBe(12);
    expect(await readFile(path.join(server.sftpRoot, "upload", "a.txt"), "utf8"))
      .toBe("hello upload");
    const leftovers = await import("node:fs/promises").then((fs) =>
      fs.readdir(path.join(server.sftpRoot, "upload")));
    expect(leftovers).toEqual(["a.txt"]);
  });

  it("overwrites an existing target", async () => {
    const { server, dir, sftp } = await setup();
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path.join(server.sftpRoot, "upload"), { recursive: true });
      await fs.writeFile(path.join(server.sftpRoot, "upload", "a.txt"), "old");
    });
    const file = await localFile(dir, "a.txt", "new");
    expect((await uploadFile(sftp, file, "/upload/a.txt")).error).toBeUndefined();
    expect(await readFile(path.join(server.sftpRoot, "upload", "a.txt"), "utf8")).toBe("new");
  });

  it("returns create-remote errors for a missing directory", async () => {
    const { dir, sftp } = await setup();
    const file = await localFile(dir, "a.txt", "x");
    const outcome = await uploadFile(sftp, file, "/nope/a.txt");
    expect(outcome.error?.message).toMatch(/^create remote .*\.sshmng-tmp-[0-9a-f]+: /);
    expect(outcome.bytes).toBe(0);
  });

  it("times out, reports partial bytes and removes the temp file", async () => {
    const { server, dir, sftp } = await setup({ allowSftp: true, sftpDelayMs: 200 });
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.join(server.sftpRoot, "upload"), { recursive: true }));
    const file = await localFile(dir, "big.bin", "x".repeat(200_000));
    const outcome = await uploadFile(sftp, file, "/upload/big.bin", 50);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toBeDefined();
    expect(await import("node:fs/promises").then((fs) =>
      fs.readdir(path.join(server.sftpRoot, "upload")))).toEqual([]);
  });

  it("reports missing-file stat errors with code 2", async () => {
    const { sftp } = await setup();
    await expect(sftp.stat("/missing")).rejects.toMatchObject({ code: 2 });
  });

  it("returns the unavailable error when the client is closed", async () => {
    const { sftp } = await setup();
    sftp.close();
    const { Readable } = await import("node:stream");
    const outcome = await sftp.upload(Readable.from([Buffer.from("x")]), "/x");
    expect(outcome.error?.message).toBe("sftp not available for this session");
  });
});

describe("SftpClient download", () => {
  it("downloads a remote file into a writable", async () => {
    const { server, sftp } = await setup();
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path.join(server.sftpRoot, "d"), { recursive: true });
      await fs.writeFile(path.join(server.sftpRoot, "d", "a.txt"), "downloaded");
    });
    const chunks: Buffer[] = [];
    const { Writable } = await import("node:stream");
    const dst = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    const outcome = await sftp.download("/d/a.txt", dst);
    expect(outcome).toEqual({ bytes: 10, timedOut: false });
    expect(Buffer.concat(chunks).toString()).toBe("downloaded");
  });

  it("reports open-remote errors", async () => {
    const { sftp } = await setup();
    const { Writable } = await import("node:stream");
    const outcome = await sftp.download("/missing", new Writable({
      write(_c, _e, cb) { cb(); },
    }));
    expect(outcome.bytes).toBe(0);
    expect(outcome.error?.message).toMatch(/^open remote \/missing: /);
  });

  it("downloads atomically to a local file and cleans the temp", async () => {
    const { server, dir, sftp } = await setup();
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(server.sftpRoot, "remote.txt"), "atomic"));
    const target = path.join(dir, "local.txt");
    const outcome = await sftp.downloadToFile("/remote.txt", target);
    expect(outcome).toEqual({ bytes: 6, timedOut: false });
    expect(await readFile(target, "utf8")).toBe("atomic");
    const names = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    expect(names.filter((name) => name.includes(".sshmng-tmp-"))).toEqual([]);
  });

  it("times out without leaving a half-written local file", async () => {
    const { server, dir, sftp } = await setup({ allowSftp: true, sftpDelayMs: 200 });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(server.sftpRoot, "big.bin"), "x".repeat(100_000)));
    const target = path.join(dir, "big.bin");
    const outcome = await sftp.downloadToFile("/big.bin", target, 50);
    expect(outcome.timedOut).toBe(true);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
