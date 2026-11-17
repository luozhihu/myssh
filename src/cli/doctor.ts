import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { Store } from "../config/store.js";
import type { Config } from "../config/types.js";
import { VERSION } from "../version.js";
import { expectedEntries } from "./agent/entry.js";
import { createInjectors, verifyAny } from "./agent/registry.js";
import type { MCPEntry } from "./agent/types.js";
import { parseFlags } from "./flags.js";
import { defaultHome } from "./files.js";
import { envOf, homeOf, platformOf, type IO } from "./io.js";

export interface DoctorOptions {
  home?: string;
  agentFilter?: string[];
  expectedEntries?: MCPEntry[];
  findNpx?: () => Promise<string | null>;
  nodeVersion?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function runDoctor(
  args: string[],
  io: IO,
  options: DoctorOptions = {},
): Promise<number> {
  let filter = options.agentFilter;
  if (args.length > 0) {
    let flags;
    try {
      flags = parseFlags(args, {
        strings: ["agent"],
        numbers: [],
        booleans: [],
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
    const agent = flags.strings.get("agent");
    if (agent) filter = agent.split(",").map((name) => name.trim());
  }
  return runDoctorChecks(io, { ...options, agentFilter: filter });
}

async function runDoctorChecks(io: IO, options: DoctorOptions): Promise<number> {
  const env = envOf(io);
  const home = options.home ?? defaultHome(env, homeOf(io));
  const platform = platformOf(io);
  const expected = options.expectedEntries ?? expectedEntries(home);
  const findNpx = options.findNpx ?? (() => Promise.resolve(findOnPath("npx", env)));
  const nodeVersion = options.nodeVersion ?? process.versions.node;

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  const print = (level: "OK" | "FAIL" | "WARN", text: string): void => {
    io.out(`  [${level}]  ${text}\n`);
    if (level === "FAIL") failCount += 1;
    else if (level === "WARN") warnCount += 1;
    else passCount += 1;
  };

  io.out("sshmng doctor - verifying setup\n\nHome:\n");

  let homeInfo;
  try {
    homeInfo = await fs.stat(home);
  } catch {
    homeInfo = undefined;
  }
  if (!homeInfo) {
    print("FAIL", `${home} missing - run 'sshmng install' to create`);
  } else if (!homeInfo.isDirectory()) {
    print("FAIL", `${home} is not a directory`);
  } else if (platform !== "win32") {
    const perm = homeInfo.mode & 0o777;
    if (perm !== 0o700) {
      print("FAIL", `${home} perm ${perm.toString(8)}, want 0700 (chmod 700 ${home})`);
    } else {
      print("OK", `${home} exists, 0700`);
    }
  } else {
    print("WARN", `${home} exists; manually restrict NTFS ACL (Properties -> Security)`);
  }

  const configPath = path.join(home, "config.json");
  let cfg: Config | undefined;
  let configLoaded = false;
  let configExists = false;
  try {
    await fs.stat(configPath);
    configExists = true;
  } catch {
    configExists = false;
  }
  if (!configExists) {
    print("FAIL", `${configPath} missing - run 'sshmng install'`);
  } else {
    try {
      cfg = await new Store(configPath).load();
      configLoaded = true;
    } catch (err) {
      print("FAIL", `config.json invalid: ${message(err)}`);
    }
    if (configLoaded) {
      if (platform !== "win32") {
        const info = await fs.stat(configPath);
        const perm = info.mode & 0o777;
        if (perm !== 0o600) {
          print("FAIL", `config.json perm ${perm.toString(8)}, want 0600 (chmod 600 ${configPath})`);
        } else {
          print("OK", `${configPath} exists, 0600, loads OK`);
        }
      } else {
        print("OK", `${configPath} exists, loads OK`);
      }
    }
  }

  const examplePath = path.join(home, "config.example.json");
  if (existsSync(examplePath)) print("OK", `${examplePath} exists`);
  else {
    print("WARN", `${examplePath} missing (optional, run 'sshmng install' to regenerate)`);
  }

  io.out("\nUpdate source:\n");
  if (configLoaded && cfg) {
    if (!cfg.update_url) {
      print("OK", "update_url: not configured (using GitHub Releases)");
    } else {
      let failure: string | undefined;
      try {
        const url = new URL(cfg.update_url);
        if (url.username !== "" || url.password !== "") {
          failure = "invalid update_url: embedded credentials are not allowed";
        } else if (
          (url.protocol !== "http:" && url.protocol !== "https:") || url.host === ""
        ) {
          failure =
            "invalid update_url: must be http:// or https:// URL with host (value redacted)";
        }
      } catch {
        failure =
          "invalid update_url: must be http:// or https:// URL with host (value redacted)";
      }
      if (failure) print("FAIL", failure);
      else print("OK", `update_url: ${cfg.update_url}`);
    }
  }

  const version: string = VERSION;
  if (version === "dev") {
    print("WARN", "version not set at build time; this is a dev build. Self-update disabled.");
  } else {
    print("OK", `version: ${version}`);
  }

  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 22) {
    print("FAIL", `node ${nodeVersion} is too old; install Node.js >= 22`);
  } else {
    print("OK", `node ${nodeVersion}`);
  }
  const npxPath = await findNpx();
  if (npxPath) print("OK", "npx on PATH");
  else print("FAIL", "npx not found on PATH - install Node.js >= 22 (includes npx)");

  const knownHosts = path.join(home, "known_hosts");
  try {
    const info = await fs.stat(knownHosts);
    if (platform !== "win32") {
      const perm = info.mode & 0o777;
      if (perm !== 0o600) {
        print("FAIL", `known_hosts perm ${perm.toString(8)}, want 0600 (chmod 600 ${knownHosts})`);
      } else {
        print("OK", "known_hosts: 0600");
      }
    } else {
      print("OK", "known_hosts exists");
    }
  } catch {
    /* absent is fine: created on first connection */
  }

  io.out("\nAgents:\n");
  const ctx = { homeDir: homeOf(io), env, platform };
  for (const injector of createInjectors(ctx)) {
    if (options.agentFilter && options.agentFilter.length > 0
      && !options.agentFilter.includes(injector.name)) {
      continue;
    }
    const detection = await injector.detect(ctx);
    io.out(`  ${injector.displayName} (${detection.path})\n`);
    if (!detection.installed) {
      io.out(
        `    [SKIP]  not detected (install ${injector.displayName} or pass --agent ${injector.name} to force)\n`,
      );
      continue;
    }
    const err = await verifyAny(injector, detection.path, expected);
    if (err) print("FAIL", `${injector.displayName}: ${err.message}`);
    else print("OK", `${injector.displayName} config has sshmng entry, command/args/env match`);
  }

  io.out(
    `\nSummary: ${passCount} passed, ${failCount} failed, ${warnCount} warning(s)\n`,
  );
  if (failCount > 0) return 1;
  if (warnCount > 0) return 2;
  return 0;
}
