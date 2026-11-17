function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** bash/zsh 初始 PS1 sentinel 是否出现在流末尾（token 可空）。 */
export function detectShellReady(stream: string, sid: string): boolean {
  return new RegExp(`_-?\\d+__${escapeRegex(sid)}_\\w*__\\]#\\s*$`).test(stream);
}

/** 取最后一个匹配 token 的 exit code；找不到返回 -1。 */
export function extractExitCode(stream: string, sid: string, token: string): number {
  const re = new RegExp(
    `_(-?\\d+)__${escapeRegex(sid)}_${escapeRegex(token)}__\\]# `,
    "g",
  );
  let last: RegExpExecArray | null = null;
  for (let match = re.exec(stream); match; match = re.exec(stream)) last = match;
  if (!last) return -1;
  const code = Number.parseInt(last[1]!, 10);
  return Number.isNaN(code) ? -1 : code;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/** 按字节保头截尾；maxBytes <= 0 不截断。 */
export function truncateOutput(text: string, maxBytes: number): TruncatedOutput {
  const totalBytes = Buffer.byteLength(text);
  if (maxBytes <= 0 || totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes };
  }
  return {
    text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    totalBytes,
  };
}
