import { randomBytes } from "node:crypto";

/** `<remotePath>.sshmng-tmp-<6 hex>` (3 bytes, same as sshmng). */
export function atomicRemotePath(remotePath: string): string {
  return `${remotePath}.sshmng-tmp-${randomBytes(3).toString("hex")}`;
}

/** Temp file name for atomic local writes: `<base>.sshmng-tmp-<6 hex>`. */
export function localTempPath(localPath: string): string {
  return `${localPath}.sshmng-tmp-${randomBytes(3).toString("hex")}`;
}
