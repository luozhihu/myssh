import { describe, expect, it } from "vitest";
import { resolveDstPath } from "../../src/cli/file_path.js";

describe("resolveDstPath", () => {
  it("returns a file destination unchanged", () => {
    expect(resolveDstPath("/a/b.txt", "/tmp/x", false, "linux")).toBe("/tmp/x");
  });

  it("appends the basename for directory destinations", () => {
    expect(resolveDstPath("/a/b.txt", ".", true, "linux")).toBe("b.txt");
    expect(resolveDstPath("/a/b.txt", "/tmp/", true, "linux")).toBe("/tmp/b.txt");
    expect(resolveDstPath("/a/b.txt", "/", true, "linux")).toBe("/b.txt");
  });

  it("uses the destination's separator convention on Windows", () => {
    expect(resolveDstPath("/a/b.txt", "C:\\tmp\\", true, "win32"))
      .toBe("C:\\tmp\\b.txt");
    expect(resolveDstPath("/a/b.txt", "C:/tmp/", true, "win32"))
      .toBe("C:/tmp/b.txt");
  });
});
