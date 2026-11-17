import { describe, expect, it } from "vitest";
import {
  ProgressBar,
  humanizeBytes,
  renderBarLine,
} from "../../src/cli/progress.js";

describe("humanizeBytes", () => {
  it("matches Go's formatting", () => {
    expect(humanizeBytes(0)).toBe("0 B");
    expect(humanizeBytes(1023)).toBe("1023 B");
    expect(humanizeBytes(1024)).toBe("1.0 KB");
    expect(humanizeBytes(1536)).toBe("1.5 KB");
    expect(humanizeBytes(1024 * 1024)).toBe("1.0 MB");
    expect(humanizeBytes(5 * 1024 ** 4)).toBe("5.0 TB");
  });
});

describe("renderBarLine", () => {
  it("renders gauge, percent, progress and status", () => {
    const line = renderBarLine({
      label: "srv:/tmp/f",
      total: 1000,
      current: 500,
      filesTotal: 0,
      filesDone: 0,
      status: "1✓ 0✗ 1⏳",
      width: 120,
      elapsedMs: 1000,
    });
    expect(line).toContain("[");
    expect(line).toContain("50%");
    expect(line).toContain("500 B/1000 B");
    expect(line).toContain("1✓ 0✗ 1⏳");
  });

  it("drops optional fields on narrow terminals", () => {
    const line = renderBarLine({
      label: "very-long-server-name:/a/long/path/file.bin",
      total: 1000,
      current: 500,
      filesTotal: 0,
      filesDone: 0,
      status: "1✓ 0✗ 0⏳",
      width: 20,
      elapsedMs: 1000,
    });
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line).toContain("500 B");
  });

  it("renders indeterminate size without gauge", () => {
    const line = renderBarLine({
      label: "srv:/x", total: -1, current: 2048,
      filesTotal: 0, filesDone: 0, status: "", width: 80, elapsedMs: 1000,
    });
    expect(line).toContain("2.0 KB");
    expect(line).not.toContain("%");
  });
});

describe("ProgressBar", () => {
  it("is silent when the writer is not a TTY and clears the line when it is", () => {
    let text = "";
    const quiet = new ProgressBar((chunk) => { text += chunk; }, "x", 10, { tty: false });
    quiet.setBytes(5);
    quiet.finish();
    expect(text).toBe("");

    const bar = new ProgressBar((chunk) => { text += chunk; }, "x", 10, {
      tty: true,
      width: 80,
      now: () => 0,
    });
    bar.setBytes(10);
    expect(text).toContain("10 B/10 B");
    bar.finish();
    expect(text.endsWith("\r\x1b[J")).toBe(true);
  });
});
