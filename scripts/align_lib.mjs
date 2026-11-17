/** Helpers for comparing Go sshmng and myssh CLI output. */

/** Normalize intentional branding differences before comparing. */
export function normalizeOutput(text) {
  return text.replace(/\bmyssh\b/g, "sshmng");
}

function splitLines(text) {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

/** Line-oriented diff: "- " is Go output, "+ " is myssh output. */
export function simpleDiff(expected, actual) {
  const a = splitLines(expected);
  const b = splitLines(actual);
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) continue;
    if (i < a.length) out.push(`- ${a[i]}`);
    if (i < b.length) out.push(`+ ${b[i]}`);
  }
  return out.join("\n");
}

/**
 * expected = Go result, actual = myssh result.
 * A difference with an allowlist entry is "allowed", not "fail".
 */
export function compareCase(name, expected, actual, allowed = {}) {
  const want = normalizeOutput(expected.stdout ?? "");
  const got = normalizeOutput(actual.stdout ?? "");
  const wantErr = normalizeOutput(expected.stderr ?? "");
  const gotErr = normalizeOutput(actual.stderr ?? "");
  if (expected.code === actual.code && want === got && wantErr === gotErr) {
    return { name, status: "pass", detail: "" };
  }
  const detail = [];
  if (expected.code !== actual.code) {
    detail.push(`exit: go=${expected.code} myssh=${actual.code}`);
  }
  if (want !== got) detail.push(`stdout:\n${simpleDiff(want, got)}`);
  if (wantErr !== gotErr) detail.push(`stderr:\n${simpleDiff(wantErr, gotErr)}`);
  return {
    name,
    status: allowed[name] ? "allowed" : "fail",
    reason: allowed[name],
    detail: detail.join("\n"),
  };
}
