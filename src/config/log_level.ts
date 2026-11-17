export type LogLevel = "debug" | "info" | "warn" | "error";

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? "").trim().toLowerCase();
  switch (v) {
    case "":
      return "info";
    case "debug":
    case "dbg":
    case "d":
      return "debug";
    case "info":
    case "inf":
    case "i":
      return "info";
    case "warn":
    case "warning":
    case "w":
      return "warn";
    case "error":
    case "err":
    case "e":
      return "error";
    default:
      throw new Error(
        `unknown log level ${JSON.stringify(value)} (supported: debug/dbg/d, info/inf/i, warn/warning/w, error/err/e)`,
      );
  }
}
