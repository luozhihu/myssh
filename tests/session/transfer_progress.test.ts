import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import { Session } from "../../src/session/session.js";
import type {
  SftpStat,
  SftpTransfer,
  TransferOutcome,
} from "../../src/sftp/types.js";

class FakeSftp implements SftpTransfer {
  readonly available = true;
  stats: SftpStat[] = [];
  close(): void {}
  stat(): Promise<SftpStat> { throw new Error("unused"); }
  lstat(): Promise<SftpStat> { throw new Error("unused"); }
  readdir(): Promise<Array<{ name: string; stat: SftpStat }>> { return Promise.resolve([]); }
  mkdir(): Promise<void> { return Promise.resolve(); }
  upload(_s: Readable, _r: string, _t = 0, onBytes?: (n: number) => void): Promise<TransferOutcome> {
    onBytes?.(3);
    return Promise.resolve({ bytes: 3, timedOut: false });
  }
  download(): Promise<TransferOutcome> {
    return Promise.resolve({ bytes: 2, timedOut: false });
  }
  downloadToFile(_r: string, _l: string, _t = 0, onBytes?: (n: number) => void): Promise<TransferOutcome> {
    onBytes?.(2);
    return Promise.resolve({ bytes: 2, timedOut: false });
  }
}

describe("session transfer callbacks", () => {
  it("forwards upload bytes and exposes downloadToFile", async () => {
    const sftp = new FakeSftp();
    const conn = {
      mode: "shell" as const,
      run: async () => { throw new Error("unused"); },
      sendRaw: async () => {},
      readRaw: async () => ({ output: "", more: false, idleMs: 0 }),
      close() {},
    };
    const session = new Session("ab12", "srv", conn, { sftp, sftpAvailable: true });
    const seen: number[] = [];
    const up = await session.upload(
      new PassThrough() as unknown as Readable,
      "/x",
      0,
      (n) => seen.push(n),
    );
    expect(up.bytes).toBe(3);
    expect(seen).toEqual([3]);

    const downSeen: number[] = [];
    const down = await session.downloadToFile("/x", "/tmp/x", 0, (n) => downSeen.push(n));
    expect(down.bytes).toBe(2);
    expect(downSeen).toEqual([2]);
    session.close();
  });
});
