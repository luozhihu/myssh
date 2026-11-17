export interface LoginTraceEntry {
  time: string;
  elapsed_ms: number;
  send: string;
  expect: string;
  output: string;
}

export class LoginFlowError extends Error {
  constructor(
    readonly stage: string,
    readonly trace: LoginTraceEntry[],
    message: string,
  ) {
    super(message);
    this.name = "LoginFlowError";
  }
}

export interface RunOutcome {
  output: string;
  rawOutput: string;
  exitCode: number;
  timedOut: boolean;
  ctrlCSent: boolean;
  truncated: boolean;
  totalBytes: number;
  connUnusable: boolean;
}

export interface RawReadResult {
  output: string;
  more: boolean;
  idleMs: number;
}
