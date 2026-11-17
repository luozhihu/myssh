export const GRAVE_TTL_MS = 10 * 60_000;

export interface CommandTrace {
  time: string;
  cmd: string;
  output: string;
  raw_output: string;
  exit_code: number;
  timed_out: boolean;
  ctrl_c_sent: boolean;
}

/** 复制并按 last_n / trunc_output 裁剪；不修改输入。 */
export function truncateTraces(
  traces: readonly CommandTrace[],
  lastN: number,
  truncOutput: number,
): CommandTrace[] {
  if (traces.length === 0) return [];
  const src = lastN > 0 && traces.length > lastN ? traces.slice(-lastN) : traces;
  return src.map((trace) => ({
    ...trace,
    output: truncOutput > 0 ? trace.output.slice(0, truncOutput) : trace.output,
    raw_output: truncOutput > 0
      ? trace.raw_output.slice(0, truncOutput)
      : trace.raw_output,
  }));
}
