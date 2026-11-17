import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir } from "../helpers/config.js";

const KEY_A = Buffer.from("ssh-ed25519-aaaa");
const KEY_B = Buffer.from("ssh-ed25519-bbbb");

async function withStore(
  fn: (file: string, store: KnownHostsStore) => void | Promise<void>,
): Promise<void> {
  const { dir, cleanup } = await tempDir();
  try {
    const file = path.join(dir, "known_hosts");
    await fn(file, new KnownHostsStore(file));
  } finally {
    await cleanup();
  }
}

describe("KnownHostsStore", () => {
  it("records a new host key and matches it later", async () => {
    await withStore(async (file, store) => {
      expect(store.check("1.2.3.4:22", KEY_A)).toBe("new");
      expect(readFileSync(file, "utf8")).toBe(
        `1.2.3.4:22 ${KEY_A.toString("base64")}\n`,
      );
      expect(store.check("1.2.3.4:22", KEY_A)).toBe("match");
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("rejects a changed host key with the MITM warning", async () => {
    await withStore(async (file, store) => {
      store.check("1.2.3.4:22", KEY_A);
      expect(() => store.check("1.2.3.4:22", KEY_B)).toThrow(
        `host key changed for 1.2.3.4:22: possible MITM attack; if this is intentional, remove the entry manually from ${file}`,
      );
      expect(readFileSync(file, "utf8")).toContain(KEY_A.toString("base64"));
    });
  });

  it("skips comments and blank lines and rejects malformed lines", async () => {
    await withStore(async (file, store) => {
      writeFileSync(file, `# comment\n\n1.2.3.4:22 ${KEY_A.toString("base64")}\n`, {
        mode: 0o600,
      });
      expect(store.check("1.2.3.4:22", KEY_A)).toBe("match");
      writeFileSync(file, "bad line with spaces\n", { mode: 0o600 });
      expect(() => store.check("1.2.3.4:22", KEY_A)).toThrow(
        'known_hosts:1: expected \'addr base64-key\', got "bad line with spaces"',
      );
    });
  });

  it("rejects a group/other-readable known_hosts file", async () => {
    if (process.platform === "win32") return;
    await withStore(async (file, store) => {
      writeFileSync(file, `1.2.3.4:22 ${KEY_A.toString("base64")}\n`);
      chmodSync(file, 0o644);
      expect(() => store.check("1.2.3.4:22", KEY_A)).toThrow(
        "known_hosts permissions too open: 644, want 0600 (no group/other access)",
      );
    });
  });

  it("creates missing parent directories and appends new hosts", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = path.join(dir, "nested", "deeper", "known_hosts");
      const store = new KnownHostsStore(file);
      store.check("a:22", KEY_A);
      store.check("b:22", KEY_B);
      expect(readFileSync(file, "utf8")).toBe(
        `a:22 ${KEY_A.toString("base64")}\nb:22 ${KEY_B.toString("base64")}\n`,
      );
      expect(mkdirSync).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});
