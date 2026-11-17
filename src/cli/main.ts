import { BUILD_DATE, COMMIT, goArch, goOS, VERSION } from "../version.js";

export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIO: IO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

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
    default:
      io.out(`Unknown command ${JSON.stringify(args[0])}. Run 'myssh help' for usage.\n`);
      return 2;
  }
}
