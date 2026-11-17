import { resolveConfigPath, Store } from "../config/store.js";
import { takeConfigFlag } from "./flags.js";
import { Service } from "../mcp/service.js";
import { runStdioServer } from "../mcp/server.js";
import { BUILD_DATE, COMMIT, goArch, goOS, VERSION } from "../version.js";
import { runEntityCmd } from "./entity_cmd.js";
import { runFileCmd } from "./file_cmd.js";
import { runSSHCmd } from "./ssh_cmd.js";
import { defaultIO } from "./io.js";
import type { IO } from "./io.js";

export type { IO };

const helpText = `myssh - SSH session manager

Usage:
  myssh                          Print this help and exit
  myssh mcp [--config <path>]    Start MCP server (stdio)
  myssh version                  Print version
  myssh server <list|get> [...]  List or view SSH servers
  myssh jumphost <list|get> [...]  List or view jumphosts
  myssh proxy <list|get> [...]   List or view proxies
  myssh help | -h | --help       Print this help
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(args: string[], io: IO = defaultIO): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    io.out(helpText);
    return 0;
  }
  switch (args[0]) {
    case "version":
      io.out(`sshmng ${VERSION} (${goOS()}/${goArch()})\n`);
      io.out(`commit: ${COMMIT}\n`);
      io.out(`built:  ${BUILD_DATE}\n`);
      return 0;
    case "mcp": {
      let config: string | undefined;
      try {
        config = takeConfigFlag(args.slice(1)).config;
      } catch (err) {
        io.err(`Error: ${errorMessage(err)}\n`);
        return 2;
      }
      const store = new Store(resolveConfigPath(config));
      try {
        await store.load();
        await runStdioServer(new Service(store));
        return 0;
      } catch (err) {
        io.err(`Error: ${errorMessage(err)}\n`);
        return 1;
      }
    }
    case "server":
      return runEntityCmd("server", args.slice(1), io);
    case "jumphost":
      return runEntityCmd("jumphost", args.slice(1), io);
    case "proxy":
      return runEntityCmd("proxy", args.slice(1), io);
    case "ssh":
      return runSSHCmd(args.slice(1), io);
    case "file":
      return runFileCmd(args.slice(1), io);
    default:
      io.out(`Unknown command ${JSON.stringify(args[0])}. Run 'myssh help' for usage.\n`);
      return 2;
  }
}
