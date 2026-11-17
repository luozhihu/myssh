import { describe, expect, it } from "vitest";
import {
  detectShellReady,
  extractExitCode,
  truncateOutput,
} from "../../src/pty/sentinel.js";

describe("detectShellReady", () => {
  it("matches the initial PS1 sentinel at the end of the stream", () => {
    expect(detectShellReady("_0__abc___]# ", "abc")).toBe(true);
    expect(detectShellReady("noise _12__abc_ff__]# \r\n", "abc")).toBe(true);
    expect(detectShellReady("_0__abcd___]# ", "abc")).toBe(false);
  });
});

describe("extractExitCode", () => {
  it("returns the last matching exit code", () => {
    expect(extractExitCode("_3__abc_tok__]# then _7__abc_tok__]# ", "abc", "tok")).toBe(7);
    expect(extractExitCode("_0__abc_other__]# ", "abc", "tok")).toBe(-1);
  });
});

describe("truncateOutput", () => {
  it("truncates by bytes and reports the original size", () => {
    expect(truncateOutput("abcdef", 3)).toEqual({
      text: "abc",
      truncated: true,
      totalBytes: 6,
    });
    expect(truncateOutput("abc", 0)).toEqual({
      text: "abc",
      truncated: false,
      totalBytes: 3,
    });
    expect(truncateOutput("😀", 2)).toEqual({
      text: "�",
      truncated: true,
      totalBytes: 4,
    });
  });
});
