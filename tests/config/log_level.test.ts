import { describe, expect, it } from "vitest";
import { parseLogLevel } from "../../src/config/log_level.js";

describe("parseLogLevel", () => {
  it("returns info for empty values", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("")).toBe("info");
    expect(parseLogLevel("  ")).toBe("info");
  });

  it("accepts documented abbreviations case-insensitively", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("DBG")).toBe("debug");
    expect(parseLogLevel("d")).toBe("debug");
    expect(parseLogLevel("inf")).toBe("info");
    expect(parseLogLevel("i")).toBe("info");
    expect(parseLogLevel("warning")).toBe("warn");
    expect(parseLogLevel("w")).toBe("warn");
    expect(parseLogLevel("err")).toBe("error");
    expect(parseLogLevel("e")).toBe("error");
  });

  it("rejects unknown values instead of falling back", () => {
    expect(() => parseLogLevel("trace")).toThrow(
      'unknown log level "trace" (supported: debug/dbg/d, info/inf/i, warn/warning/w, error/err/e)',
    );
  });
});
