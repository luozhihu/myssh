import { homedir } from "node:os";
import { createInterface, type Interface } from "node:readline/promises";

/** Local terminal hooks, injectable in tests. */
export interface TerminalHooks {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  isTTY: boolean;
  getWindowSize?(): { rows: number; cols: number } | undefined;
  onResize?(handler: () => void): () => void;
  setRawMode?(raw: boolean): void;
}

/** Everything a CLI command may need from the outside world. */
export interface IO {
  out(text: string): void;
  err(text: string): void;
  readLine?(): Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stderrIsTTY?: boolean;
  terminal?: TerminalHooks;
}

let sharedReadline: Interface | undefined;

export const defaultIO: IO = {
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
  env: process.env,
  homeDir: homedir(),
  platform: process.platform,
  fetchImpl: globalThis.fetch,
  now: () => new Date(),
  stderrIsTTY: !!process.stderr.isTTY,
};

export function envOf(io: IO): NodeJS.ProcessEnv {
  return io.env ?? process.env;
}

export function homeOf(io: IO): string {
  return io.homeDir ?? homedir();
}

export function platformOf(io: IO): NodeJS.Platform {
  return io.platform ?? process.platform;
}

export function nowOf(io: IO): Date {
  return (io.now ?? (() => new Date()))();
}

export function stderrTTY(io: IO): boolean {
  return io.stderrIsTTY ?? !!process.stderr.isTTY;
}

export async function readLineOf(io: IO): Promise<string | null> {
  if (io.readLine) return io.readLine();
  sharedReadline ??= createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await sharedReadline.question("");
  } catch {
    return null;
  }
}

export function terminalOf(io: IO): TerminalHooks {
  if (io.terminal) return io.terminal;
  const input = process.stdin;
  const output = process.stdout;
  return {
    stdin: input,
    stdout: output,
    stderr: process.stderr,
    isTTY: !!(input.isTTY && output.isTTY),
    getWindowSize: () => (
      output.isTTY ? { rows: output.rows, cols: output.columns } : undefined
    ),
    onResize: (handler) => {
      output.on("resize", handler);
      return () => { output.off("resize", handler); };
    },
    setRawMode: (raw) => {
      if (input.isTTY) input.setRawMode(raw);
    },
  };
}
