import type { IO } from "./io.js";
import { nowOf, stderrTTY } from "./io.js";

const DEFAULT_WIDTH = 80;
const GAUGE_WIDTH = 20;
const THROTTLE_MS = 100;
const ELLIPSIS = "…";

export interface BarState {
  label: string;
  /** < 0 = unknown size. */
  total: number;
  current: number;
  filesTotal: number;
  filesDone: number;
  status: string;
  width: number;
  elapsedMs: number;
}

export function humanizeBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function cellWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint >= 0x2e80
    || codePoint === 0x2329
    || codePoint === 0x232a
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += cellWidth(char.codePointAt(0)!);
  return width;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth < 1) return "";
  if (displayWidth(text) <= maxWidth) return text;
  const slash = text.lastIndexOf("/");
  if (slash >= 0 && slash < text.length - 1) {
    const tail = text.slice(slash + 1);
    const candidate = `…/${tail}`;
    if (displayWidth(candidate) <= maxWidth) return candidate;
    return truncateToWidth(tail, maxWidth);
  }
  const limit = maxWidth - 1;
  let out = "";
  let width = 0;
  for (const char of text) {
    const charWidth = cellWidth(char.codePointAt(0)!);
    if (width + charWidth > limit) break;
    out += char;
    width += charWidth;
  }
  return out + ELLIPSIS;
}

function gaugeString(width: number, percent: number): string {
  if (width <= 0) return "";
  const filled = Math.floor((width * percent) / 100);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function joinNonEmpty(parts: string[], separator: string): string {
  return parts.filter((part) => part !== "").join(separator);
}

function fitLabelAndMeta(label: string, meta: string, width: number): string {
  const metaWidth = displayWidth(meta);
  const available = width - 2 - metaWidth;
  if (available < 1) {
    return metaWidth <= width ? meta : truncateToWidth(meta, width);
  }
  return `${truncateToWidth(label, available)}  ${meta}`;
}

export function renderBarLine(state: BarState): string {
  const width = state.width > 0 ? state.width : DEFAULT_WIDTH;
  const currentText = humanizeBytes(state.current);
  const rate = state.elapsedMs > 0 ? state.current / (state.elapsedMs / 1000) : 0;
  const rateText = `${humanizeBytes(Math.trunc(rate))}/s`;

  let tags = "";
  if (state.filesTotal > 0) {
    tags = `[${state.filesDone}/${state.filesTotal} files]`;
  }
  if (state.status !== "") {
    tags = tags === "" ? `[${state.status}]` : `${tags} [${state.status}]`;
  }

  if (state.total < 0) {
    const variants = [[rateText, tags], [rateText], []];
    for (const extra of variants) {
      const extraText = extra.length > 0 ? `  ${joinNonEmpty(extra, "  ")}` : "";
      const line = `${state.label}  ${currentText}${extraText}`;
      if (displayWidth(line) <= width) return line;
    }
    return fitLabelAndMeta(state.label, currentText, width);
  }

  const percent = state.total > 0
    ? Math.min(100, Math.floor((state.current / state.total) * 100))
    : 0;
  const totalText = humanizeBytes(state.total);
  const remaining = rate > 0 && state.current < state.total
    ? `${Math.floor((state.total - state.current) / rate)}s`
    : "—";
  const progressText = `${currentText}/${totalText}`;
  const percentText = `${percent}%`;

  const extraSets = [
    [percentText, progressText, rateText, `ETA ${remaining}`, tags],
    [percentText, progressText, rateText, `ETA ${remaining}`],
    [percentText, progressText, rateText],
    [percentText, progressText],
    [progressText],
  ];

  for (const extras of extraSets) {
    const meta = joinNonEmpty(extras, "  ");
    const metaWidth = displayWidth(meta);
    const labelWidth = displayWidth(state.label);
    for (let gaugeWidth = GAUGE_WIDTH; gaugeWidth >= 0; gaugeWidth -= 1) {
      const gauge = gaugeString(gaugeWidth, percent);
      const parts = gauge === "" ? [state.label] : [state.label, gauge];
      const nonEmpty = parts.length + (meta === "" ? 0 : 1);
      const separators = nonEmpty > 1 ? (nonEmpty - 1) * 2 : 0;
      const totalWidth = labelWidth + displayWidth(gauge) + metaWidth + separators;
      if (totalWidth <= width) {
        const all = meta === "" ? parts : [...parts, meta];
        return joinNonEmpty(all, "  ");
      }
    }
  }
  return fitLabelAndMeta(state.label, progressText, width);
}

export interface ProgressBarOptions {
  tty?: boolean;
  width?: number;
  now?: () => number;
}

/** TTY-gated single-line progress bar mirroring internal/progress.Bar. */
export class ProgressBar {
  private readonly tty: boolean;
  private readonly width: number;
  private readonly now: () => number;
  private readonly start: number;
  private lastDraw: number | undefined;
  private current = 0;
  private filesTotal = 0;
  private filesDone = 0;
  private status = "";
  private finished = false;

  constructor(
    private readonly write: (text: string) => void,
    private readonly label: string,
    private readonly total: number,
    options: ProgressBarOptions = {},
  ) {
    this.tty = options.tty ?? false;
    this.width = options.width ?? DEFAULT_WIDTH;
    this.now = options.now ?? (() => Date.now());
    this.start = this.now();
  }

  setFiles(totalFiles: number): this {
    this.filesTotal = totalFiles;
    return this;
  }

  setBytes(bytes: number): void {
    if (!this.tty || this.finished) return;
    this.current = bytes;
    this.maybeRedraw();
  }

  setFilesDone(files: number): void {
    if (!this.tty || this.finished) return;
    this.filesDone = files;
    this.maybeRedraw();
  }

  setStatus(status: string): void {
    if (!this.tty || this.finished) return;
    this.status = status;
    this.maybeRedraw();
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.tty) this.write("\r\x1b[J");
  }

  private maybeRedraw(): void {
    const now = this.now();
    if (
      this.lastDraw !== undefined
      && now - this.lastDraw < THROTTLE_MS
      && !(this.total > 0 && this.current >= this.total)
    ) {
      return;
    }
    this.lastDraw = now;
    const line = renderBarLine({
      label: this.label,
      total: this.total,
      current: this.current,
      filesTotal: this.filesTotal,
      filesDone: this.filesDone,
      status: this.status,
      width: this.width,
      elapsedMs: now - this.start,
    });
    this.write(`\r\x1b[J${line}`);
  }
}

/** Bar on stderr; silent unless stderr is a TTY. */
export function newBar(io: IO, label: string, total: number): ProgressBar {
  return new ProgressBar((text) => io.err(text), label, total, {
    tty: stderrTTY(io),
    now: () => nowOf(io).getTime(),
  });
}
