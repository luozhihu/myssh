import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

const DEFAULT_READ_WAIT_MS = 5_000;
const MAX_READ_WAIT_MS = 60_000;
const DEFAULT_READ_MAX_BYTES = 128 * 1024;
const MAX_READ_MAX_BYTES = 1 << 20;
const MAX_SEND_INPUT_BYTES = 64 * 1024;

/** 解释 C 风格转义；未知转义保留反斜杠与后续字符。 */
export function expandSendInput(input: string): string {
  if (!input.includes("\\")) return input;
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      out += char;
      break;
    }
    switch (next) {
      case "r": out += "\r"; i += 1; break;
      case "n": out += "\n"; i += 1; break;
      case "t": out += "\t"; i += 1; break;
      case "e": out += "\x1b"; i += 1; break;
      case "\\": out += "\\"; i += 1; break;
      case "u": {
        const hex = input.slice(i + 2, i + 6);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
        } else {
          out += "\\";
        }
        break;
      }
      default:
        out += "\\";
        break;
    }
  }
  return out;
}

export async function sendInSessionTool(
  svc: Service,
  args: { sid: string; input: string },
) {
  if (Buffer.byteLength(args.input) > MAX_SEND_INPUT_BYTES) {
    return errorResult(
      `input too large: ${Buffer.byteLength(args.input)} bytes (max ${MAX_SEND_INPUT_BYTES})`,
    );
  }
  try {
    const session = svc.manager.get(args.sid);
    const sent = await session.sendInSession(expandSendInput(args.input));
    return textResult({ sid: args.sid, sent_bytes: sent });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export async function readInSessionTool(
  svc: Service,
  args: { sid: string; wait_ms?: number; max_bytes?: number },
) {
  let waitMs = args.wait_ms ?? 0;
  if (waitMs <= 0) waitMs = DEFAULT_READ_WAIT_MS;
  if (waitMs > MAX_READ_WAIT_MS) waitMs = MAX_READ_WAIT_MS;
  let maxBytes = args.max_bytes ?? 0;
  if (maxBytes <= 0) maxBytes = DEFAULT_READ_MAX_BYTES;
  if (maxBytes > MAX_READ_MAX_BYTES) maxBytes = MAX_READ_MAX_BYTES;
  try {
    const session = svc.manager.get(args.sid);
    return textResult(await session.readInSession(waitMs, maxBytes));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
