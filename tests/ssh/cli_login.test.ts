import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Jumphost, SSHServer } from "../../src/config/types.js";
import { setupCliJumphost, setupCliServer } from "../../src/ssh/login.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

async function context(fake: FakeSshServer) {
  const { dir, cleanup } = await tempDir();
  cleanups.push(cleanup);
  return {
    knownHosts: new KnownHostsStore(path.join(dir, "known_hosts")),
    dir,
  };
}

function serverFor(fake: FakeSshServer, extra: Partial<SSHServer> = {}): SSHServer {
  return {
    name: "srv",
    addr: fake.addr,
    user: "test",
    auth: { password: "secret" },
    ...extra,
  };
}

describe("CLI login behavior", () => {
  it("skips shell setup for interactive connections", async () => {
    const fake = await FakeSshServer.start({ allowSftp: true });
    cleanups.push(() => fake.close());
    const ctx = await context(fake);
    const result = await setupCliServer({
      ...ctx,
      sid: "ab12",
      server: serverFor(fake),
      needShell: false,
      needSftp: false,
    });
    expect(result.conn.shell).toBe("");
    expect(result.sftpAvailable).toBe(false);
    expect(result.sftp).toBeNull();
    result.conn.close();
  });

  it("detects the shell only when needShell is set", async () => {
    const fake = await FakeSshServer.start({});
    cleanups.push(() => fake.close());
    const ctx = await context(fake);
    const result = await setupCliServer({
      ...ctx,
      sid: "ab12",
      server: serverFor(fake),
      needShell: true,
      needSftp: false,
    });
    expect(result.conn.shell).toBe("bash");
    result.conn.close();
  });

  it("opens sftp for file transfer when requested", async () => {
    const fake = await FakeSshServer.start({ allowSftp: true });
    cleanups.push(() => fake.close());
    const ctx = await context(fake);
    const result = await setupCliServer({
      ...ctx,
      sid: "ab12",
      server: serverFor(fake),
      needShell: false,
      needSftp: true,
    });
    expect(result.conn.shell).toBe("");
    expect(result.sftpAvailable).toBe(true);
    expect(result.sftp).not.toBeNull();
    result.conn.close();
  });

  it("reports sftp unavailable instead of failing the login", async () => {
    const fake = await FakeSshServer.start({ allowSftp: false });
    cleanups.push(() => fake.close());
    const ctx = await context(fake);
    const result = await setupCliServer({
      ...ctx,
      sid: "ab12",
      server: serverFor(fake),
      needShell: false,
      needSftp: true,
    });
    expect(result.sftpAvailable).toBe(false);
    expect(result.sftp).toBeNull();
    result.conn.close();
  });

  it("logs into a jumphost directly with optional shell setup", async () => {
    const fake = await FakeSshServer.start({});
    cleanups.push(() => fake.close());
    const ctx = await context(fake);
    const jump: Jumphost = {
      name: "bastion",
      addr: fake.addr,
      user: "test",
      auth: { password: "secret" },
      ssh_j: true,
    };
    const result = await setupCliJumphost({
      ...ctx,
      sid: "cd34",
      jump,
      needShell: true,
    });
    expect(result.conn.shell).toBe("bash");
    expect(result.sftpAvailable).toBe(false);
    result.conn.close();
  });
});
