import path from "node:path";

function baseName(src: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.basename(src) : path.posix.basename(src);
}

function separator(dst: string, platform: NodeJS.Platform): string {
  return dst.includes("\\")
    ? (platform === "win32" ? "\\" : "/")
    : "/";
}

/** scp/cp-style destination resolution (port of resolveDstPath). */
export function resolveDstPath(
  src: string,
  dst: string,
  isDir: boolean,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isDir) return dst;
  if (dst === ".") return baseName(src, platform);
  const trimmed = dst.replace(/[\\/]+$/, "");
  if (trimmed === "") return `/${baseName(src, platform)}`;
  return `${trimmed}${separator(trimmed, platform)}${baseName(src, platform)}`;
}
