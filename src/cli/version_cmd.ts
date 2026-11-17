import { REGISTRY_LATEST_URL } from "../pkg.js";
import { BUILD_DATE, COMMIT, goArch, goOS, VERSION } from "../version.js";
import { parseFlags } from "./flags.js";
import { platformOf, type IO } from "./io.js";
import { isNewer } from "./semver.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runVersionCmd(
  args: string[],
  io: IO,
  version: string = VERSION,
): Promise<number> {
  let flags;
  try {
    flags = parseFlags(args, {
      strings: [],
      numbers: [],
      booleans: ["check"],
      arrays: [],
    });
  } catch (err) {
    io.out(`${message(err)}\n`);
    return 2;
  }
  if (flags.positionals.length > 0) {
    io.out(`Error: unexpected args: ${flags.positionals.join(" ")}\n`);
    return 2;
  }

  io.out(`sshmng ${version} (${goOS(platformOf(io))}/${goArch(process.arch)})\n`);
  io.out(`commit: ${COMMIT}\n`);
  io.out(`built:  ${BUILD_DATE}\n`);
  if (!flags.booleans.has("check")) return 0;

  const fetchImpl = io.fetchImpl ?? fetch;
  let latest: string;
  try {
    const response = await fetchImpl(REGISTRY_LATEST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { version?: unknown };
    if (typeof body.version !== "string" || body.version === "") {
      throw new Error("latest response has no version");
    }
    latest = body.version;
  } catch (err) {
    io.out(`[WARN] remote check failed: ${message(err)}\n`);
    return 0;
  }

  if (isNewer(latest, version)) {
    io.out(`Checking latest release ... latest is ${latest}\n`);
    io.out(`Update available: ${version} -> ${latest}\n`);
    io.out("Run 'myssh update' to apply.\n");
  } else {
    io.out("Checking latest release ... already at latest\n");
  }
  return 0;
}
