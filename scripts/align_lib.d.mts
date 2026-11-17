export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CaseOutcome {
  name: string;
  status: "pass" | "allowed" | "fail";
  reason?: string;
  detail: string;
}

export function normalizeOutput(text: string): string;
export function simpleDiff(expected: string, actual: string): string;
export function compareCase(
  name: string,
  expected: CliResult,
  actual: CliResult,
  allowed?: Record<string, string>,
): CaseOutcome;
