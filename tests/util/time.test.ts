import { describe, expect, it } from "vitest";
import { goDuration, goTimestamp, traceTimestamp } from "../../src/util/time.js";

describe("goDuration", () => {
  it("formats durations like Go", () => {
    expect(goDuration(0)).toBe("0s");
    expect(goDuration(400)).toBe("400ms");
    expect(goDuration(2000)).toBe("2s");
    expect(goDuration(30000)).toBe("30s");
    expect(goDuration(300000)).toBe("5m0s");
  });
});

describe("traceTimestamp", () => {
  it("formats local time with millisecond precision", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(traceTimestamp(d)).toBe("2026-01-02 03:04:05.006");
  });
});

describe("goTimestamp", () => {
  it("uses RFC3339 with the local offset and trims trailing zeroes", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 60);
    expect(goTimestamp(d)).toMatch(
      /^2026-01-02T03:04:05\.06(?:[+-]\d{2}:\d{2}|Z)$/,
    );
  });
});
