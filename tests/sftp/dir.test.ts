import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { openSftp } from "../../src/sftp/client.js";
import { uploadDir, downloadDir } from "../../src/sftp/dir.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

async function setup(fake: FakeSshOptions = { allowSftp: true }) {
  const server = await FakeSshServer.start(fake);
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-dir-"));
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
  return { server, dir, sftp };
}

async function makeTree(root: string): Promise<void> {
  await mkdir(path.join(root, "sub", "deep"), { recursive: true });
  await writeFile(path.join(root, "a.txt"), "alpha");
  await writeFile(path.join(root, "sub", "b.txt"), "bravo");
  await writeFile(path.join(root, "sub", "deep", "c.txt"), "charlie");
  await symlink("a.txt", path.join(root, "link"));
}

async function remoteTree(root: string): Promise<void> {
  await mkdir(path.join(root, "sub", "deep"), { recursive: true });
  await writeFile(path.join(root, "a.txt"), "alpha");
  await writeFile(path.join(root, "sub", "b.txt"), "bravo");
  await writeFile(path.join(root, "sub", "deep", "c.txt"), "charlie");
  await symlink("a.txt", path.join(root, "link"));
}

describe("uploadDir", () => {
  it("uploads a nested tree, creates dirs, skips symlinks", async () => {
    const { server, dir, sftp } = await setup();
    const local = path.join(dir, "tree");
    await makeTree(local);
    const outcome = await uploadDir(sftp, local, "/remote/tree");

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      bytes: 5 + 5 + 7,
      files: 3,
      skipped: 0,
      renamed: 0,
      timedOut: 0,
    });
    expect(await readFile(path.join(server.sftpRoot, "remote/tree/a.txt"), "utf8"))
      .toBe("alpha");
    expect(await readFile(
      path.join(server.sftpRoot, "remote/tree/sub/deep/c.txt"),
      "utf8",
    )).toBe("charlie");
    expect(await readdir(path.join(server.sftpRoot, "remote/tree"))).not.toContain("link");
  });

  it("overwrites by default", async () => {
    const { server, dir, sftp } = await setup();
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    const local = path.join(dir, "tree");
    await mkdir(local);
    await writeFile(path.join(local, "a.txt"), "new");
    const outcome = await uploadDir(sftp, local, "/r");
    expect(outcome.error).toBeUndefined();
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("new");
    expect(outcome.result.files).toBe(1);
  });

  it("skips existing files with conflict=skip", async () => {
    const { server, dir, sftp } = await setup();
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    const local = path.join(dir, "tree");
    await mkdir(local);
    await writeFile(path.join(local, "a.txt"), "new");
    const outcome = await uploadDir(sftp, local, "/r", { conflict: "skip" });
    expect(outcome.result).toEqual({
      bytes: 0,
      files: 0,
      skipped: 1,
      renamed: 0,
      timedOut: 0,
    });
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("old");
  });

  it("renames to name_1.ext with conflict=rename", async () => {
    const { server, dir, sftp } = await setup();
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    await writeFile(path.join(server.sftpRoot, "r/a_1.txt"), "older");
    const local = path.join(dir, "tree");
    await mkdir(local);
    await writeFile(path.join(local, "a.txt"), "new");
    const outcome = await uploadDir(sftp, local, "/r", { conflict: "rename" });
    expect(outcome.result.renamed).toBe(1);
    expect(outcome.result.files).toBe(1);
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("old");
    expect(await readFile(path.join(server.sftpRoot, "r/a_1.txt"), "utf8")).toBe("older");
    expect(await readFile(path.join(server.sftpRoot, "r/a_2.txt"), "utf8")).toBe("new");
  });

  it("counts per-file timeouts and returns an aggregated error", async () => {
    const { dir, sftp } = await setup({ allowSftp: true, sftpDelayMs: 200 });
    const local = path.join(dir, "tree");
    await makeTree(local);
    const outcome = await uploadDir(sftp, local, "/slow", { timeoutMs: 50 });
    expect(outcome.result.timedOut).toBe(3);
    expect(outcome.result.files).toBe(0);
    expect(outcome.error?.message).toContain("timed out");
  });

  it("rejects a local path that is not a directory", async () => {
    const { dir, sftp } = await setup();
    const file = path.join(dir, "file");
    await writeFile(file, "x");
    const outcome = await uploadDir(sftp, file, "/x");
    expect(outcome.error?.message).toBe("local path is not a directory");
  });
});

describe("downloadDir", () => {
  it("downloads a nested tree, creates dirs, skips symlinks", async () => {
    const { server, dir, sftp } = await setup();
    await remoteTree(path.join(server.sftpRoot, "remote"));
    const local = path.join(dir, "out");
    const outcome = await downloadDir(sftp, "/remote", local);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      bytes: 5 + 5 + 7,
      files: 3,
      skipped: 0,
      renamed: 0,
      timedOut: 0,
    });
    expect(await readFile(path.join(local, "sub", "deep", "c.txt"), "utf8"))
      .toBe("charlie");
    await expect(lstat(path.join(local, "link"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips existing local files with conflict=skip", async () => {
    const { server, dir, sftp } = await setup();
    await writeFile(path.join(server.sftpRoot, "a.txt"), "remote");
    const local = path.join(dir, "out");
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, "a.txt"), "local");
    const outcome = await downloadDir(sftp, "/a.txt", local);
    expect(outcome.result.skipped).toBe(0); // remote path is a file, not a dir

    const dirOutcome = await downloadDir(sftp, "/", local, { conflict: "skip" });
    expect(dirOutcome.result.skipped).toBe(1);
    expect(await readFile(path.join(local, "a.txt"), "utf8")).toBe("local");
  });

  it("renames locally with conflict=rename", async () => {
    const { server, dir, sftp } = await setup();
    await writeFile(path.join(server.sftpRoot, "a.txt"), "remote");
    const local = path.join(dir, "out");
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, "a.txt"), "local");
    const outcome = await downloadDir(sftp, "/", local, { conflict: "rename" });
    expect(outcome.result.renamed).toBeGreaterThanOrEqual(1);
    expect(await readFile(path.join(local, "a.txt"), "utf8")).toBe("local");
    expect(await readFile(path.join(local, "a_1.txt"), "utf8")).toBe("remote");
  });
});
