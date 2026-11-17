import { randomBytes } from "node:crypto";

/** 8 字节十六进制 session ID / sentinel token。 */
export function randomSID(): string {
  return randomBytes(8).toString("hex");
}
