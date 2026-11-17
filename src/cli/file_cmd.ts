import { open, stat as statLocal } from "node:fs/promises";
import type { Config } from "../config/types.js";
import { SessionManager } from "../session/manager.js";
import { parseConflictPolicy, type DirTransferResult } from "../sftp/types.js";
import { parseFlags, type FlagSpec } from "./flags.js";
import { envOf, platformOf, type IO } from "./io.js";
import { loadConfigForCli } from "./config_util.js";
import { loginFileSession, withFileSession } from "./file_session.js";
import { resolveDstPath } from "./file_path.js";
import { localDirTotals } from "./dir_totals.js";
import { newBar } from "./progress.js";

const FILE_USAGE = `Usage:
  sshmng file upload       <name> <local>  <remote>  [--timeout <ms>]
  sshmng file download     <name> <remote> <local>   [--timeout <ms>]
  sshmng file upload-dir   <name> <local>  <remote>  [--conflict overwrite|skip|rename] [--concurrency N] [--timeout <ms>]
  sshmng file download-dir <name> <remote> <local>   [--conflict ...] [--concurrency N] [--timeout <ms>]
  sshmng file relay        <src-name> <src-path> <dst-path> --to <dst1,dst2,...> [--timeout <ms>]

All subcommands accept --config <path>.
<name> is an SSH server name (supports name/addr/tag substring match, same as 'sshmng ssh').
Pattern B (bastion, ssh_j=false) does not support file transfer: sftp lands on the
jumphost, not the target. Use a direct or ssh_j=true connection.
`;

const RELAY_USAGE =
  "Usage: sshmng file relay <src-name> <src-path> <dst-path> --to <dst1,dst2,...> [--timeout <ms>] [--config <path>]\n";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseOrReport(
  args: string[],
  spec: FlagSpec,
  io: IO,
): ReturnType<typeof parseFlags> | undefined {
  try {
    return parseFlags(args, spec);
  } catch (err) {
    io.out(`${message(err)}\n`);
    return undefined;
  }
}

function positionalError(io: IO, count: number, expected: string): void {
  io.out(`Error: expected 3 positional args (${expected}), got ${count}\n`);
}

export async function runFileCmd(args: string[], io: IO): Promise<number> {
  if (args.length === 0) {
    io.out(FILE_USAGE);
    return 2;
  }
  switch (args[0]) {
    case "upload":
      return runUpload(args.slice(1), io);
    case "download":
      return runDownload(args.slice(1), io);
    case "upload-dir":
      return runUploadDir(args.slice(1), io);
    case "download-dir":
      return runDownloadDir(args.slice(1), io);
    case "relay":
      return runRelay(args.slice(1), io);
    default:
      io.out(
        `Unknown file subcommand ${JSON.stringify(args[0])}. Use 'upload', 'download', 'upload-dir', 'download-dir', or 'relay'.\n`,
      );
      io.out(FILE_USAGE);
      return 2;
  }
}

const SINGLE_USAGE = {
  upload: "Usage: sshmng file upload <name> <local> <remote> [--timeout <ms>] [--config <path>]\n",
  download: "Usage: sshmng file download <name> <remote> <local> [--timeout <ms>] [--config <path>]\n",
};

async function runUpload(args: string[], io: IO): Promise<number> {
  const flags = parseOrReport(
    args,
    { strings: ["config"], numbers: ["timeout"], booleans: [], arrays: [] },
    io,
  );
  if (!flags) return 2;
  if (flags.positionals.length !== 3) {
    io.out(SINGLE_USAGE.upload);
    if (flags.positionals.length !== 0) {
      positionalError(io, flags.positionals.length, "name local remote");
    }
    return 2;
  }
  const [name, local, remoteArg] = flags.positionals as [string, string, string];
  const timeout = flags.numbers.get("timeout") ?? 0;
  return withFileSession({ config: flags.strings.get("config"), name }, io, async (ctx) => {
    let fh;
    try {
      fh = await open(local, "r");
    } catch (err) {
      io.out(`Error: open ${local}: ${message(err)}\n`);
      return 1;
    }
    try {
      let size = -1;
      try { size = (await fh.stat()).size; } catch { /* indeterminate bar */ }
      const remote = resolveDstPath(
        local,
        remoteArg,
        remoteArg.endsWith("/"),
        platformOf(io),
      );
      const bar = newBar(io, `${ctx.server.name}:${remote}`, size);
      let outcome;
      try {
        outcome = await ctx.session.upload(
          fh.createReadStream({ autoClose: true }),
          remote,
          timeout,
          (bytes) => bar.setBytes(bytes),
        );
      } catch (err) {
        bar.finish();
        io.out(`Error: upload ${local} -> ${ctx.server.name}:${remote}: ${message(err)}\n`);
        return 1;
      }
      bar.finish();
      if (outcome.error && !outcome.timedOut) {
        io.out(`Error: upload ${local} -> ${ctx.server.name}:${remote}: ${outcome.error.message}\n`);
        return 1;
      }
      if (outcome.timedOut) {
        io.out(
          `uploaded ${local} -> ${ctx.server.name}:${remote} (timed out, ${outcome.bytes} bytes transferred)\n`,
        );
        return 1;
      }
      io.out(`uploaded ${local} -> ${ctx.server.name}:${remote} (${outcome.bytes} bytes)\n`);
      return 0;
    } finally {
      try { await fh.close(); } catch { /* stream may have closed it */ }
    }
  });
}

async function runDownload(args: string[], io: IO): Promise<number> {
  const flags = parseOrReport(
    args,
    { strings: ["config"], numbers: ["timeout"], booleans: [], arrays: [] },
    io,
  );
  if (!flags) return 2;
  if (flags.positionals.length !== 3) {
    io.out(SINGLE_USAGE.download);
    if (flags.positionals.length !== 0) {
      positionalError(io, flags.positionals.length, "name remote local");
    }
    return 2;
  }
  const [name, remote, localArg] = flags.positionals as [string, string, string];
  const timeout = flags.numbers.get("timeout") ?? 0;
  return withFileSession({ config: flags.strings.get("config"), name }, io, async (ctx) => {
    let localIsDir = localArg === "."
      || localArg.endsWith("/")
      || localArg.endsWith("\\");
    if (!localIsDir) {
      try {
        localIsDir = (await statLocal(localArg)).isDirectory();
      } catch {
        localIsDir = false;
      }
    }
    const local = resolveDstPath(remote, localArg, localIsDir, platformOf(io));
    let size = -1;
    try { size = (await ctx.session.sftpStat(remote)).size; } catch { /* indeterminate */ }
    const bar = newBar(io, `${ctx.server.name}:${remote}`, size);
    let outcome;
    try {
      outcome = await ctx.session.downloadToFile(remote, local, timeout, (bytes) => bar.setBytes(bytes));
    } catch (err) {
      bar.finish();
      io.out(`Error: download ${ctx.server.name}:${remote} -> ${local}: ${message(err)}\n`);
      return 1;
    }
    bar.finish();
    if (outcome.error && !outcome.timedOut) {
      io.out(`Error: download ${ctx.server.name}:${remote} -> ${local}: ${outcome.error.message}\n`);
      return 1;
    }
    if (outcome.timedOut) {
      io.out(
        `downloaded ${ctx.server.name}:${remote} -> ${local} (timed out, ${outcome.bytes} bytes transferred)\n`,
      );
      return 1;
    }
    io.out(`downloaded ${ctx.server.name}:${remote} -> ${local} (${outcome.bytes} bytes)\n`);
    return 0;
  });
}

function printDirResult(
  io: IO,
  verb: string,
  local: string,
  serverName: string,
  remote: string,
  result: DirTransferResult,
  error?: Error,
): void {
  let text = `${verb} ${local} -> ${serverName}:${remote} (${result.files} files, ${result.bytes} bytes`;
  if (result.skipped > 0) text += `, ${result.skipped} skipped`;
  if (result.renamed > 0) text += `, ${result.renamed} renamed`;
  if (result.timedOut > 0) text += `, ${result.timedOut} timed out`;
  text += ")";
  if (error) text += ` — partial: ${error.message}`;
  io.out(`${text}\n`);
}

interface DirFlags {
  config?: string;
  conflict: string;
  concurrency: number;
  timeout: number;
  rest: string[];
}

function parseDirFlags(args: string[], io: IO): DirFlags | undefined {
  const flags = parseOrReport(args, {
    strings: ["config", "conflict"],
    numbers: ["concurrency", "timeout"],
    booleans: [],
    arrays: [],
  }, io);
  if (!flags) return undefined;
  return {
    config: flags.strings.get("config"),
    conflict: flags.strings.get("conflict") ?? "overwrite",
    concurrency: flags.numbers.get("concurrency") ?? 0,
    timeout: flags.numbers.get("timeout") ?? 0,
    rest: flags.positionals,
  };
}

async function runUploadDir(args: string[], io: IO): Promise<number> {
  const flags = parseDirFlags(args, io);
  if (!flags) return 2;
  if (flags.rest.length !== 3) {
    io.out(
      "Usage: sshmng file upload-dir <name> <local> <remote> [--conflict overwrite|skip|rename] [--concurrency N] [--timeout <ms>] [--config <path>]\n",
    );
    if (flags.rest.length !== 0) positionalError(io, flags.rest.length, "name local remote");
    return 2;
  }
  const [name, local, remote] = flags.rest as [string, string, string];
  return withFileSession({ config: flags.config, name }, io, async (ctx) => {
    const totals = await localDirTotals(local);
    const bar = newBar(io, `${ctx.server.name}:${remote}`, totals.bytes);
    if (totals.files > 0) bar.setFiles(totals.files);
    const outcome = await ctx.session.uploadDir(local, remote, {
      conflict: parseConflictPolicy(flags.conflict),
      concurrency: flags.concurrency,
      timeoutMs: flags.timeout,
      onProgress: (bytes, files) => {
        bar.setBytes(bytes);
        bar.setFilesDone(files);
      },
    });
    bar.finish();
    printDirResult(io, "uploaded", local, ctx.server.name, remote, outcome.result, outcome.error);
    return outcome.error ? 1 : 0;
  });
}

async function runDownloadDir(args: string[], io: IO): Promise<number> {
  const flags = parseDirFlags(args, io);
  if (!flags) return 2;
  if (flags.rest.length !== 3) {
    io.out(
      "Usage: sshmng file download-dir <name> <remote> <local> [--conflict overwrite|skip|rename] [--concurrency N] [--timeout <ms>] [--config <path>]\n",
    );
    if (flags.rest.length !== 0) positionalError(io, flags.rest.length, "name remote local");
    return 2;
  }
  const [name, remote, local] = flags.rest as [string, string, string];
  return withFileSession({ config: flags.config, name }, io, async (ctx) => {
    const totals = await ctx.session.remoteDirTotals(remote);
    const bar = newBar(io, `${ctx.server.name}:${remote}`, totals.bytes);
    if (totals.files > 0) bar.setFiles(totals.files);
    const outcome = await ctx.session.downloadDir(remote, local, {
      conflict: parseConflictPolicy(flags.conflict),
      concurrency: flags.concurrency,
      timeoutMs: flags.timeout,
      onProgress: (bytes, files) => {
        bar.setBytes(bytes);
        bar.setFilesDone(files);
      },
    });
    bar.finish();
    printDirResult(io, "downloaded", local, ctx.server.name, remote, outcome.result, outcome.error);
    return outcome.error ? 1 : 0;
  });
}

async function loadRelayConfig(
  config: string | undefined,
  io: IO,
): Promise<{ cfg: Config; configPath: string } | number> {
  try {
    const loaded = await loadConfigForCli(config, envOf(io));
    return { cfg: loaded.cfg, configPath: loaded.path };
  } catch (err) {
    io.out(`Error: ${message(err)}\n`);
    return 1;
  }
}

async function runRelay(args: string[], io: IO): Promise<number> {
  const flags = parseOrReport(args, {
    strings: ["config"],
    numbers: ["timeout"],
    booleans: [],
    arrays: ["to"],
  }, io);
  if (!flags) return 2;
  if (flags.positionals.length !== 3) {
    io.out(RELAY_USAGE);
    if (flags.positionals.length !== 0) {
      positionalError(io, flags.positionals.length, "src-name src-path dst-path");
    }
    return 2;
  }
  const to = (flags.arrays.get("to") ?? []).flatMap((value) => value.split(","));
  if (to.length === 0) {
    io.out(RELAY_USAGE);
    io.out("Error: --to is required (one or more destination server names)\n");
    return 2;
  }
  const [srcName, srcPath, dstPath] = flags.positionals as [string, string, string];
  const timeout = flags.numbers.get("timeout") ?? 0;
  const loaded = await loadRelayConfig(flags.strings.get("config"), io);
  if (typeof loaded === "number") return loaded;

  const manager = new SessionManager();
  try {
    let src;
    try {
      src = await loginFileSession(manager, {
        cfg: loaded.cfg,
        configPath: loaded.configPath,
        name: srcName,
        allowPrompt: true,
        io,
      });
    } catch (err) {
      io.out(`Error: source ${srcName}: ${message(err)}\n`);
      return 1;
    }

    const dstSids: string[] = [];
    const dstNames = new Map<string, string>();
    for (const dstName of to) {
      try {
        const login = await loginFileSession(manager, {
          cfg: loaded.cfg,
          configPath: loaded.configPath,
          name: dstName,
          allowPrompt: false,
          io,
        });
        dstSids.push(login.sid);
        dstNames.set(login.sid, dstName);
      } catch (err) {
        io.out(`${dstName}: failed: ${message(err)}\n`);
      }
    }
    if (dstSids.length === 0) {
      io.out(`Error: no relay destinations connected (${to.length} failed)\n`);
      return 1;
    }

    let size = -1;
    try { size = (await src.session.sftpStat(srcPath)).size; } catch { /* indeterminate */ }
    const bar = newBar(io, src.server.name, size);
    let ok = 0;
    let failed = 0;
    let inFlight = dstSids.length;
    const updateStatus = (): void => {
      bar.setStatus(`${ok}✓ ${failed}✗ ${inFlight}⏳`);
    };
    updateStatus();

    const result = await manager.relayTransfer(
      src.sid,
      srcPath,
      dstSids,
      dstPath,
      timeout,
      {
        onDownloadedBytes: (bytes) => bar.setBytes(bytes),
        onDestinationDone: (_sid, destinationOk) => {
          inFlight -= 1;
          if (destinationOk) ok += 1;
          else failed += 1;
          updateStatus();
        },
      },
    );
    bar.finish();

    let okCount = 0;
    for (const destination of result.destinations) {
      const name = destination.dstServer || dstNames.get(destination.dstSid) || "";
      if (destination.ok) {
        io.out(`${name}: ok (${destination.bytes} bytes)\n`);
        okCount += 1;
      } else {
        io.out(`${name}: failed: ${destination.error ?? "unknown error"}\n`);
      }
    }
    io.out(
      `relay ${src.server.name} -> ${to.length} destinations: ${okCount} ok, ${to.length - okCount} failed\n`,
    );
    return okCount < to.length ? 1 : 0;
  } catch (err) {
    io.out(`Error: ${message(err)}\n`);
    return 1;
  } finally {
    manager.closeAll();
  }
}
