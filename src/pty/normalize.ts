const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripANSI(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** 剥离 ANSI 并给出 stripped 字节 → raw 字节末尾偏移的映射。 */
export function stripANSIWithPos(text: string): { stripped: string; posMap: number[] } {
  const chars: string[] = [];
  const posMap: number[] = [0];
  const re = new RegExp(ANSI_RE.source, "g");
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    for (let i = lastEnd; i < match.index; i += 1) {
      chars.push(text[i]!);
      posMap.push(i + 1);
    }
    lastEnd = match.index + match[0].length;
  }
  for (let i = lastEnd; i < text.length; i += 1) {
    chars.push(text[i]!);
    posMap.push(i + 1);
  }
  return { stripped: chars.join(""), posMap };
}

/** PTY 原始流 → 用户可读输出；只清除本 sid 的 sentinel。 */
export function cleanOutput(raw: string, sid: string): string {
  let text = stripANSI(raw);
  const sentinel = new RegExp(`_-?\\d+__${escapeRegex(sid)}_\\w*__\\]# `, "g");
  text = text.replace(sentinel, "");
  const ps1Only = new RegExp(`__P_${escapeRegex(sid)}__>\\s?`, "g");
  text = text.replace(ps1Only, "");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
  return text.replace(/\n+$/, "");
}
