export const VERSION = "0.1.0";
export const COMMIT = "dev";
export const BUILD_DATE = "unknown";

export function goOS(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "windows" : platform;
}

export function goArch(arch: string = process.arch): string {
  switch (arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    case "arm64":
      return "arm64";
    default:
      return arch;
  }
}
