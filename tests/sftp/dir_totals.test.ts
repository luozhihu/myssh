import { describe, expect, it } from "vitest";
import { remoteDirTotals } from "../../src/sftp/dir.js";
import type { SftpStat, SftpTransfer } from "../../src/sftp/types.js";

function st(size: number, kind: "file" | "dir" | "link"): SftpStat {
  return {
    size,
    isDirectory: kind === "dir",
    isFile: kind === "file",
    isSymbolicLink: kind === "link",
  };
}

class TreeSftp implements SftpTransfer {
  readonly available = true;
  constructor(private readonly tree: Record<string, Array<[string, SftpStat]>>) {}
  close(): void {}
  async lstat(remotePath: string): Promise<SftpStat> {
    if (this.tree[remotePath]) return st(0, "dir");
    throw new Error("missing");
  }
  async readdir(remotePath: string): Promise<Array<{ name: string; stat: SftpStat }>> {
    return (this.tree[remotePath] ?? []).map(([name, stat]) => ({ name, stat }));
  }
  async stat(): Promise<SftpStat> { throw new Error("unused"); }
  async mkdir(): Promise<void> {}
  async upload(): Promise<{ bytes: number; timedOut: boolean }> {
    return { bytes: 0, timedOut: false };
  }
  async download(): Promise<{ bytes: number; timedOut: boolean }> {
    return { bytes: 0, timedOut: false };
  }
  async downloadToFile(): Promise<{ bytes: number; timedOut: boolean }> {
    return { bytes: 0, timedOut: false };
  }
}

describe("remoteDirTotals", () => {
  it("sums regular files, skips symlinks and recurses", async () => {
    const sftp = new TreeSftp({
      "/root": [
        ["a.txt", st(10, "file")],
        ["link", st(999, "link")],
        ["sub", st(0, "dir")],
      ],
      "/root/sub": [["b.txt", st(5, "file")]],
    });
    await expect(remoteDirTotals(sftp, "/root")).resolves.toEqual({ bytes: 15, files: 2 });
  });

  it("tolerates unreadable entries", async () => {
    await expect(remoteDirTotals(new TreeSftp({}), "/missing"))
      .resolves.toEqual({ bytes: 0, files: 0 });
  });
});
