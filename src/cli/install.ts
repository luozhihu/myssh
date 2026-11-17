import { readLineOf, envOf, homeOf, platformOf, type IO } from "./io.js";
import { parseFlags } from "./flags.js";
import { defaultHome, scaffoldHome } from "./files.js";
import { promptConfirm } from "./prompt.js";
import { buildEntry } from "./agent/entry.js";
import { createInjectors } from "./agent/registry.js";
import type { AgentContext, AgentInjector } from "./agent/types.js";
import { runDoctor, type DoctorOptions } from "./doctor.js";
import { VERSION } from "../version.js";

export interface InstallOptions {
  findNpx?: DoctorOptions["findNpx"];
  nodeVersion?: string;
  version?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function promptAgentSelection(
  io: IO,
  injectors: AgentInjector[],
  ctx: AgentContext,
): Promise<AgentInjector[]> {
  const items: Array<{ injector: AgentInjector; selected: boolean; path: string }> = [];
  for (const injector of injectors) {
    const detection = await injector.detect(ctx);
    items.push({ injector, selected: detection.installed, path: detection.path });
  }
  for (;;) {
    io.out("\nDetected Agents:\n");
    items.forEach((item, index) => {
      io.out(
        `  [${item.selected ? "*" : " "}] ${index + 1}. ${item.injector.displayName}    (${item.path || "(not installed)"})\n`,
      );
    });
    io.out("Toggle (1-N), 's' to skip, enter to confirm: ");
    const line = await readLineOf(io);
    if (line === null) return [];
    const input = line.trim();
    if (input === "") return items.filter((item) => item.selected).map((item) => item.injector);
    if (input === "s" || input === "S") return [];
    const index = Number(input);
    if (!Number.isInteger(index) || index < 1 || index > items.length) {
      io.out(`Invalid input ${JSON.stringify(input)}\n`);
      continue;
    }
    items[index - 1]!.selected = !items[index - 1]!.selected;
  }
}

export async function runInstall(
  args: string[],
  io: IO,
  options: InstallOptions = {},
): Promise<number> {
  let flags;
  try {
    flags = parseFlags(args, {
      strings: ["home", "agents"],
      numbers: [],
      booleans: ["yes", "pin", "skip-files", "skip-agents"],
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

  const version = options.version ?? VERSION;
  const env = envOf(io);
  const home = flags.strings.get("home") || defaultHome(env, homeOf(io));
  const yes = flags.booleans.has("yes");
  const pin = flags.booleans.has("pin");
  const skipFiles = flags.booleans.has("skip-files");
  const agentsFlag = flags.strings.get("agents") ?? "";
  const skipAgents = flags.booleans.has("skip-agents") || agentsFlag === "none";
  const explicitAgents = agentsFlag === "" || agentsFlag === "none"
    ? undefined
    : agentsFlag.split(",").map((name) => name.trim()).filter(Boolean);

  const ctx: AgentContext = {
    homeDir: homeOf(io),
    env,
    platform: platformOf(io),
  };
  const all = createInjectors(ctx);

  let injectors: AgentInjector[];
  if (skipAgents) {
    injectors = [];
  } else if (explicitAgents) {
    injectors = explicitAgents
      .map((name) => all.find((injector) => injector.name === name))
      .filter((injector): injector is AgentInjector => injector !== undefined);
  } else if (yes) {
    injectors = [];
    for (const injector of all) {
      if ((await injector.detect(ctx)).installed) injectors.push(injector);
    }
  } else {
    injectors = await promptAgentSelection(io, all, ctx);
  }

  if (!yes) {
    io.out("\nReview:\n");
    if (!skipFiles) {
      io.out(`  + ${home}/                      (dir, 0700)\n`);
      io.out(`  + ${home}/config.json           (0600, empty skeleton)\n`);
      io.out(`  + ${home}/config.example.json   (0600, examples)\n`);
    }
    for (const injector of injectors) {
      io.out(
        `  ~ ${injector.configPath(ctx)}                  (merge sshmng entry, backup -> .bak.<ts>)\n`,
      );
    }
    const answer = await promptConfirm(io.out, () => readLineOf(io), "Proceed?", false);
    if (answer.error !== undefined || !answer.confirmed) {
      io.out("Aborted.\n");
      return 0;
    }
  }

  io.out("Executing:\n");
  if (!skipFiles) {
    try {
      await scaffoldHome(home, {});
    } catch (err) {
      io.out(`  [FAIL] ScaffoldHome: ${message(err)}\n`);
      return 1;
    }
    io.out(`  [ok] Created ${home} (0700)\n`);
    io.out(`  [ok] Wrote ${home}/config.json (0600)\n`);
    io.out(`  [ok] Wrote ${home}/config.example.json (0600)\n`);
  }

  const entry = buildEntry(home, pin, version);
  for (const injector of injectors) {
    const file = injector.configPath(ctx);
    try {
      await injector.inject(file, entry);
    } catch (err) {
      io.out(`  [FAIL] ${injector.displayName}: ${message(err)}\n`);
      return 1;
    }
    io.out(`  [ok] Injected sshmng into ${file}\n`);
  }

  io.out("\nVerifying (doctor):\n");
  const doctorCode = await runDoctor([], io, {
    home,
    expectedEntries: [entry],
    findNpx: options.findNpx,
    nodeVersion: options.nodeVersion,
  });
  if (doctorCode === 1) {
    io.out("\nSetup completed with errors. Run 'sshmng doctor' for details.\n");
    return 1;
  }
  if (doctorCode === 2) {
    io.out("\nSetup completed with warnings. Run 'sshmng doctor' for details.\n");
  }

  io.out("\nSetup complete!\n\n");
  io.out("Next steps:\n");
  io.out("  1. Restart your Agent to load the new MCP config\n");
  io.out("  2. Ask Agent: \"list_ssh_servers\"\n");
  io.out("  3. Add servers by asking Agent \"add an SSH server named ...\"\n");
  io.out(`     Or manually edit ${home}/config.json (see config.example.json for examples)\n`);
  return 0;
}
