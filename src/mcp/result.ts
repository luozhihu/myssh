import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function redactAuth(value: unknown): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  const auth = clone.auth;
  if (typeof auth === "object" && auth !== null) {
    const a = auth as Record<string, unknown>;
    delete a.password;
    delete a.private_key;
    delete a.passphrase;
  }
  return clone;
}
