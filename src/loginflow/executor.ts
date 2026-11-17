import type { LoginAction } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import type { LoginTraceEntry } from "../ssh/types.js";
import { goDuration, traceTimestamp } from "../util/time.js";

export interface LoginFlowRead {
  output: string;
  matchedIdx: number;
  timedOut: boolean;
}

export interface LoginFlowPty {
  send(data: string): void;
  read(deadline: number, matchers: RegExp[]): Promise<LoginFlowRead>;
}

export interface LoginFlowOptions {
  maxSteps?: number;
  globalTimeoutMs?: number;
  defaultTimeoutMs?: number;
  logger?: Logger;
  now?: () => number;
}

export interface LoginFlowResult {
  trace: LoginTraceEntry[];
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_GLOBAL_TIMEOUT_MS = 60_000;
const SUCCESS = "success";

/** "re:" 前缀直接编译；否则 glob → 未锚定正则（contains 语义）。 */
export function compilePattern(pattern: string): RegExp {
  if (pattern.startsWith("re:")) return new RegExp(pattern.slice(3));
  return globToRegex(pattern);
}

/** 支持 *、?、[...]；其余正则元字符按字面量转义。 */
export function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") out += ".*";
    else if (char === "?") out += ".";
    else if (".+()|{}^$\\".includes(char)) out += `\\${char}`;
    else if (char === "[") {
      out += "[";
      while (i + 1 < pattern.length && pattern[i + 1] !== "]") {
        i += 1;
        out += pattern[i]!;
      }
      if (i + 1 < pattern.length) {
        i += 1;
        out += "]";
      }
    } else out += char;
  }
  return new RegExp(out);
}

function truncateForMsg(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
}

/**
 * 在 PTY 上执行 LoginFlow 决策树；失败时返回截至失败点的 trace。
 *
 * 每步顺序：Send（可空）→ Read（任一 matcher 命中即停，trailing 留在 pushback）
 * → 按 Expects 顺序匹配 → 跳转 Next（"success" 表示成功）。
 * 三层超时：单 Action（默认 10s，受全局 deadline 约束）、MaxSteps（默认 50）、
 * GlobalTimeout（默认 60s）。
 */
export async function runLoginFlow(
  pty: LoginFlowPty,
  flow: Record<string, LoginAction>,
  entry: string,
  options: LoginFlowOptions = {},
): Promise<LoginFlowResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const maxSteps = options.maxSteps && options.maxSteps > 0
    ? options.maxSteps
    : DEFAULT_MAX_STEPS;
  const globalTimeoutMs = options.globalTimeoutMs && options.globalTimeoutMs > 0
    ? options.globalTimeoutMs
    : DEFAULT_GLOBAL_TIMEOUT_MS;
  const defaultTimeoutMs = options.defaultTimeoutMs && options.defaultTimeoutMs > 0
    ? options.defaultTimeoutMs
    : DEFAULT_TIMEOUT_MS;

  const globalDeadline = now() + globalTimeoutMs;
  const trace: LoginTraceEntry[] = [];
  let currentName = entry;

  for (let step = 0; step < maxSteps; step += 1) {
    if (now() > globalDeadline) {
      const message =
        `loginflow: global timeout exceeded (${goDuration(globalTimeoutMs)}) ` +
        `at step ${step} (${JSON.stringify(currentName)})`;
      logger.warn("loginflow failed", {
        step, action: currentName, err: message, trace_len: trace.length,
      });
      return { trace, error: new Error(message) };
    }

    const action = flow[currentName];
    if (!action) {
      const message = `loginflow: action ${JSON.stringify(currentName)} not found in flow`;
      logger.warn("loginflow failed", {
        step, action: currentName, err: message, trace_len: trace.length,
      });
      return { trace, error: new Error(message) };
    }

    logger.debug("loginflow step", { step, action: currentName, send: action.send ?? "" });
    const stepStart = now();
    if (action.send) {
      try {
        pty.send(action.send);
      } catch (err) {
        const message = `loginflow: send at ${JSON.stringify(currentName)}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.warn("loginflow failed", {
          step, action: currentName, err: message, trace_len: trace.length,
        });
        return { trace, error: new Error(message) };
      }
    }

    const matchers: RegExp[] = [];
    for (const expect of action.expects) {
      try {
        matchers.push(compilePattern(expect.pattern));
      } catch (err) {
        const message =
          `loginflow: action ${JSON.stringify(currentName)}: invalid pattern ` +
          `${JSON.stringify(expect.pattern)}: ${
            err instanceof Error ? err.message : String(err)
          }`;
        logger.warn("loginflow failed", {
          step, action: currentName, err: message, trace_len: trace.length,
        });
        return { trace, error: new Error(message) };
      }
    }

    const timeoutMs = action.timeout_ms && action.timeout_ms > 0
      ? action.timeout_ms
      : defaultTimeoutMs;
    const deadline = Math.min(stepStart + timeoutMs, globalDeadline);

    let read: LoginFlowRead;
    try {
      read = await pty.read(deadline, matchers);
    } catch (err) {
      const message = `loginflow: read at ${JSON.stringify(currentName)}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger.warn("loginflow failed", {
        step, action: currentName, err: message, trace_len: trace.length,
      });
      return { trace, error: new Error(message) };
    }

    const matched = read.matchedIdx >= 0 ? action.expects[read.matchedIdx] : undefined;
    trace.push({
      time: traceTimestamp(new Date(stepStart)),
      elapsed_ms: now() - stepStart,
      send: action.send ?? "",
      expect: matched?.pattern ?? "",
      output: read.output,
    });
    logger.debug("loginflow read", {
      step,
      action: currentName,
      matched_idx: read.matchedIdx,
      matched_pattern: matched?.pattern ?? "",
      timed_out: read.timedOut,
      next: matched?.next ?? "",
      output: read.output,
    });

    if (read.timedOut) {
      const message =
        `loginflow: action ${JSON.stringify(currentName)} timed out after ` +
        `${goDuration(timeoutMs)}`;
      logger.warn("loginflow failed", {
        step, action: currentName, err: message, trace_len: trace.length,
      });
      return { trace, error: new Error(message) };
    }
    if (!matched) {
      const message =
        `loginflow: action ${JSON.stringify(currentName)}: no expect matched ` +
        `(output: ${JSON.stringify(truncateForMsg(read.output, 200))})`;
      logger.warn("loginflow failed", {
        step, action: currentName, err: message, trace_len: trace.length,
      });
      return { trace, error: new Error(message) };
    }
    if (matched.next === SUCCESS) {
      logger.debug("loginflow success", {
        step, action: currentName, total_steps: step + 1,
      });
      return { trace };
    }
    currentName = matched.next;
  }

  const message = `loginflow: max steps (${maxSteps}) exceeded`;
  logger.warn("loginflow failed", {
    step: maxSteps, action: currentName, err: message, trace_len: trace.length,
  });
  return { trace, error: new Error(message) };
}
