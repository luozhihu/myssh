import { describe, expect, it } from "vitest";
import { compareCase, normalizeOutput, simpleDiff } from "../../scripts/align_lib.mjs";

function cli(stdout = "", code: number | null = 0, stderr = "") {
  return { code, stdout, stderr };
}

describe("normalizeOutput", () => {
  it("rewrites brand tokens without touching paths or package specs", () => {
    const input = "Run 'myssh help'; edit ~/.sshmng/config.json; try myssh@latest";
    expect(normalizeOutput(input)).toBe(
      "Run 'sshmng help'; edit ~/.sshmng/config.json; try sshmng@latest",
    );
  });
});

describe("simpleDiff", () => {
  it("marks removed and added lines", () => {
    expect(simpleDiff("a\nb\n", "a\nc\n")).toBe("- b\n+ c");
  });

  it("reports appended lines", () => {
    expect(simpleDiff("a\n", "a\nb\n")).toBe("+ b");
  });
});

describe("compareCase", () => {
  it("passes identical results", () => {
    const result = compareCase("server list", cli("NAME\n"), cli("NAME\n"));
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("");
  });

  it("passes results that differ only by brand", () => {
    const result = compareCase("help", cli("sshmng help\n"), cli("myssh help\n"));
    expect(result.status).toBe("pass");
  });

  it("fails on stdout drift and shows a diff", () => {
    const result = compareCase("server get", cli("Name: a\n"), cli("Name: b\n"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("stdout:");
    expect(result.detail).toContain("- Name: a");
    expect(result.detail).toContain("+ Name: b");
  });

  it("fails on exit-code drift", () => {
    const result = compareCase("server get", cli("x\n", 0), cli("x\n", 1));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("exit: go=0 myssh=1");
  });

  it("fails on stderr drift", () => {
    const result = compareCase("server get", cli("x\n", 0, "e1\n"), cli("x\n", 0, "e2\n"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("stderr:");
    expect(result.detail).toContain("- e1");
    expect(result.detail).toContain("+ e2");
  });

  it("degrades a difference to allowed when a reason is listed", () => {
    const result = compareCase(
      "help",
      cli("sshmng help v1\n"),
      cli("myssh help v2\n"),
      { help: "help text is intentionally rewritten for npx" },
    );
    expect(result.status).toBe("allowed");
    expect(result.reason).toBe("help text is intentionally rewritten for npx");
    expect(result.detail).toContain("stdout:");
  });
});
