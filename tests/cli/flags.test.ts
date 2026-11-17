import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { FlagError, parseFlags } from "../../src/cli/flags.js";
import { envOf, homeOf, platformOf, readLineOf, stderrTTY } from "../../src/cli/io.js";

describe("parseFlags", () => {
  const spec = {
    strings: ["config"],
    numbers: ["timeout", "concurrency"],
    booleans: ["yes", "pin"],
    arrays: ["to", "agents"],
  };

  it("parses values in both forms and keeps positionals", () => {
    const p = parseFlags(
      ["--config", "/tmp/c.json", "--timeout=1500", "--yes", "srv", "a.txt", "/tmp/x"],
      spec,
    );
    expect(p.strings.get("config")).toBe("/tmp/c.json");
    expect(p.numbers.get("timeout")).toBe(1500);
    expect(p.booleans.has("yes")).toBe(true);
    expect(p.positionals).toEqual(["srv", "a.txt", "/tmp/x"]);
  });

  it("accumulates array flags and stops at --", () => {
    const p = parseFlags(["--to", "a,b", "--to", "c", "--", "--not-a-flag"], spec);
    expect(p.arrays.get("to")).toEqual(["a,b", "c"]);
    expect(p.positionals).toEqual(["--not-a-flag"]);
  });

  it("treats --help as a boolean", () => {
    const p = parseFlags(["--help"], spec);
    expect(p.booleans.has("help")).toBe(true);
  });

  it("rejects unknown flags, missing values, and bad numbers", () => {
    expect(() => parseFlags(["--nope"], spec)).toThrow(FlagError);
    expect(() => parseFlags(["--config"], spec)).toThrow("flag --config requires a value");
    expect(() => parseFlags(["--timeout", "abc"], spec)).toThrow(
      "invalid value for --timeout: abc",
    );
  });
});

describe("io helpers", () => {
  it("falls back to process values when fields are absent", () => {
    const io = { out() {}, err() {} };
    expect(homeOf(io)).toBe(homedir());
    expect(envOf(io)).toBe(process.env);
    expect(platformOf(io)).toBe(process.platform);
    expect(stderrTTY(io)).toBe(false);
  });

  it("uses injected fields and readLine", async () => {
    const io = {
      out() {},
      err() {},
      homeDir: "/h",
      platform: "win32" as const,
      env: { A: "1" },
      stderrIsTTY: true,
      readLine: async () => "yes",
    };
    expect(homeOf(io)).toBe("/h");
    expect(platformOf(io)).toBe("win32");
    expect(envOf(io)).toEqual({ A: "1" });
    expect(stderrTTY(io)).toBe(true);
    await expect(readLineOf(io)).resolves.toBe("yes");
  });
});
