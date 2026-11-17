import { describe, expect, it } from "vitest";
import { cleanOutput, stripANSI } from "../../src/pty/normalize.js";

describe("stripANSI", () => {
  it("strips CSI and OSC sequences", () => {
    expect(stripANSI("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripANSI("a\x1b]0;window title\x07b")).toBe("ab");
    expect(stripANSI("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
});

describe("cleanOutput", () => {
  it("removes tokenized and initial sentinels", () => {
    expect(cleanOutput("hello\r\n_0__abc_token__]# \r\n", "abc")).toBe("hello");
    expect(cleanOutput("out\r\n_1__abc___]# \r\n", "abc")).toBe("out");
  });

  it("removes PS1-only and ANSI and normalizes line endings", () => {
    expect(cleanOutput("__P_abc__> x", "abc")).toBe("x");
    expect(cleanOutput("\x1b[32mok\x1b[0m\r\nnext\rline\n\n", "abc")).toBe("ok\nnextline");
  });

  it("keeps sentinel literals for other sessions", () => {
    expect(cleanOutput("_0__other_token__]# ", "abc")).toBe("_0__other_token__]# ");
  });
});
