import type { Readable, Writable } from "node:stream";

export const DEFAULT_TRANSFER_TIMEOUT_MS = 300_000;
export const DEFAULT_CONCURRENCY = 4;
export const SFTP_UNAVAILABLE = "sftp not available for this session";

export class SftpUnavailableError extends Error {
  constructor() {
    super(SFTP_UNAVAILABLE);
    this.name = "SftpUnavailableError";
  }
}

export interface TransferOutcome {
  bytes: number;
  timedOut: boolean;
  error?: Error;
}

/** Error thrown by the stream pump, carrying the bytes already written. */
export interface PumpError extends Error {
  bytes?: number;
}

export interface SftpStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export type ConflictPolicy = "overwrite" | "skip" | "rename";

export function parseConflictPolicy(value: string | undefined): ConflictPolicy {
  if (value === "skip") return "skip";
  if (value === "rename") return "rename";
  return "overwrite";
}

export interface DirTransferOptions {
  conflict?: ConflictPolicy;
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (bytes: number, files: number) => void;
}

export interface DirTransferResult {
  bytes: number;
  files: number;
  skipped: number;
  renamed: number;
  timedOut: number;
}

export interface DirTransferOutcome {
  result: DirTransferResult;
  error?: Error;
}

export function emptyDirResult(): DirTransferResult {
  return { bytes: 0, files: 0, skipped: 0, renamed: 0, timedOut: 0 };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SFTP status code 2 is SSH_FX_NO_SUCH_FILE. */
export function isNoSuchFile(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 2;
}

/** Structural interface shared by SftpClient and test doubles. */
export interface SftpTransfer {
  readonly available: boolean;
  stat(remotePath: string): Promise<SftpStat>;
  lstat(remotePath: string): Promise<SftpStat>;
  readdir(remotePath: string): Promise<Array<{ name: string; stat: SftpStat }>>;
  mkdir(remotePath: string): Promise<void>;
  upload(src: Readable, remotePath: string, timeoutMs?: number): Promise<TransferOutcome>;
  download(
    remotePath: string,
    dst: Writable,
    timeoutMs?: number,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome>;
  downloadToFile(
    remotePath: string,
    localPath: string,
    timeoutMs?: number,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome>;
  close(): void;
}

/** Go's errors.Join: newline-separated messages in one Error. */
export function joinErrors(errors: Error[]): Error | undefined {
  if (errors.length === 0) return undefined;
  return new Error(errors.map(errorMessage).join("\n"));
}
