import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      out: (text: string) => { out += text; },
      err: (text: string) => { err += text; },
      env: {},
      platform: "darwin" as const,
      stderrIsTTY: false,
      readLine: async () => null,
    },
    get out() { return out; },
    get err() { return err; },
  };
}

async function single(fake: FakeSshServer) {
  const temp = await tempDir();
  cleanups.push(temp.cleanup, () => fake.close());
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [{
      name: "srv", addr: fake.addr, user: "test", auth: { password: "secret" },
    }],
  });
  return { dir: temp.dir, file };
}

describe("myssh file", () => {
  it("prints usage and rejects unknown subcommands", async () => {
    const none = capture();
    expect(await main(["file"], none.io)).toBe(2);
    expect(none.out).toContain("Usage:\n  sshmng file upload");

    const bad = capture();
    expect(await main(["file", "copy"], bad.io)).toBe(2);
    expect(bad.out).toContain('Unknown file subcommand "copy".');
  });

  it("uploads a local file with scp-style directory destination", async () => {
    const fake = await FakeSshServer.start({ allowSftp: true });
    const { dir, file } = await single(fake);
    const local = path.join(dir, "up.txt");
    await writeFile(local, "hello-upload");
    await mkdir(path.join(fake.sftpRoot, "dest"));

    const c = capture();
    expect(await main(["file", "upload", "srv", local, "/dest/", "--config", file], c.io)).toBe(0);
    expect(c.out).toBe(`uploaded ${local} -> srv:/dest/up.txt (12 bytes)\n`);
    expect(await readFile(path.join(fake.sftpRoot, "dest", "up.txt"), "utf8")).toBe("hello-upload");
  });

  it("downloads to an existing directory by appending the basename", async () => {
    const fake = await FakeSshServer.start({ allowSftp: true });
    const { dir, file } = await single(fake);
    await mkdir(path.join(fake.sftpRoot, "remote"));
    await writeFile(path.join(fake.sftpRoot, "remote", "down.txt"), "payload");
    const target = path.join(dir, "out");
    await mkdir(target);

    const c = capture();
    expect(await main(["file", "download", "srv", "/remote/down.txt", target, "--config", file], c.io))
      .toBe(0);
    expect(c.out).toBe(`downloaded srv:/remote/down.txt -> ${path.join(target, "down.txt")} (7 bytes)\n`);
    expect(await readFile(path.join(target, "down.txt"), "utf8")).toBe("payload");
  });

  it("reports missing local files without dialing past sftp setup", async () => {
    const fake = await FakeSshServer.start({ allowSftp: true });
    const { dir, file } = await single(fake);
    const local = path.join(dir, "nope.txt");
    const c = capture();
    expect(await main(["file", "upload", "srv", local, "/x", "--config", file], c.io)).toBe(1);
    expect(c.out.startsWith(`Error: open ${local}: `)).toBe(true);
  });

  it("uploads and downloads directories with a summary", async () => {
    const fake = await FakeSshServer.start({ allowSftp: true });
    const { dir, file } = await single(fake);
    const src = path.join(dir, "tree");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "a.txt"), "aaaa");
    await writeFile(path.join(src, "sub", "b.txt"), "bb");

    const up = capture();
    expect(await main(["file", "upload-dir", "srv", src, "/remote-tree", "--config", file], up.io))
      .toBe(0);
    expect(up.out).toBe(`uploaded ${src} -> srv:/remote-tree (2 files, 6 bytes)\n`);
    expect(await readFile(path.join(fake.sftpRoot, "remote-tree", "sub", "b.txt"), "utf8"))
      .toBe("bb");

    const outDir = path.join(dir, "downloaded");
    const down = capture();
    expect(await main(["file", "download-dir", "srv", "/remote-tree", outDir, "--config", file], down.io))
      .toBe(0);
    expect(down.out).toBe(`downloaded ${outDir} -> srv:/remote-tree (2 files, 6 bytes)\n`);
    expect(await readFile(path.join(outDir, "sub", "b.txt"), "utf8")).toBe("bb");
  });

  it("relays one file to several destinations", async () => {
    const src = await FakeSshServer.start({ allowSftp: true });
    const d1 = await FakeSshServer.start({ allowSftp: true });
    const d2 = await FakeSshServer.start({ allowSftp: true });
    cleanups.push(() => src.close(), () => d1.close(), () => d2.close());
    const temp = await tempDir();
    cleanups.push(temp.cleanup);
    const file = await writeConfig(temp.dir, {
      version: "1",
      idle_timeout_s: 300,
      jumphosts: [],
      proxies: [],
      servers: [
        { name: "src", addr: src.addr, user: "test", auth: { password: "secret" } },
        { name: "dst1", addr: d1.addr, user: "test", auth: { password: "secret" } },
        { name: "dst2", addr: d2.addr, user: "test", auth: { password: "secret" } },
      ],
    });
    await writeFile(path.join(src.sftpRoot, "r.bin"), "relay!");

    const c = capture();
    expect(await main([
      "file", "relay", "src", "/r.bin", "/landed.bin",
      "--to", "dst1,dst2", "--config", file,
    ], c.io)).toBe(0);
    expect(c.out).toContain("dst1: ok (6 bytes)\n");
    expect(c.out).toContain("dst2: ok (6 bytes)\n");
    expect(c.out).toContain("relay src -> 2 destinations: 2 ok, 0 failed\n");
    expect(await readFile(path.join(d2.sftpRoot, "landed.bin"), "utf8")).toBe("relay!");
  });

  it("requires --to and validates positional args", async () => {
    const noTo = capture();
    expect(await main(["file", "relay", "a", "/x", "/y"], noTo.io)).toBe(2);
    expect(noTo.out).toContain("Error: --to is required (one or more destination server names)\n");

    const few = capture();
    expect(await main(["file", "upload", "srv"], few.io)).toBe(2);
    expect(few.out).toContain("Error: expected 3 positional args (name local remote), got 1\n");
  });

  it("explains Pattern B (bastion) sftp unavailability", async () => {
    const jump = await FakeSshServer.start({ bastion: true });
    cleanups.push(() => jump.close());
    const temp = await tempDir();
    cleanups.push(temp.cleanup);
    const file = await writeConfig(temp.dir, {
      version: "1",
      idle_timeout_s: 300,
      proxies: [],
      jumphosts: [{
        name: "bastion", addr: jump.addr, user: "test", auth: { password: "secret" },
        ssh_j: false,
        login_flow: {
          pick: {
            send: "1\r",
            expects: [
              { pattern: "login:", next: "user" },
              { pattern: "Password:", next: "pass" },
            ],
          },
          user: { send: "prod-db\r", expects: [{ pattern: "Password:", next: "pass" }] },
          pass: { send: "wonderland\r", expects: [{ pattern: "prod-db", next: "success" }] },
        },
        login_entry: "pick",
      }],
      servers: [{
        name: "via-bastion", addr: "10.0.0.1:22", user: "deploy", auth: null,
        via: "bastion",
      }],
    });
    const c = capture();
    expect(await main(["file", "upload", "via-bastion", "/etc/hosts", "/x", "--config", file], c.io))
      .toBe(1);
    expect(c.out).toBe(
      "Error: server via-bastion uses bastion mode (ssh_j=false); sftp lands on the jumphost, not the target — use a direct or ssh_j=true connection\n",
    );
  });
});
