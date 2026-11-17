function core(version: string): number[] {
  const cleaned = version.trim().replace(/^v/i, "").split("-")[0] ?? "";
  const parts = cleaned.split(".");
  return [0, 1, 2].map((index) => {
    const value = Number.parseInt(parts[index] ?? "0", 10);
    return Number.isFinite(value) ? value : 0;
  });
}

/** Semver-ish comparison ignoring prerelease tags. */
export function isNewer(latest: string, current: string): boolean {
  const a = core(latest);
  const b = core(current);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
}
