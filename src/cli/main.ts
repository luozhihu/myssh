import { PACKAGE_NAME } from "../pkg.js";
import { defaultIO } from "./io.js";
import type { IO } from "./io.js";
import { parseFlags } from "./flags.js";
import { resolveConfigPath, Store } from "../config/store.js";
import { Service } from "../mcp/service.js";
import { runStdioServer } from "../mcp/server.js";
import { runEntityCmd } from "./entity_cmd.js";
import { runSSHCmd } from "./ssh_cmd.js";
import { runFileCmd } from "./file_cmd.js";
import { runInstall } from "./install.js";
import { runDoctor } from "./doctor.js";
import { runUpdateCmd } from "./update_cmd.js";
import { runVersionCmd } from "./version_cmd.js";

export type { IO };

const helpText = `myssh - SSH session manager

Usage:
  myssh                          Print this help and exit
  myssh mcp [--config <path>]    Start MCP server (stdio)
  myssh install [...]            First-time setup
  myssh doctor [...]             Verify setup
  myssh update                   Explain how new releases reach Agent configs
  myssh version [--check]        Print version; --check compares with the npm registry
  myssh server <list|get> [...]  List or view SSH servers
  myssh jumphost <list|get> [...]  List or view jumphosts
  myssh proxy <list|get> [...]   List or view proxies
  myssh ssh <name> [command]   Interactive SSH login; with command, non-interactive
                                  <name> resolves to a server, or a jumphost
                                  if no server matches (direct jumphost login,
                                  including bastions). Non-interactive command
                                  against a bastion (ssh_j=false) or a raw
                                  device (raw=true, no unix shell) is rejected —
                                  use interactive mode
  myssh file <upload|download|upload-dir|download-dir|relay> [...]  File transfer
  myssh help | -h | --help       Print this help

Subcommands:
  mcp       Start the MCP server. This is what Agent configs use
            ("command": "npx", "args": ["-y", "${PACKAGE_NAME}@latest", "mcp"]).
  install   Create ~/.sshmng/, generate config templates, and inject myssh
            into your AI Agent(s) (Claude Code / CodeAgent / Hermes Agent /
            OpenCode). --pin freezes the npm version used by Agent configs;
            --local injects the globally installed myssh command instead
            (for tarball installs without publishing to npm).
  doctor    Verify setup is correct: files, permissions, node/npx, Agent
            config entries.
  update    myssh runs through npx, so it updates automatically. This command
            prints how Agent configs pick up new releases.
  version   Print the current version, commit, and build date. With --check,
            query the npm registry for the latest ${PACKAGE_NAME} release.
  server    List and view SSH server configurations.
  jumphost  List and view jumphost configurations.
  proxy     List and view proxy configurations.
  ssh       Connect to an SSH server by name. Optional second positional arg
            is a command to execute non-interactively (OpenSSH convention).
            Supports direct, Pattern A (ssh -J), and Pattern B (bastion).
            The name also resolves to a jumphost if no server matches —
            'myssh ssh <jumphost>' logs in directly (interactive bastion
            menu included). Non-interactive commands need a shell landing,
            so bastions (ssh_j=false) and raw devices (raw=true, no unix
            shell) reject commands; use interactive mode.
  file      Transfer files over sftp: upload, download, upload-dir,
            download-dir, and relay (1:N fanout). Mirrors the MCP transfer
            tools. Pattern B (bastion) is unsupported — sftp lands on the
            jumphost, not the target; use direct or ssh_j=true.

Run 'myssh help' for usage.
`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(args: string[], io: IO = defaultIO): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    io.out(helpText);
    return 0;
  }
  const command = args[0]!;
  switch (command) {
    case "mcp": {
      let config: string | undefined;
      try {
        const flags = parseFlags(args.slice(1), {
          strings: ["config"],
          numbers: [],
          booleans: ["help"],
          arrays: [],
        });
        config = flags.strings.get("config");
        if (flags.positionals.length > 0) {
          io.err(`Error: unexpected args: ${flags.positionals.join(" ")}\n`);
          return 2;
        }
      } catch (err) {
        io.err(`Error: ${message(err)}\n`);
        return 2;
      }
      const store = new Store(resolveConfigPath(config));
      try {
        await store.load();
        await runStdioServer(new Service(store));
        return 0;
      } catch (err) {
        io.err(`Error: ${message(err)}\n`);
        return 1;
      }
    }
    case "install":
      return runInstall(args.slice(1), io);
    case "doctor":
      return runDoctor(args.slice(1), io);
    case "update":
      return runUpdateCmd(args.slice(1), io);
    case "version":
      return runVersionCmd(args.slice(1), io);
    case "server":
    case "jumphost":
    case "proxy":
      return runEntityCmd(command, args.slice(1), io);
    case "ssh":
      return runSSHCmd(args.slice(1), io);
    case "file":
      return runFileCmd(args.slice(1), io);
    default:
      io.out(`Unknown command ${JSON.stringify(command)}. Run 'myssh help' for usage.\n`);
      return 2;
  }
}
