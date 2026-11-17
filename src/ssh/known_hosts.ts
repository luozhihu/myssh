import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type HostKeyStatus = "new" | "match";

interface Entry {
  addr: string;
  keyB64: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * TOFU known_hosts：每行 `host:port base64-pubkey`，权限 0600，原子写。
 * 所有方法同步执行，便于 ssh2 的同步 hostVerifier 直接返回精确错误。
 */
export class KnownHostsStore {
  constructor(readonly path: string) {}

  /** 首次记录返回 "new"；匹配返回 "match"；变更抛出 MITM 错误。 */
  check(addr: string, key: Buffer): HostKeyStatus {
    const entries = this.load();
    const marshaled = key.toString("base64");
    for (const entry of entries) {
      if (entry.addr !== addr) continue;
      if (entry.keyB64 === marshaled) return "match";
      throw new Error(
        `host key changed for ${addr}: possible MITM attack; if this is intentional, remove the entry manually from ${this.path}`,
      );
    }
    entries.push({ addr, keyB64: marshaled });
    try {
      this.save(entries);
    } catch (err) {
      throw new Error(`record host key: ${message(err)}`);
    }
    return "new";
  }

  private load(): Entry[] {
    let info;
    try {
      info = statSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`stat known_hosts: ${message(err)}`);
    }
    // Windows 用 NTFS ACL，Unix rwx 位无意义，跳过检查。
    if (process.platform !== "win32") {
      const perm = info.mode & 0o777;
      if ((perm & 0o077) !== 0) {
        throw new Error(
          `known_hosts permissions too open: ${perm.toString(8)}, want 0600 (no group/other access)`,
        );
      }
    }
    let data: string;
    try {
      data = readFileSync(this.path, "utf8");
    } catch (err) {
      throw new Error(`read known_hosts: ${message(err)}`);
    }
    const entries: Entry[] = [];
    data.split("\n").forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) return;
      const parts = line.split(/\s+/);
      if (parts.length !== 2) {
        throw new Error(
          `known_hosts:${index + 1}: expected 'addr base64-key', got ${JSON.stringify(line)}`,
        );
      }
      entries.push({ addr: parts[0]!, keyB64: parts[1]! });
    });
    return entries;
  }

  private save(entries: Entry[]): void {
    const dir = path.dirname(this.path);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(`mkdir known_hosts dir: ${message(err)}`);
    }
    const body = entries.map((e) => `${e.addr} ${e.keyB64}\n`).join("");
    const tmp = path.join(
      dir,
      `.known_hosts.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
    );
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
    } catch (err) {
      throw new Error(`write temp: ${message(err)}`);
    }
    try {
      chmodSync(tmp, 0o600);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error(`chmod temp: ${message(err)}`);
    }
    try {
      renameSync(tmp, this.path);
    } catch {
      // Windows 的 rename 不能覆盖已存在文件。
      try {
        unlinkSync(this.path);
        renameSync(tmp, this.path);
      } catch (retryErr) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw new Error(`rename temp to known_hosts: ${message(retryErr)}`);
      }
    }
  }
}
