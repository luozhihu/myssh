import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client, SFTPWrapper } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function writeAll(sftp: SFTPWrapper, remote: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // ssh2 WriteStream calls destroy() inside _final when autoClose=true,
    // which suppresses 'finish' on modern Node. Our uploader also opens with
    // autoClose=false and closes the handle explicitly.
    const ws = sftp.createWriteStream(remote, { autoClose: false });
    ws.on("error", reject);
    ws.on("finish", () => {
      ws.destroy();
      resolve();
    });
    ws.end(data);
  });
}

function readAll(sftp: SFTPWrapper, remote: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const rs = sftp.createReadStream(remote);
    rs.on("data", (chunk: Buffer) => chunks.push(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function setup() {
  const server = await FakeSshServer.start({ allowSftp: true });
  const temp = await tempDir();
  cleanupFns.push(() => server.close(), temp.cleanup);
  const client = await new Dialer(
    new KnownHostsStore(path.join(temp.dir, "known_hosts")),
  ).dial({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  cleanupFns.push(async () => { client.end(); });
  const sftp = await openSftp(client);
  cleanupFns.push(async () => sftp.end());
  return { server, sftp };
}

describe("fake SFTP server", () => {
  it("supports open/write/close/stat/read/readdir/rename/remove/mkdir", async () => {
    const { server, sftp } = await setup();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir("/data", (err) => (err ? reject(err) : resolve()));
    });
    await writeAll(sftp, "/data/a.txt", Buffer.from("hello sftp"));

    expect(readFileSync(path.join(server.sftpRoot, "data", "a.txt"), "utf8"))
      .toBe("hello sftp");

    const st = await new Promise<{ size: number; isFile(): boolean }>(
      (resolve, reject) => {
        sftp.stat("/data/a.txt", (err, stats) => (err ? reject(err) : resolve(stats)));
      },
    );
    expect(st.size).toBe(10);
    expect(st.isFile()).toBe(true);

    expect((await readAll(sftp, "/data/a.txt")).toString()).toBe("hello sftp");

    const names = await new Promise<string[]>((resolve, reject) => {
      sftp.readdir("/data", (err, list) => (
        err ? reject(err) : resolve(list.map((entry) => entry.filename))
      ));
    });
    expect(names).toContain("a.txt");

    await new Promise<void>((resolve, reject) => {
      sftp.rename("/data/a.txt", "/data/b.txt", (err) => (err ? reject(err) : resolve()));
    });
    expect((await readAll(sftp, "/data/b.txt")).toString()).toBe("hello sftp");

    await new Promise<void>((resolve, reject) => {
      sftp.unlink("/data/b.txt", (err) => (err ? reject(err) : resolve()));
    });
    await expect(readAll(sftp, "/data/b.txt")).rejects.toThrow();
  });

  it("maps missing paths to NO_SUCH_FILE and refuses to rename onto an existing file", async () => {
    const { sftp } = await setup();
    await writeAll(sftp, "/one", Buffer.from("1"));
    await writeAll(sftp, "/two", Buffer.from("2"));

    const statError = await new Promise<Error>((resolve) => {
      sftp.stat("/missing", (err) => resolve(err!));
    });
    expect((statError as Error & { code: number }).code).toBe(2);

    const renameError = await new Promise<Error>((resolve) => {
      sftp.rename("/one", "/two", (err) => resolve(err!));
    });
    expect(renameError).toBeInstanceOf(Error);
  });
});
