import { PACKAGE_NAME } from "../pkg.js";
import { VERSION } from "../version.js";
import { parseFlags } from "./flags.js";
import type { IO } from "./io.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** myssh runs through npx, so "update" only explains how new releases arrive. */
export async function runUpdateCmd(args: string[], io: IO): Promise<number> {
  try {
    const flags = parseFlags(args, {
      strings: [],
      numbers: [],
      booleans: [],
      arrays: [],
    });
    if (flags.positionals.length > 0) {
      io.out(`Error: unexpected args: ${flags.positionals.join(" ")}\n`);
      return 2;
    }
  } catch (err) {
    io.out(`${message(err)}\n`);
    return 2;
  }

  io.out("myssh update - checking for updates\n\n");
  io.out(`Current version: ${VERSION}\n`);
  io.out("myssh is distributed via npm and runs with npx, so there is nothing to update in place.\n");
  io.out(`Agent configs use "npx -y ${PACKAGE_NAME}@latest" and pick up new releases automatically.\n`);
  io.out(`To force the latest release now: npx -y ${PACKAGE_NAME}@latest version\n`);
  io.out(
    "To pin a specific version, run 'myssh install --pin --agents <names>' or edit the Agent config.\n",
  );
  return 0;
}
