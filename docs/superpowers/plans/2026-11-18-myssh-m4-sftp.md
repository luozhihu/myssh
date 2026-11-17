# M4 — SFTP File Transfer, Directory Transfer, Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach feature parity with `sshmng` M4: atomic single-file upload/download, recursive directory transfer with conflict policies, and 1:N streaming relay, exposed as five new MCP tools (`upload`, `download`, `upload_dir`, `download_dir`, `relay_transfer`).

**Architecture:** A persistent `SftpClient` is opened at login (direct and Pattern A only; Pattern B has no target-side SSH client and therefore no sftp). Sessions own the client and wrap every transfer in the same idle→running→idle state machine used by `run_in_session`. Transfers are Node-stream based: uploads pre-open a temp remote handle and pump the local `Readable` with backpressure; downloads pump the remote `ReadStream` into a local `Writable`. Directory transfers run the same two-pass walk + worker pool as the Go implementation. Relay uses one shared download feeding N `PassThrough`s through a `Writable` fanout sink.

**Tech Stack:** TypeScript 7 strict ESM, Node ≥22, ssh2 1.17 (`SFTPWrapper`, client `ReadStream`/`WriteStream`, server SFTP protocol events), vitest 5, zod 4, MCP SDK 1.32.

---

## Behavioral contract (ported from the Go code)

These values and messages are user-visible and must match `sshmng`:

| Item | Exact value |
| --- | --- |
| Default transfer timeout | `300_000` ms |
| sftp unavailable error | `sftp not available for this session` |
| Temp remote path | `<remotePath>.sshmng-tmp-<6 hex>` (3 random bytes) |
| Upload open failure | `create remote <tmp>: <err>` |
| Download open failure | `open remote <path>: <err>` |
| Upload rename failure | `rename <tmp> -> <remote>: <err> (posix: <posixErr>)` |
| DownloadToFile temp create failure | `create temp for <localPath>: <err>` |
| DownloadToFile rename failure | `rename temp -> <localPath>: <err>` |
| Not a directory | `local path is not a directory` |
| Worker pool default | 4 |
| Conflict policy default | `overwrite` (also for unknown values) |
| Rename pattern | `name_1.ext`, `name_2.ext` (split at last dot) |
| Relay hard errors only | missing source sid, empty `dst_sids` |
| Fanout all-dead error | `all relay destinations failed` |
| Relay self target | `cannot relay a session to itself` |
| Relay all preflight failed | `no live relay destinations (all failed pre-flight)` |
| Relay non-regular source | `source not a regular file` |
| Relay partial failure root | `one or more relay destinations failed` |

Session transfer state machine (all six operations): closed → `session closed`; running → `session busy`; otherwise set `running`, stop idle timer, execute, then always reset `last_activity` and (if not closed concurrently) `idle` + restart idle timer. SFTP errors never close the session.

### ssh2 constraints discovered while reading the library

- The ssh2 **server** SFTP implementation sends a fixed version packet with **no extensions**. `SFTPWrapper.ext_openssh_fsync` and `ext_openssh_rename` throw **synchronously** when the peer did not advertise the extension. Every client extension call must be wrapped in `try/catch`; the fake server thus always exercises the `Remove` + `Rename` fallback, while real OpenSSH uses `posix-rename`.
- `ReadStream` reads sequentially; `WriteStream._write` issues one WRITE at a time, `_writev` batches concurrent writes. We pump with explicit backpressure so abort/timeout is deterministic.
- `WriteStream` forces `emitClose = false` and `autoDestroy = false`. With `autoClose: false` and a pre-opened `handle`, `_final` does not close the handle, so we can fsync and close explicitly. `destroy()` still closes the handle via `_destroy`.
- **Node ≥23 quirk:** with `autoClose: true`, `WriteStream._final` calls `destroy()` before `cb()`, which suppresses the `finish` event entirely (verified on Node 23.11). All uploads and the fake-server test helper must open with `autoClose: false` and close the handle explicitly; do not await `finish` on a default `createWriteStream`.
- `FileHandle.createWriteStream({ autoClose: false })` keeps a reference to the handle: after `finish`, `fh.close()` hangs forever unless the stream is destroyed first. `downloadToFile` must call `ws.destroy()` before closing/renaming (verified on Node 23.11).
- Timing out **while awaiting `finish`** must be observable: a small file finishes pumping long before a slow WRITE is acknowledged, so a bare `once(dst, "finish")` never settles after the abort destroys the stream. `finishWritable` therefore races `finish`/`error`/`close`/abort and reports the abort reason.
- When an SFTP channel closes with requests in flight, ssh2 invokes their callbacks with `No response from server`, which can surface as an uncaught stream `error` after our pump has detached. Transfer streams get a permanent no-op `error` listener for their entire lifetime.
- Client `readdir(path)` internally opens the directory, loops `READDIR` until a `STATUS_CODE.EOF`, then closes it. A fake server must return entries on the first `READDIR` and EOF on the next.
- Client status errors carry `.code` (`STATUS_CODE.NO_SUCH_FILE === 2`).
- The fake shell's `export PS1='$(echo _$?)__<sid>___]# '` matcher only accepts a lowercase-hex sid. Fake-backed login tests must pass a hex sid (e.g. `ab12`), not `s1`, or RC injection times out.

---

## File structure

Create:
- `src/sftp/types.ts` — constants, errors, result/stat/option types, conflict parsing, `joinErrors`.
- `src/sftp/paths.ts` — atomic remote path + temp suffix helper.
- `src/sftp/stream.ts` — `pumpToWritable`, `pumpToSink`-style helpers, `finishWritable`, `waitDrain`, byte counting.
- `src/sftp/client.ts` — `openSftp`, `SftpClient` (stat/upload/download/downloadToFile/readdir/lstat/mkdir).
- `src/sftp/dir.ts` — `uploadDir`, `downloadDir`, conflict resolution, remote/local walks, worker pool.
- `src/session/relay.ts` — `FanoutSink`, `relayTransfer`.
- `src/mcp/tools_file.ts` — upload/download/upload_dir/download_dir tools.
- `src/mcp/tools_relay.ts` — relay_transfer tool.
- `tests/helpers/fake_sftp.ts` — protocol-level fake SFTP server backed by a temp dir.
- `tests/sftp/fake_server.test.ts`
- `tests/sftp/client.test.ts`
- `tests/sftp/dir.test.ts`
- `tests/mcp/file_tools.test.ts`
- `tests/mcp/relay.test.ts`

Modify:
- `tests/helpers/fake_ssh.ts` — accept the sftp subsystem, expose `sftpRoot`, `sftpDelayMs`, `failRename`.
- `src/ssh/login.ts` — open a persistent sftp client after login; drop the probe-only transport method.
- `src/pty/transport.ts` — remove `probeSftp` (no longer used).
- `src/session/session.ts` — own `sftp`, add transfer methods + `withTransfer`, close it.
- `src/session/manager.ts` — `relayTransfer` delegate.
- `src/mcp/tools_session.ts` — pass `setup.sftp` into the session.
- `src/mcp/server.ts` — register 5 tools, extend instructions.
- `tests/pty/pty_loginflow.test.ts` — drop `probeSftp` from `ManualTransport`.
- `tests/mcp/tools_config.test.ts` — expect 21 tools.
- `README.md` — M4 status, tool list, examples.

---

### Task 1: Fake SFTP server

**Files:**
- Create: `tests/helpers/fake_sftp.ts`
- Modify: `tests/helpers/fake_ssh.ts`
- Test: `tests/sftp/fake_server.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/sftp/fake_server.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client, SFTPWrapper } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function writeAll(sftp: SFTPWrapper, remote: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remote);
    ws.on("error", reject);
    ws.on("finish", () => resolve());
    ws.end(data);
  });
}

function readAll(sftp: SFTPWrapper, remote: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const rs = sftp.createReadStream(remote);
    rs.on("data", (chunk: Buffer) => chunks.push(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function setup() {
  const server = await FakeSshServer.start({ allowSftp: true });
  const temp = await tempDir();
  cleanupFns.push(() => server.close(), temp.cleanup);
  const client = await new Dialer(
    new KnownHostsStore(path.join(temp.dir, "known_hosts")),
  ).dial({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  cleanupFns.push(async () => client.end());
  const sftp = await openSftp(client);
  cleanupFns.push(async () => sftp.end());
  return { server, sftp };
}

describe("fake SFTP server", () => {
  it("supports open/write/close/stat/read/readdir/rename/remove/mkdir", async () => {
    const { server, sftp } = await setup();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir("/data", (err) => (err ? reject(err) : resolve()));
    });
    await writeAll(sftp, "/data/a.txt", Buffer.from("hello sftp"));

    expect(readFileSync(path.join(server.sftpRoot, "data", "a.txt"), "utf8"))
      .toBe("hello sftp");

    const st = await new Promise<{ size: number; isFile(): boolean }>(
      (resolve, reject) => {
        sftp.stat("/data/a.txt", (err, stats) => (err ? reject(err) : resolve(stats)));
      },
    );
    expect(st.size).toBe(10);
    expect(st.isFile()).toBe(true);

    expect((await readAll(sftp, "/data/a.txt")).toString()).toBe("hello sftp");

    const names = await new Promise<string[]>((resolve, reject) => {
      sftp.readdir("/data", (err, list) => (
        err ? reject(err) : resolve(list.map((entry) => entry.filename))
      ));
    });
    expect(names).toContain("a.txt");

    await new Promise<void>((resolve, reject) => {
      sftp.rename("/data/a.txt", "/data/b.txt", (err) => (err ? reject(err) : resolve()));
    });
    expect((await readAll(sftp, "/data/b.txt")).toString()).toBe("hello sftp");

    await new Promise<void>((resolve, reject) => {
      sftp.unlink("/data/b.txt", (err) => (err ? reject(err) : resolve()));
    });
    await expect(readAll(sftp, "/data/b.txt")).rejects.toThrow();
  });

  it("maps missing paths to NO_SUCH_FILE and refuses to rename onto an existing file", async () => {
    const { sftp } = await setup();
    await writeAll(sftp, "/one", Buffer.from("1"));
    await writeAll(sftp, "/two", Buffer.from("2"));

    const statError = await new Promise<Error>((resolve) => {
      sftp.stat("/missing", (err) => resolve(err!));
    });
    expect((statError as Error & { code: number }).code).toBe(2);

    const renameError = await new Promise<Error>((resolve) => {
      sftp.rename("/one", "/two", (err) => resolve(err!));
    });
    expect(renameError).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sftp/fake_server.test.ts`
Expected: FAIL — `FakeSshOptions.allowSftp` accepts the channel but never speaks the protocol, so `client.sftp` times out / `sftp` is undefined; `server.sftpRoot` does not exist.

- [ ] **Step 3: Write `tests/helpers/fake_sftp.ts`**

```ts
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import type { Attributes, FileEntry, SFTPWrapper, Stats } from "ssh2";

const { utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export interface FakeSftpOptions {
  /** Real directory that backs "/". */
  root: string;
  /** Artificial per-READ/WRITE delay, for timeout tests. */
  delayMs?: number;
  /** Make every RENAME fail with FAILURE, to exercise fallback errors. */
  failRename?: boolean;
}

function modeOf(mode: number): number {
  return mode & S_IFMT;
}

function attrsOf(st: Stats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longnameOf(st: Stats, name: string): string {
  const kind = modeOf(st.mode) === S_IFDIR ? "d" : modeOf(st.mode) === S_IFLNK ? "l" : "-";
  return `${kind}rwxr-xr-x 1 ${st.uid} ${st.gid} ${st.size} Jan 1 00:00 ${name}`;
}

/**
 * Minimal SFTP v3 server: protocol handlers over a real temp directory.
 * Accepts remote absolute paths, mapped below `root`.
 */
export class FakeSftp {
  private readonly files = new Map<number, { fd: number; path: string }>();
  private readonly dirs = new Map<number, { entries: FileEntry[]; sent: boolean }>();
  private nextId = 1;

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly options: FakeSftpOptions,
  ) {
    this.sftp.on("OPEN", (reqId, filename, flags) => {
      try {
        const target = this.realPath(filename);
        const mode = this.openMode(flags);
        const fd = openSync(target, mode);
        const id = this.newId();
        this.files.set(id, { fd, path: target });
        this.sftp.handle(reqId, this.handleOf(id));
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("WRITE", (reqId, handle, offset, data) => {
      const entry = this.files.get(handle.readUInt32BE(0));
      if (!entry) return this.status(reqId, STATUS_CODE.FAILURE);
      this.delayed(() => {
        try {
          writeSync(entry.fd, data, 0, data.length, offset);
          this.status(reqId, STATUS_CODE.OK);
        } catch (err) {
          this.fail(reqId, err);
        }
      });
    });

    this.sftp.on("READ", (reqId, handle, offset, len) => {
      const entry = this.files.get(handle.readUInt32BE(0));
      if (!entry) return this.status(reqId, STATUS_CODE.FAILURE);
      this.delayed(() => {
        try {
          const buf = Buffer.alloc(len);
          const n = readSync(entry.fd, buf, 0, len, offset);
          if (n === 0) this.status(reqId, STATUS_CODE.EOF);
          else this.sftp.data(reqId, buf.subarray(0, n));
        } catch (err) {
          this.fail(reqId, err);
        }
      });
    });

    this.sftp.on("CLOSE", (reqId, handle) => {
      const id = handle.readUInt32BE(0);
      const entry = this.files.get(id) ?? this.dirs.get(id);
      if (!entry) return this.status(reqId, STATUS_CODE.FAILURE);
      if ("fd" in entry) {
        closeSync(entry.fd);
        this.files.delete(id);
      } else {
        this.dirs.delete(id);
      }
      this.status(reqId, STATUS_CODE.OK);
    });

    this.sftp.on("STAT", (reqId, remote) => {
      try {
        this.sftp.attrs(reqId, attrsOf(statSync(this.realPath(remote))));
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("LSTAT", (reqId, remote) => {
      try {
        this.sftp.attrs(reqId, attrsOf(lstatSync(this.realPath(remote))));
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("FSTAT", (reqId, handle) => {
      const entry = this.files.get(handle.readUInt32BE(0));
      if (!entry) return this.status(reqId, STATUS_CODE.FAILURE);
      this.sftp.attrs(reqId, attrsOf(fstatSync(entry.fd)));
    });

    // ssh2's WriteStream issues an fchmod after open; accept without acting.
    this.sftp.on("FSETSTAT", (reqId) => this.status(reqId, STATUS_CODE.OK));
    this.sftp.on("SETSTAT", (reqId) => this.status(reqId, STATUS_CODE.OK));

    this.sftp.on("OPENDIR", (reqId, remote) => {
      try {
        const target = this.realPath(remote);
        const st = statSync(target);
        if (!st.isDirectory()) return this.status(reqId, STATUS_CODE.FAILURE);
        const entries: FileEntry[] = [];
        for (const name of [".", "..", ...readdirSync(target)]) {
          const full = name === "." ? target : name === ".." ? path.dirname(target) : path.join(target, name);
          const est = lstatSync(full);
          entries.push({ filename: name, longname: longnameOf(est, name), attrs: attrsOf(est) });
        }
        const id = this.newId();
        this.dirs.set(id, { entries, sent: false });
        this.sftp.handle(reqId, this.handleOf(id));
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("READDIR", (reqId, handle) => {
      const entry = this.dirs.get(handle.readUInt32BE(0));
      if (!entry) return this.status(reqId, STATUS_CODE.FAILURE);
      if (entry.sent) return this.status(reqId, STATUS_CODE.EOF);
      entry.sent = true;
      this.sftp.name(reqId, entry.entries);
    });

    this.sftp.on("MKDIR", (reqId, remote) => {
      try {
        mkdirSync(this.realPath(remote));
        this.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("REMOVE", (reqId, remote) => {
      try {
        unlinkSync(this.realPath(remote));
        this.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("RENAME", (reqId, oldRemote, newRemote) => {
      if (this.options.failRename) return this.status(reqId, STATUS_CODE.FAILURE);
      try {
        const from = this.realPath(oldRemote);
        const to = this.realPath(newRemote);
        if (existsSync(to)) return this.status(reqId, STATUS_CODE.FAILURE);
        renameSync(from, to);
        this.status(reqId, STATUS_CODE.OK);
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("REALPATH", (reqId, remote) => {
      try {
        const resolved = path.posix.normalize(
          remote.startsWith("/") ? remote : `/${remote}`,
        );
        this.sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }]);
      } catch (err) {
        this.fail(reqId, err);
      }
    });

    this.sftp.on("EXTENDED", (reqId) => this.status(reqId, STATUS_CODE.OP_UNSUPPORTED));
    this.sftp.on("error", () => { /* client went away */ });
  }

  dispose(): void {
    for (const entry of this.files.values()) {
      try { closeSync(entry.fd); } catch { /* ignore */ }
    }
    this.files.clear();
    this.dirs.clear();
  }

  private realPath(remote: string): string {
    const clean = path.posix.normalize(remote.startsWith("/") ? remote : `/${remote}`);
    const full = path.resolve(this.options.root, `.${clean}`);
    if (full !== this.options.root && !full.startsWith(this.options.root + path.sep)) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return full;
  }

  private openMode(flags: number): string {
    if (flags & OPEN_MODE.EXCL) return flags & OPEN_MODE.CREAT ? "wx" : "rx";
    if (flags & OPEN_MODE.APPEND) return flags & OPEN_MODE.CREAT ? "a" : "a+";
    if (flags & (OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.WRITE)) {
      return flags & OPEN_MODE.READ ? "w+" : "w";
    }
    return "r";
  }

  private handleOf(id: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id, 0);
    return buf;
  }

  private newId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private delayed(fn: () => void): void {
    if (this.options.delayMs && this.options.delayMs > 0) {
      setTimeout(fn, this.options.delayMs);
    } else {
      fn();
    }
  }

  private status(reqId: number, code: number): void {
    this.sftp.status(reqId, code);
  }

  private fail(reqId: number, err: unknown): void {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return this.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    if (code === "EACCES" || code === "EPERM") {
      return this.status(reqId, STATUS_CODE.PERMISSION_DENIED);
    }
    this.status(reqId, STATUS_CODE.FAILURE);
  }
}
```

- [ ] **Step 4: Wire the fake into `FakeSshServer`**

In `tests/helpers/fake_ssh.ts`:

1. Add imports:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeSftp } from "./fake_sftp.js";
```

2. Extend `FakeSshOptions`:
```ts
  sftpDelayMs?: number;
  failRename?: boolean;
```

3. Change the class fields/constructor to carry the root and fakes:
```ts
  private constructor(
    readonly port: number,
    readonly hostKeyBase64: string,
    private readonly server: SshServer,
    private readonly clients: Connection[],
    private readonly sftpRootDir: string | null,
    private readonly fakes: FakeSftp[],
  ) {}
```

4. In `start`, create the root before constructing the server:
```ts
    const sftpRootDir = opts.allowSftp
      ? mkdtempSync(path.join(tmpdir(), "myssh-sftp-"))
      : null;
    const fakes: FakeSftp[] = [];
```

5. Replace the sftp handler:
```ts
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (!opts.allowSftp || !sftpRootDir) {
            rejectSftp();
            return;
          }
          const sftp = acceptSftp();
          fakes.push(new FakeSftp(sftp, {
            root: sftpRootDir,
            delayMs: opts.sftpDelayMs,
            failRename: opts.failRename,
          }));
        });
```

6. Return the extra fields:
```ts
    return new FakeSshServer(port, hostKeyBase64, server, clients, sftpRootDir, fakes);
```

7. Add the accessor and cleanup:
```ts
  get sftpRoot(): string {
    if (!this.sftpRootDir) throw new Error("sftp is disabled for this fake server");
    return this.sftpRootDir;
  }

  async close(): Promise<void> {
    for (const fake of this.fakes) fake.dispose();
    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.sftpRootDir) rmSync(this.sftpRootDir, { recursive: true, force: true });
  }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/sftp/fake_server.test.ts`
Expected: PASS (2 tests).

Run the existing suite to confirm no regression:
`npx vitest run`
Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/fake_sftp.ts tests/helpers/fake_ssh.ts tests/sftp/fake_server.test.ts
git commit -m "test: add protocol-level fake SFTP server"
```

---

### Task 2: SFTP types, atomic paths, streaming helpers, upload

**Files:**
- Create: `src/sftp/types.ts`, `src/sftp/paths.ts`, `src/sftp/stream.ts`, `src/sftp/client.ts`
- Test: `tests/sftp/client.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/sftp/client.test.ts` (upload + stat portion; download tests are appended in Task 3):

```ts
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { openSftp, type SftpClient } from "../../src/sftp/client.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

async function setup(fake: FakeSshOptions = { allowSftp: true }) {
  const server = await FakeSshServer.start(fake);
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-m4-"));
  cleanupFns.push(() => server.close(), async () => rm(dir, { recursive: true, force: true }));
  const client: Client = await new Dialer(
    new KnownHostsStore(path.join(dir, "known_hosts")),
  ).dial({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  cleanupFns.push(async () => client.end());
  const sftp = await openSftp(client);
  if (!sftp) throw new Error("sftp unavailable");
  cleanupFns.push(async () => sftp.close());
  return { server, dir, sftp: sftp as SftpClient };
}

async function localFile(dir: string, name: string, data: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
}

async function uploadFile(sftp: SftpClient, file: string, remote: string, timeoutMs = 0) {
  const { createReadStream } = await import("node:fs");
  return sftp.upload(createReadStream(file), remote, timeoutMs);
}

describe("SftpClient upload", () => {
  it("writes a file atomically and leaves no temp file behind", async () => {
    const { server, dir, sftp } = await setup();
    // Single-file upload does not create parent directories (Go parity).
    await sftp.mkdir("/upload");
    const file = await localFile(dir, "a.txt", "hello upload");
    const outcome = await uploadFile(sftp, file, "/upload/a.txt");

    expect(outcome.error).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.bytes).toBe(12);
    expect(await readFile(path.join(server.sftpRoot, "upload", "a.txt"), "utf8"))
      .toBe("hello upload");
    const leftovers = await import("node:fs/promises").then((fs) =>
      fs.readdir(path.join(server.sftpRoot, "upload")));
    expect(leftovers).toEqual(["a.txt"]);
  });

  it("overwrites an existing target", async () => {
    const { server, dir, sftp } = await setup();
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path.join(server.sftpRoot, "upload"), { recursive: true });
      await fs.writeFile(path.join(server.sftpRoot, "upload", "a.txt"), "old");
    });
    const file = await localFile(dir, "a.txt", "new");
    expect((await uploadFile(sftp, file, "/upload/a.txt")).error).toBeUndefined();
    expect(await readFile(path.join(server.sftpRoot, "upload", "a.txt"), "utf8")).toBe("new");
  });

  it("returns create-remote errors for a missing directory", async () => {
    const { dir, sftp } = await setup();
    const file = await localFile(dir, "a.txt", "x");
    const outcome = await uploadFile(sftp, file, "/nope/a.txt");
    expect(outcome.error?.message).toMatch(/^create remote .*\.sshmng-tmp-[0-9a-f]+: /);
    expect(outcome.bytes).toBe(0);
  });

  it("times out, reports partial bytes and removes the temp file", async () => {
    const { server, dir, sftp } = await setup({ allowSftp: true, sftpDelayMs: 200 });
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.join(server.sftpRoot, "upload"), { recursive: true }));
    const file = await localFile(dir, "big.bin", "x".repeat(200_000));
    const outcome = await uploadFile(sftp, file, "/upload/big.bin", 50);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toBeDefined();
    expect(await import("node:fs/promises").then((fs) =>
      fs.readdir(path.join(server.sftpRoot, "upload")))).toEqual([]);
  });

  it("reports missing-file stat errors with code 2", async () => {
    const { sftp } = await setup();
    await expect(sftp.stat("/missing")).rejects.toMatchObject({ code: 2 });
  });

  it("returns the unavailable error when the client is closed", async () => {
    const { sftp } = await setup();
    sftp.close();
    const { Readable } = await import("node:stream");
    const outcome = await sftp.upload(Readable.from([Buffer.from("x")]), "/x");
    expect(outcome.error?.message).toBe("sftp not available for this session");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sftp/client.test.ts`
Expected: FAIL — module `src/sftp/client.js` not found.

- [ ] **Step 3: Implement `src/sftp/types.ts`**

```ts
export const DEFAULT_TRANSFER_TIMEOUT_MS = 300_000;
export const SFTP_UNAVAILABLE = "sftp not available for this session";

export class SftpUnavailableError extends Error {
  constructor() {
    super(SFTP_UNAVAILABLE);
    this.name = "SftpUnavailableError";
  }
}

export interface TransferOutcome {
  bytes: number;
  timedOut: boolean;
  error?: Error;
}

export interface SftpStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export type ConflictPolicy = "overwrite" | "skip" | "rename";

export function parseConflictPolicy(value: string | undefined): ConflictPolicy {
  if (value === "skip") return "skip";
  if (value === "rename") return "rename";
  return "overwrite";
}

export interface DirTransferOptions {
  conflict?: ConflictPolicy;
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (bytes: number, files: number) => void;
}

export interface DirTransferResult {
  bytes: number;
  files: number;
  skipped: number;
  renamed: number;
  timedOut: number;
}

export interface DirTransferOutcome {
  result: DirTransferResult;
  error?: Error;
}

export function emptyDirResult(): DirTransferResult {
  return { bytes: 0, files: 0, skipped: 0, renamed: 0, timedOut: 0 };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Go's errors.Join: newline-separated messages in one Error. */
export function joinErrors(errors: Error[]): Error | undefined {
  if (errors.length === 0) return undefined;
  return new Error(errors.map(errorMessage).join("\n"));
}

export const DEFAULT_CONCURRENCY = 4;
```

- [ ] **Step 4: Implement `src/sftp/paths.ts`**

```ts
import { randomBytes } from "node:crypto";

/** `<remotePath>.sshmng-tmp-<6 hex>` (3 bytes, same as sshmng). */
export function atomicRemotePath(remotePath: string): string {
  return `${remotePath}.sshmng-tmp-${randomBytes(3).toString("hex")}`;
}

/** Temp file name for atomic local writes: `<base>.sshmng-tmp-<6 hex>`. */
export function localTempPath(localPath: string): string {
  return `${localPath}.sshmng-tmp-${randomBytes(3).toString("hex")}`;
}
```

- [ ] **Step 5: Implement `src/sftp/stream.ts`**

```ts
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

export interface PumpResult {
  bytes: number;
  timedOut: boolean;
  error?: Error;
}

function aborted(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("transfer aborted");
}

/** Wait for `drain`, or fail on error/abort. */
export function waitDrain(dst: Writable, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      dst.off("drain", onDrain);
      dst.off("error", onError);
      dst.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const onClose = (): void => {
      cleanup();
      reject(dst.errored ?? new Error("destination closed"));
    };
    const onAbort = (): void => { cleanup(); reject(aborted(signal)); };
    dst.once("drain", onDrain);
    dst.once("error", onError);
    dst.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pump `src` into `dst` with backpressure and abort support. Never ends `dst`;
 * the caller owns its lifecycle. Returns bytes successfully written.
 */
export async function pumpToWritable(
  src: Readable,
  dst: Writable,
  signal: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<number> {
  let bytes = 0;
  const onError = (): void => { /* consumed via iterator/finished */ };
  dst.on("error", onError);
  try {
    for await (const chunk of src) {
      if (signal.aborted) throw aborted(signal);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!dst.write(buf)) await waitDrain(dst, signal);
      if (dst.errored) throw dst.errored;
      bytes += buf.length;
      onBytes?.(bytes);
    }
    if (signal.aborted) throw aborted(signal);
    if (dst.errored) throw dst.errored;
    return bytes;
  } finally {
    dst.off("error", onError);
  }
}

/** End a writable and wait until all queued data is flushed. */
export async function finishWritable(dst: Writable): Promise<void> {
  if (dst.writableFinished) return;
  const finished = once(dst, "finish");
  const failed = once(dst, "error");
  dst.end();
  await Promise.race([finished, failed.then(([err]) => { throw err; })]);
}
```

- [ ] **Step 6: Implement `src/sftp/client.ts` (upload + stat + scaffolding)**

```ts
import { openSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { nullLogger, type Logger } from "../log.js";
import { atomicRemotePath, localTempPath } from "./paths.js";
import { finishWritable, pumpToWritable, type PumpResult } from "./stream.js";
import {
  DEFAULT_TRANSFER_TIMEOUT_MS,
  SFTP_UNAVAILABLE,
  SftpUnavailableError,
  errorMessage,
  type SftpStat,
  type TransferOutcome,
} from "./types.js";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const OPEN_SFTP_TIMEOUT_MS = 5_000;

function message(err: unknown): string {
  return errorMessage(err);
}

function statFrom(attrs: { mode?: number; size?: number }): SftpStat {
  const mode = attrs.mode ?? 0;
  const kind = mode & S_IFMT;
  return {
    size: attrs.size ?? 0,
    isDirectory: kind === S_IFDIR,
    isFile: kind === S_IFREG,
    isSymbolicLink: kind === S_IFLNK,
  };
}

function isNoSuchFile(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 2;
}

function openRemote(sftp: SFTPWrapper, path: string, flags: "r" | "w"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (err, handle) => (err ? reject(err) : resolve(handle)));
  });
}

function closeRemote(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      sftp.close(handle, () => resolve());
    } catch {
      resolve();
    }
  });
}

function unlinkRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.unlink(path, () => resolve());
  });
}

function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
}

/** Best-effort fsync via the OpenSSH extension; absent on most test servers. */
function fsyncRemote(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      sftp.ext_openssh_fsync(handle, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** PosixRename with Remove+Rename fallback. Returns the fallback error. */
async function posixRename(
  sftp: SFTPWrapper,
  from: string,
  to: string,
): Promise<{ posixError: Error } | null> {
  let posixError: Error;
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.ext_openssh_rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
    return null;
  } catch (err) {
    posixError = err instanceof Error ? err : new Error(String(err));
  }
  await unlinkRemote(sftp, to);
  try {
    await renameRemote(sftp, from, to);
    return null;
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      posixError,
    });
  }
}

/** Open a persistent SFTP subsystem channel; null when unavailable. */
export function openSftp(
  client: Client,
  logger: Logger = nullLogger,
  timeoutMs = OPEN_SFTP_TIMEOUT_MS,
): Promise<SftpClient | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: SftpClient | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      client.sftp((err, sftp) => {
        if (settled) {
          try { sftp?.end(); } catch { /* ignore */ }
          return;
        }
        if (err || !sftp) {
          logger.debug("sftp channel unavailable", { err: err ? err.message : "no client" });
          finish(null);
          return;
        }
        finish(new SftpClient(sftp, logger));
      });
    } catch (err) {
      logger.debug("sftp channel unavailable", { err: message(err) });
      finish(null);
    }
  });
}

export class SftpClient {
  private closed = false;

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly logger: Logger = nullLogger,
  ) {
    this.sftp.on("close", () => { this.closed = true; });
    this.sftp.on("error", () => { /* surfaced by individual operations */ });
  }

  get available(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.sftp.end(); } catch { /* ignore */ }
  }

  stat(remotePath: string): Promise<SftpStat> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.stat(remotePath, (err, st) => (
        err ? reject(err) : resolve(statFrom(st))
      ));
    });
  }

  lstat(remotePath: string): Promise<SftpStat> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.lstat(remotePath, (err, st) => (
        err ? reject(err) : resolve(statFrom(st))
      ));
    });
  }

  readdir(remotePath: string): Promise<Array<{ name: string; stat: SftpStat }>> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map((entry: FileEntryWithStats) => ({
          name: entry.filename,
          stat: statFrom(entry.attrs),
        })));
      });
    });
  }

  mkdir(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async upload(
    src: NodeJS.ReadableStream,
    remotePath: string,
    timeoutMs = 0,
  ): Promise<TransferOutcome> {
    if (!this.available) {
      return { bytes: 0, timedOut: false, error: new SftpUnavailableError() };
    }
    const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TRANSFER_TIMEOUT_MS;
    const tmpPath = atomicRemotePath(remotePath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(
      `transfer timed out after ${timeout}ms`,
    )), timeout);

    let handle: Buffer;
    try {
      handle = await openRemote(this.sftp, tmpPath, "w");
    } catch (err) {
      clearTimeout(timer);
      return {
        bytes: 0,
        timedOut: false,
        error: new Error(`create remote ${tmpPath}: ${message(err)}`),
      };
    }

    const ws = this.sftp.createWriteStream(tmpPath, { handle, autoClose: false });
    const onAbort = (): void => {
      try { ws.destroy(controller.signal.reason as Error); } catch { /* ignore */ }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let bytes = 0;
    let timedOut = false;
    let error: Error | undefined;
    try {
      bytes = await pumpToWritable(src, ws, controller.signal);
      ws.end();
      await finishWritable(ws);
    } catch (err) {
      timedOut = controller.signal.aborted;
      const pump = err as PumpError;
      bytes = typeof pump.bytes === "number" ? pump.bytes : bytes;
      error = err instanceof Error ? err : new Error(String(err));
      try { ws.destroy(); } catch { /* ignore */ }
      await closeRemote(this.sftp, handle);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }

    if (error) {
      await unlinkRemote(this.sftp, tmpPath);
      return { bytes, timedOut, error };
    }

    await fsyncRemote(this.sftp, handle);
    await closeRemote(this.sftp, handle);

    try {
      await posixRename(this.sftp, tmpPath, remotePath);
    } catch (err) {
      await unlinkRemote(this.sftp, tmpPath);
      const posixError = (err as { posixError?: Error }).posixError ?? err;
      return {
        bytes,
        timedOut: false,
        error: new Error(
          `rename ${tmpPath} -> ${remotePath}: ${message(err)} (posix: ${message(posixError)})`,
        ),
      };
    }
    this.logger.debug("sftp upload done", { remote: remotePath, bytes });
    return { bytes, timedOut: false };
  }
}
```

Note: `NodeJS.ReadableStream` is too loose for `pumpToWritable`; use `Readable` from `node:stream` in the signature and import it as a type. The executor should change `src: NodeJS.ReadableStream` to `src: import("node:stream").Readable` and remove the `as never`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/sftp/client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add src/sftp/types.ts src/sftp/paths.ts src/sftp/stream.ts src/sftp/client.ts tests/sftp/client.test.ts
git commit -m "feat(sftp): add SftpClient with atomic uploads"
```

---

### Task 3: Download and DownloadToFile

**Files:**
- Modify: `src/sftp/client.ts`
- Test: `tests/sftp/client.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/sftp/client.test.ts`:

```ts
describe("SftpClient download", () => {
  it("downloads a remote file into a writable", async () => {
    const { server, sftp } = await setup();
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path.join(server.sftpRoot, "d"), { recursive: true });
      await fs.writeFile(path.join(server.sftpRoot, "d", "a.txt"), "downloaded");
    });
    const chunks: Buffer[] = [];
    const { Writable } = await import("node:stream");
    const dst = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    const outcome = await sftp.download("/d/a.txt", dst);
    expect(outcome).toEqual({ bytes: 10, timedOut: false });
    expect(Buffer.concat(chunks).toString()).toBe("downloaded");
  });

  it("reports open-remote errors", async () => {
    const { sftp } = await setup();
    const { Writable } = await import("node:stream");
    const outcome = await sftp.download("/missing", new Writable({
      write(_c, _e, cb) { cb(); },
    }));
    expect(outcome.bytes).toBe(0);
    expect(outcome.error?.message).toMatch(/^open remote \/missing: /);
  });

  it("downloads atomically to a local file and cleans the temp", async () => {
    const { server, dir, sftp } = await setup();
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(server.sftpRoot, "remote.txt"), "atomic"));
    const target = path.join(dir, "local.txt");
    const outcome = await sftp.downloadToFile("/remote.txt", target);
    expect(outcome).toEqual({ bytes: 6, timedOut: false });
    expect(await readFile(target, "utf8")).toBe("atomic");
    const names = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    expect(names.filter((name) => name.includes(".sshmng-tmp-"))).toEqual([]);
  });

  it("times out without leaving a half-written local file", async () => {
    const { server, dir, sftp } = await setup({ allowSftp: true, sftpDelayMs: 200 });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(server.sftpRoot, "big.bin"), "x".repeat(100_000)));
    const target = path.join(dir, "big.bin");
    const outcome = await sftp.downloadToFile("/big.bin", target, 50);
    expect(outcome.timedOut).toBe(true);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

Also add `import { stat } from "node:fs/promises";` at the top (replace the existing import line with `import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sftp/client.test.ts -t "download"`
Expected: FAIL — `sftp.download is not a function`.

- [ ] **Step 3: Implement `download` and `downloadToFile` in `SftpClient`**

Add imports: `createReadStream` from `node:fs`, `Readable, Writable` types from `node:stream`.

```ts
  async download(
    remotePath: string,
    dst: import("node:stream").Writable,
    timeoutMs = 0,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome> {
    if (!this.available) {
      return { bytes: 0, timedOut: false, error: new SftpUnavailableError() };
    }
    const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TRANSFER_TIMEOUT_MS;
    // Pre-open the handle so "open remote" failures are synchronous from the
    // caller's perspective, exactly like Go's `sftpClient.Open`.
    let handle: Buffer;
    try {
      handle = await openRemote(this.sftp, remotePath, "r");
    } catch (err) {
      return {
        bytes: 0,
        timedOut: false,
        error: new Error(`open remote ${remotePath}: ${message(err)}`),
      };
    }
    const src = this.sftp.createReadStream(remotePath, { handle, autoClose: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(
      `transfer timed out after ${timeout}ms`,
    )), timeout);
    const onError = (): void => { /* surfaced by pump */ };
    src.on("error", onError);
    const onAbort = (): void => {
      try { src.destroy(controller.signal.reason as Error); } catch { /* ignore */ }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const bytes = await pumpToWritable(src, dst, controller.signal, onBytes);
      return { bytes, timedOut: false };
    } catch (err) {
      const timedOut = controller.signal.aborted;
      return {
        bytes: 0,
        timedOut,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      src.off("error", onError);
      try { src.destroy(); } catch { /* ignore */ }
    }
  }
```

Important: pump's returned byte count is lost on error. Change `pumpToWritable` to throw an error carrying `bytes`:

In `stream.ts`, add:

```ts
export class PumpError extends Error {
  constructor(message: string, readonly bytes: number, readonly cause?: Error) {
    super(message);
  }
}
```

and in `pumpToWritable`, wrap the body:

```ts
  let bytes = 0;
  try {
    for await (const chunk of src) { ... }
    return bytes;
  } catch (err) {
    throw new PumpError(err instanceof Error ? err.message : String(err), bytes, err instanceof Error ? err : undefined);
  }
```

Then in upload's catch use `(err as PumpError).bytes` to report partial bytes, and in download:

```ts
    } catch (err) {
      const pump = err as PumpError;
      return {
        bytes: pump.bytes,
        timedOut: controller.signal.aborted,
        error: pump,
      };
    }
```

`downloadToFile`:

```ts
  async downloadToFile(
    remotePath: string,
    localPath: string,
    timeoutMs = 0,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome> {
    const tmpPath = localTempPath(localPath);
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(tmpPath, "wx");
    } catch (err) {
      return {
        bytes: 0,
        timedOut: false,
        error: new Error(`create temp for ${localPath}: ${message(err)}`),
      };
    }
    let removed = false;
    const cleanup = async (): Promise<void> => {
      if (removed) return;
      removed = true;
      try { await fh.close(); } catch { /* ignore */ }
      try { await (await import("node:fs/promises")).unlink(tmpPath); } catch { /* ignore */ }
    };
    try {
      const ws = fh.createWriteStream({ autoClose: false });
      const outcome = await this.download(remotePath, ws, timeoutMs, onBytes);
      try {
        await finishWritable(ws);
      } catch (err) {
        if (!outcome.error) {
          return { ...outcome, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }
      if (outcome.error || outcome.timedOut) {
        await cleanup();
        return outcome;
      }
      try { await fh.close(); } catch { /* ignore */ }
      try {
        await (await import("node:fs/promises")).rename(tmpPath, localPath);
      } catch (err) {
        await cleanup();
        return {
          bytes: outcome.bytes,
          timedOut: false,
          error: new Error(`rename temp -> ${localPath}: ${message(err)}`),
        };
      }
      removed = true;
      return outcome;
    } catch (err) {
      await cleanup();
      return { bytes: 0, timedOut: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
```

Replace the dynamic import with a static `import { rename, unlink } from "node:fs/promises";` at the top (the executor should hoist it).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sftp/client.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sftp/client.ts src/sftp/stream.ts tests/sftp/client.test.ts
git commit -m "feat(sftp): add download and atomic downloadToFile"
```

---

### Task 4: Directory transfer

**Files:**
- Create: `src/sftp/dir.ts`
- Test: `tests/sftp/dir.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/sftp/dir.test.ts`:

```ts
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { openSftp } from "../../src/sftp/client.js";
import { uploadDir, downloadDir } from "../../src/sftp/dir.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

async function setup(fake: FakeSshOptions = { allowSftp: true }) {
  const server = await FakeSshServer.start(fake);
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-dir-"));
  cleanupFns.push(() => server.close(), async () => rm(dir, { recursive: true, force: true }));
  const client: Client = await new Dialer(
    new KnownHostsStore(path.join(dir, "known_hosts")),
  ).dial({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  cleanupFns.push(async () => client.end());
  const sftp = await openSftp(client);
  if (!sftp) throw new Error("sftp unavailable");
  cleanupFns.push(async () => sftp.close());
  return { server, dir, sftp };
}

async function makeTree(root: string): Promise<void> {
  await mkdir(path.join(root, "sub", "deep"), { recursive: true });
  await writeFile(path.join(root, "a.txt"), "alpha");
  await writeFile(path.join(root, "sub", "b.txt"), "bravo");
  await writeFile(path.join(root, "sub", "deep", "c.txt"), "charlie");
  await symlink("/etc/hostname", path.join(root, "link"));
}

async function remoteTree(root: string): Promise<void> {
  await mkdir(path.join(root, "sub", "deep"), { recursive: true });
  await writeFile(path.join(root, "a.txt"), "alpha");
  await writeFile(path.join(root, "sub", "b.txt"), "bravo");
  await writeFile(path.join(root, "sub", "deep", "c.txt"), "charlie");
  await symlink("/etc/hostname", path.join(root, "link"));
}

describe("uploadDir", () => {
  it("uploads a nested tree, creates dirs, skips symlinks", async () => {
    const { server, dir, sftp } = await setup();
    const local = path.join(dir, "tree");
    await makeTree(local);
    const outcome = await uploadDir(sftp, local, "/remote/tree");

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({ bytes: 5 + 5 + 7, files: 3, skipped: 0, renamed: 0, timedOut: 0 });
    expect(await readFile(path.join(server.sftpRoot, "remote/tree/a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(path.join(server.sftpRoot, "remote/tree/sub/deep/c.txt"), "utf8")).toBe("charlie");
    expect(await readdir(path.join(server.sftpRoot, "remote/tree"))).not.toContain("link");
  });

  it("overwrites by default", async () => {
    const { server, dir, sftp } = await setup();
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    const local = path.join(dir, "tree");
    await mkdir(local);
    await writeFile(path.join(local, "a.txt"), "new");
    const outcome = await uploadDir(sftp, local, "/r");
    expect(outcome.error).toBeUndefined();
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("new");
    expect(outcome.result.files).toBe(1);
  });

  it("skips existing files with conflict=skip", async () => {
    const { server, dir, sftp } = await setup();
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    const local = path.join(dir, "tree");
    await mkdir(local);
    await writeFile(path.join(local, "a.txt"), "new");
    const outcome = await uploadDir(sftp, local, "/r", { conflict: "skip" });
    expect(outcome.result).toEqual({ bytes: 0, files: 0, skipped: 1, renamed: 0, timedOut: 0 });
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("old");
  });

  it("renames to name_1.ext with conflict=rename", async () => {
    const { server, dir, sftp } = await setup();
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    await writeFile(path.join(server.sftpRoot, "r/a_1.txt"), "older");
    const local = path.join(dir, "tree");
    await mkdir(local);
    await writeFile(path.join(local, "a.txt"), "new");
    const outcome = await uploadDir(sftp, local, "/r", { conflict: "rename" });
    expect(outcome.result.renamed).toBe(1);
    expect(outcome.result.files).toBe(1);
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("old");
    expect(await readFile(path.join(server.sftpRoot, "r/a_1.txt"), "utf8")).toBe("older");
    expect(await readFile(path.join(server.sftpRoot, "r/a_2.txt"), "utf8")).toBe("new");
  });

  it("counts per-file timeouts and returns an aggregated error", async () => {
    const { dir, sftp } = await setup({ allowSftp: true, sftpDelayMs: 200 });
    const local = path.join(dir, "tree");
    await makeTree(local);
    const outcome = await uploadDir(sftp, local, "/slow", { timeoutMs: 50 });
    expect(outcome.result.timedOut).toBe(3);
    expect(outcome.result.files).toBe(0);
    expect(outcome.error?.message).toContain("timed out");
  });

  it("rejects a local path that is not a directory", async () => {
    const { dir, sftp } = await setup();
    const file = path.join(dir, "file");
    await writeFile(file, "x");
    const outcome = await uploadDir(sftp, file, "/x");
    expect(outcome.error?.message).toBe("local path is not a directory");
  });
});

describe("downloadDir", () => {
  it("downloads a nested tree, creates dirs, skips symlinks", async () => {
    const { server, dir, sftp } = await setup();
    await remoteTree(path.join(server.sftpRoot, "remote"));
    const local = path.join(dir, "out");
    const outcome = await downloadDir(sftp, "/remote", local);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({ bytes: 5 + 5 + 7, files: 3, skipped: 0, renamed: 0, timedOut: 0 });
    expect(await readFile(path.join(local, "sub", "deep", "c.txt"), "utf8")).toBe("charlie");
    await expect(lstat(path.join(local, "link"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips existing local files with conflict=skip", async () => {
    const { server, dir, sftp } = await setup();
    await writeFile(path.join(server.sftpRoot, "a.txt"), "remote");
    const local = path.join(dir, "out");
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, "a.txt"), "local");
    const outcome = await downloadDir(sftp, "/a.txt", local);
    expect(outcome.result.skipped).toBe(0); // remote path is a file, not a dir

    const dirOutcome = await downloadDir(sftp, "/", local, { conflict: "skip" });
    expect(dirOutcome.result.skipped).toBe(1);
    expect(await readFile(path.join(local, "a.txt"), "utf8")).toBe("local");
  });

  it("renames locally with conflict=rename", async () => {
    const { server, dir, sftp } = await setup();
    await writeFile(path.join(server.sftpRoot, "a.txt"), "remote");
    const local = path.join(dir, "out");
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, "a.txt"), "local");
    const outcome = await downloadDir(sftp, "/", local, { conflict: "rename" });
    expect(outcome.result.renamed).toBeGreaterThanOrEqual(1);
    expect(await readFile(path.join(local, "a.txt"), "utf8")).toBe("local");
    expect(await readFile(path.join(local, "a_1.txt"), "utf8")).toBe("remote");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sftp/dir.test.ts`
Expected: FAIL — module `src/sftp/dir.js` not found.

- [ ] **Step 3: Implement `src/sftp/dir.ts`**

First add `isNoSuchFile` to `src/sftp/types.ts` so both client and dir can use it:

```ts
export function isNoSuchFile(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 2;
}
```

Then:

```ts
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_CONCURRENCY,
  SftpUnavailableError,
  emptyDirResult,
  errorMessage,
  isNoSuchFile,
  joinErrors,
  type ConflictPolicy,
  type DirTransferOptions,
  type DirTransferOutcome,
  type DirTransferResult,
  type SftpStat,
  type SftpTransfer,
} from "./types.js";

type ConflictAction = "overwrite" | "skip" | "rename";

interface ResolvedConflict {
  path: string;
  action: ConflictAction;
}

interface FileTask {
  localPath: string;
  remotePath: string;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Remote mkdir -p. Existing directories are not an error. */
export async function mkdirRemoteAll(
  backend: SftpTransfer,
  remotePath: string,
): Promise<void> {
  const norm = path.posix.normalize(remotePath);
  if (norm === "." || norm === "/" || norm === "") return;
  const parts = norm.split("/").filter(Boolean);
  let current = norm.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    try {
      await backend.mkdir(current);
    } catch (err) {
      let existing: SftpStat | undefined;
      try {
        existing = await backend.stat(current);
      } catch {
        throw err;
      }
      if (!existing.isDirectory) throw err;
    }
  }
}

async function resolveRemoteConflict(
  backend: SftpTransfer,
  remotePath: string,
  policy: ConflictPolicy,
): Promise<ResolvedConflict> {
  if (policy === "overwrite") return { path: remotePath, action: "overwrite" };

  let exists = false;
  let statError: Error | undefined;
  try {
    await backend.stat(remotePath);
    exists = true;
  } catch (err) {
    if (isNoSuchFile(err)) exists = false;
    else statError = toError(err);
  }
  if (statError) throw statError;
  if (!exists) return { path: remotePath, action: "overwrite" };
  if (policy === "skip") return { path: remotePath, action: "skip" };

  const dir = path.posix.dirname(remotePath);
  const base = path.posix.basename(remotePath);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  for (let index = 1; ; index += 1) {
    const candidate = path.posix.join(dir, `${stem}_${index}${ext}`);
    try {
      await backend.stat(candidate);
    } catch (err) {
      if (isNoSuchFile(err)) return { path: candidate, action: "rename" };
      throw err;
    }
  }
}

async function resolveLocalConflict(
  localPath: string,
  policy: ConflictPolicy,
): Promise<ResolvedConflict> {
  if (policy === "overwrite") return { path: localPath, action: "overwrite" };

  let exists = false;
  let statError: Error | undefined;
  try {
    await stat(localPath);
    exists = true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") exists = false;
    else statError = toError(err);
  }
  if (statError) throw statError;
  if (!exists) return { path: localPath, action: "overwrite" };
  if (policy === "skip") return { path: localPath, action: "skip" };

  const dir = path.dirname(localPath);
  const base = path.basename(localPath);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  for (let index = 1; ; index += 1) {
    const candidate = path.join(dir, `${stem}_${index}${ext}`);
    try {
      await stat(candidate);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return { path: candidate, action: "rename" };
      }
      throw err;
    }
  }
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  }));
}

export async function uploadDir(
  backend: SftpTransfer,
  localDir: string,
  remoteDir: string,
  options: DirTransferOptions = {},
): Promise<DirTransferOutcome> {
  const result = emptyDirResult();
  if (!backend.available) {
    return { result, error: new SftpUnavailableError() };
  }

  let rootStat;
  try {
    rootStat = await stat(localDir);
  } catch (err) {
    return { result, error: toError(err) };
  }
  if (!rootStat.isDirectory()) {
    return { result, error: new Error("local path is not a directory") };
  }

  const conflict = options.conflict ?? "overwrite";
  const concurrency = options.concurrency && options.concurrency > 0
    ? options.concurrency
    : DEFAULT_CONCURRENCY;
  const errors: Error[] = [];

  try {
    await mkdirRemoteAll(backend, remoteDir);
  } catch (err) {
    errors.push(toError(err));
  }

  const tasks: FileTask[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    for (const entry of entries) {
      const localPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const remotePath = path.posix.join(remoteDir, relPath);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try {
          await mkdirRemoteAll(backend, remotePath);
        } catch (err) {
          errors.push(toError(err));
        }
        await visit(localPath, relPath);
      } else {
        tasks.push({ localPath, remotePath });
      }
    }
  }
  await visit(localDir, "");

  await runPool(tasks, concurrency, async (task) => {
    let fh;
    try {
      fh = await open(task.localPath, "r");
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    try {
      let resolved: ResolvedConflict;
      try {
        resolved = await resolveRemoteConflict(backend, task.remotePath, conflict);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
      if (resolved.action === "skip") {
        result.skipped += 1;
        return;
      }
      if (resolved.action === "rename") result.renamed += 1;

      const source = fh.createReadStream({ autoClose: true }) as unknown as Readable;
      const outcome = await backend.upload(source, resolved.path, options.timeoutMs ?? 0);
      try { source.destroy(); } catch { /* ignore */ }
      if (outcome.error) {
        errors.push(outcome.error);
      } else {
        result.bytes += outcome.bytes;
        result.files += 1;
        options.onProgress?.(result.bytes, result.files);
      }
      if (outcome.timedOut) result.timedOut += 1;
    } finally {
      try { await fh.close(); } catch { /* stream may have closed it */ }
    }
  });

  return { result, error: joinErrors(errors) };
}

export async function downloadDir(
  backend: SftpTransfer,
  remoteDir: string,
  localDir: string,
  options: DirTransferOptions = {},
): Promise<DirTransferOutcome> {
  const result = emptyDirResult();
  if (!backend.available) {
    return { result, error: new SftpUnavailableError() };
  }

  const conflict = options.conflict ?? "overwrite";
  const concurrency = options.concurrency && options.concurrency > 0
    ? options.concurrency
    : DEFAULT_CONCURRENCY;
  const errors: Error[] = [];
  const tasks: FileTask[] = [];

  async function visit(
    remotePath: string,
    rel: string,
    known?: SftpStat,
  ): Promise<void> {
    let st = known;
    if (!st) {
      try {
        st = await backend.lstat(remotePath);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
    }
    if (st.isSymbolicLink) return;
    const localPath = rel ? path.join(localDir, rel) : localDir;
    if (st.isDirectory) {
      try {
        await mkdir(localPath, { recursive: true, mode: 0o755 });
      } catch (err) {
        errors.push(toError(err));
      }
      let entries;
      try {
        entries = await backend.readdir(remotePath);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        await visit(
          path.posix.join(remotePath, entry.name),
          rel ? `${rel}/${entry.name}` : entry.name,
          entry.stat,
        );
      }
      return;
    }
    tasks.push({ localPath, remotePath });
  }
  await visit(remoteDir, "");

  await runPool(tasks, concurrency, async (task) => {
    let resolved: ResolvedConflict;
    try {
      resolved = await resolveLocalConflict(task.localPath, conflict);
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    if (resolved.action === "skip") {
      result.skipped += 1;
      return;
    }
    if (resolved.action === "rename") result.renamed += 1;

    const outcome = await backend.downloadToFile(
      task.remotePath,
      resolved.path,
      options.timeoutMs ?? 0,
    );
    if (outcome.error) {
      errors.push(outcome.error);
    } else {
      result.bytes += outcome.bytes;
      result.files += 1;
      options.onProgress?.(result.bytes, result.files);
    }
    if (outcome.timedOut) result.timedOut += 1;
  });

  return { result, error: joinErrors(errors) };
}
```

Add `available`, `lstat`, `readdir`, `mkdir`, `downloadToFile` to `SftpTransfer` in `types.ts`:

```ts
import type { Readable, Writable } from "node:stream";

export interface SftpTransfer {
  readonly available: boolean;
  stat(remotePath: string): Promise<SftpStat>;
  lstat(remotePath: string): Promise<SftpStat>;
  readdir(remotePath: string): Promise<Array<{ name: string; stat: SftpStat }>>;
  mkdir(remotePath: string): Promise<void>;
  upload(src: Readable, remotePath: string, timeoutMs?: number): Promise<TransferOutcome>;
  download(
    remotePath: string,
    dst: Writable,
    timeoutMs?: number,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome>;
  downloadToFile(
    remotePath: string,
    localPath: string,
    timeoutMs?: number,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome>;
}
```

`SftpClient` already satisfies this structurally; declare `implements SftpTransfer` for compile-time checking.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sftp/dir.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sftp/dir.ts src/sftp/types.ts tests/sftp/dir.test.ts
git commit -m "feat(sftp): add directory transfers with conflict policies"
```

---

### Task 5: Sessions and login integration

**Files:**
- Modify: `src/pty/transport.ts`, `src/ssh/login.ts`, `src/session/session.ts`, `src/session/manager.ts` (registration only later), `src/mcp/tools_session.ts`
- Modify: `tests/pty/pty_loginflow.test.ts`
- Test: `tests/sftp/session_sftp.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/sftp/session_sftp.test.ts`:

```ts
import { Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { setupDirect } from "../../src/ssh/login.js";
import { Session, type SessionConn } from "../../src/session/session.js";
import type { SftpTransfer, SftpStat, TransferOutcome } from "../../src/sftp/types.js";
import { Dialer } from "../../src/ssh/dialer.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";
import { tempDir } from "../helpers/config.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function fakeConn(): SessionConn {
  return {
    mode: "shell",
    async run() {
      return {
        output: "", exitCode: 0, timedOut: false, truncated: false,
        totalBytes: 0, rawOutput: "", ctrlCSent: false, connUnusable: false,
      };
    },
    async sendRaw() {},
    async readRaw() { return { output: "", more: false }; },
    close() {},
  };
}

function fakeSftp(overrides: Partial<SftpTransfer> = {}): SftpTransfer {
  return {
    available: true,
    async stat(): Promise<SftpStat> {
      return { size: 0, isDirectory: false, isFile: true, isSymbolicLink: false };
    },
    async lstat(): Promise<SftpStat> {
      return { size: 0, isDirectory: false, isFile: true, isSymbolicLink: false };
    },
    async readdir() { return []; },
    async mkdir() {},
    async upload(): Promise<TransferOutcome> { return { bytes: 0, timedOut: false }; },
    async download(): Promise<TransferOutcome> { return { bytes: 0, timedOut: false }; },
    async downloadToFile(): Promise<TransferOutcome> { return { bytes: 0, timedOut: false }; },
    ...overrides,
  };
}

describe("Session sftp state machine", () => {
  it("marks the session running during a transfer and idle afterwards", async () => {
    let release!: (value: TransferOutcome) => void;
    const pending = new Promise<TransferOutcome>((resolve) => { release = resolve; });
    const sftp = fakeSftp({ upload: () => pending });
    const session = new Session("s1", "srv", fakeConn(), { sftp });

    const running = session.upload(Readable.from([Buffer.from("x")]), "/x");
    expect(session.state).toBe("running");
    release({ bytes: 1, timedOut: false });
    await expect(running).resolves.toEqual({ bytes: 1, timedOut: false });
    expect(session.state).toBe("idle");
  });

  it("rejects transfers while busy or closed", async () => {
    let release!: (value: TransferOutcome) => void;
    let releaseRun!: () => void;
    const conn = fakeConn();
    conn.run = () => new Promise((resolve) => {
      releaseRun = () => resolve({
        output: "", exitCode: 0, timedOut: false, truncated: false,
        totalBytes: 0, rawOutput: "", ctrlCSent: false, connUnusable: false,
      });
    });
    const session = new Session("s1", "srv", conn, { sftp: fakeSftp() });
    const run = session.run("sleep", 0, 0);
    await expect(session.upload(Readable.from([Buffer.from("x")]), "/x"))
      .rejects.toThrow("session busy");
    releaseRun();
    await run;
    session.close();
    await expect(session.upload(Readable.from([Buffer.from("x")]), "/x"))
      .rejects.toThrow("session closed");
  });

  it("returns the unavailable error without throwing for sftp operations", async () => {
    const session = new Session("s1", "srv", fakeConn(), { sftp: null });
    const outcome = await session.upload(Readable.from([Buffer.from("x")]), "/x");
    expect(outcome.error?.message).toBe("sftp not available for this session");
    const dir = await session.uploadDir("/tmp/nope", "/x");
    expect(dir.error?.message).toBe("sftp not available for this session");
  });

  it("closes the sftp client with the session", () => {
    let closed = false;
    const session = new Session("s1", "srv", fakeConn(), {
      sftp: fakeSftp({ close: () => { closed = true; } }),
    });
    session.close();
    expect(closed).toBe(true);
  });
});

describe("setupDirect sftp", () => {
  async function setupClient() {
    const server = await FakeSshServer.start({ allowSftp: true });
    const temp = await tempDir();
    const dir = temp.dir;
    cleanupFns.push(() => server.close(), temp.cleanup);
    const dialer = new Dialer(new KnownHostsStore(path.join(dir, "known_hosts")));
    return { server, dir, dialer };
  }

  it("returns a persistent sftp client and keeps it usable", async () => {
    const { server, dir, dialer } = await setupClient();
    const setup = await setupDirect({
      server: {
        name: "local", addr: server.addr, user: "test", auth: { password: "secret" },
      } as never,
      sid: "s1",
      knownHosts: new KnownHostsStore(path.join(dir, "known_hosts")),
    });
    cleanupFns.push(async () => { setup.conn.close(); setup.sftp?.close(); });
    expect(setup.sftpAvailable).toBe(true);
    expect(setup.sftp).not.toBeNull();
    await writeFile(path.join(server.sftpRoot, "a.txt"), "via-sftp");
    const chunks: Buffer[] = [];
    const outcome = await setup.sftp!.download("/a.txt", new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }));
    expect(outcome.bytes).toBe(8);
    expect(Buffer.concat(chunks).toString()).toBe("via-sftp");
  });
});
```

The `dialer` variable is unused; drop it from the helper or use it. Keep the helper returning only `{ server, dir }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sftp/session_sftp.test.ts`
Expected: FAIL — `Session` has no `upload`/`uploadDir`; `session.close` does not close sftp; `setup.sftp` missing.

- [ ] **Step 3: Remove the probe-only transport method**

In `src/pty/transport.ts`, delete `probeSftp(): Promise<boolean>;`.

In `src/ssh/login.ts`:
- Delete `SFTP_PROBE_TIMEOUT_MS` and the `probeSftp` method from `SshChannelTransport`.
- Import `openSftp, type SftpClient` from `../sftp/client.js`.

- [ ] **Step 4: Open the persistent client in setupDirect / setupPatternA**

`SetupResult`:

```ts
export interface SetupResult {
  conn: PtyConn;
  loginTrace: LoginTraceEntry[];
  sftpAvailable: boolean;
  sftp: SftpClient | null;
}
```

At the end of `setupDirect` (replacing `probeSftp`):

```ts
  const sftp = await openSftp(client, logger);
  return { conn, loginTrace, sftpAvailable: sftp !== null, sftp };
```

At the end of `setupPatternA` (target client):

```ts
  const sftp = await openSftp(targetClient, logger);
  return { conn, loginTrace, sftpAvailable: sftp !== null, sftp };
```

At the end of `setupPatternB`:

```ts
  return { conn, loginTrace, sftpAvailable: false, sftp: null };
```

- [ ] **Step 5: Update `tests/pty/pty_loginflow.test.ts`**

Delete the `probeSftp()` method from `ManualTransport`.

- [ ] **Step 6: Add sftp ownership and transfer methods to `Session`**

In `src/session/session.ts`:

Add imports:

```ts
import { emptyDirResult, SftpUnavailableError, type DirTransferOptions, type DirTransferOutcome, type SftpStat, type SftpTransfer, type TransferOutcome } from "../sftp/types.js";
import { downloadDir, uploadDir } from "../sftp/dir.js";
import type { Readable, Writable } from "node:stream";
```

`SessionOptions` gains `sftp?: SftpTransfer | null;` and keep `sftpAvailable?: boolean`.

Constructor fields:

```ts
  private readonly sftpClient: SftpTransfer | null;
```

```ts
    this.sftpClient = options.sftp ?? null;
    this.sftpAvail = options.sftpAvailable ?? this.sftpClient?.available ?? false;
```

Add methods:

```ts
  async sftpStat(remotePath: string): Promise<SftpStat> {
    return this.withTransfer(async (sftp) => {
      if (!this.sftpAvail || !sftp) throw new SftpUnavailableError();
      return sftp.stat(remotePath);
    });
  }

  async upload(src: Readable, remotePath: string, timeoutMs = 0): Promise<TransferOutcome> {
    return this.withTransfer(async (sftp) => {
      if (!this.sftpAvail || !sftp) {
        return { bytes: 0, timedOut: false, error: new SftpUnavailableError() };
      }
      return sftp.upload(src, remotePath, timeoutMs);
    });
  }

  async download(
    remotePath: string,
    dst: Writable,
    timeoutMs = 0,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome> {
    return this.withTransfer(async (sftp) => {
      if (!this.sftpAvail || !sftp) {
        return { bytes: 0, timedOut: false, error: new SftpUnavailableError() };
      }
      return sftp.download(remotePath, dst, timeoutMs, onBytes);
    });
  }

  async uploadDir(
    localDir: string,
    remoteDir: string,
    options: DirTransferOptions = {},
  ): Promise<DirTransferOutcome> {
    return this.withTransfer(async (sftp) => {
      if (!this.sftpAvail || !sftp) {
        return { result: emptyDirResult(), error: new SftpUnavailableError() };
      }
      return uploadDir(sftp, localDir, remoteDir, options);
    });
  }

  async downloadDir(
    remoteDir: string,
    localDir: string,
    options: DirTransferOptions = {},
  ): Promise<DirTransferOutcome> {
    return this.withTransfer(async (sftp) => {
      if (!this.sftpAvail || !sftp) {
        return { result: emptyDirResult(), error: new SftpUnavailableError() };
      }
      return downloadDir(sftp, remoteDir, localDir, options);
    });
  }

  private async withTransfer<T>(
    fn: (sftp: SftpTransfer | null) => Promise<T>,
  ): Promise<T> {
    this.requireIdle();
    this.state = "running";
    this.stopIdleTimer();
    try {
      return await fn(this.sftpClient);
    } finally {
      this.lastActivity = this.now();
      if (!this.isClosed()) {
        this.state = "idle";
        this.resetIdleTimer();
      }
    }
  }
```

Note: `requireIdle()` throws synchronously inside an async method → rejected promise. Good.

In `close()`, close sftp before the conn:

```ts
    try {
      this.sftpClient?.close();
    } catch (err) {
      this.logger.warn("close session sftp", {
        sid: this.sid,
        err: err instanceof Error ? err.message : String(err),
      });
    }
```

- [ ] **Step 7: Pass the client from the login tool**

In `src/mcp/tools_session.ts`, `newSession` options gain:

```ts
      sftp: setup.sftp,
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/sftp/session_sftp.test.ts tests/pty/pty_loginflow.test.ts tests/mcp/session_tools.test.ts tests/mcp/session_security.test.ts`
Expected: PASS. `session_security` still asserts `sftp_available: true` because the fake now speaks SFTP.

Run the full suite: `npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/pty/transport.ts src/ssh/login.ts src/session/session.ts src/mcp/tools_session.ts tests/pty/pty_loginflow.test.ts tests/sftp/session_sftp.test.ts
git commit -m "feat(session): own persistent sftp client and transfer state machine"
```

---

### Task 6: MCP upload/download tools

**Files:**
- Create: `src/mcp/tools_file.ts`
- Modify: `src/mcp/server.ts` (register the two tools)
- Test: `tests/mcp/file_tools.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/mcp/file_tools.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text,
    json: () => JSON.parse(text),
  };
}

async function startApp(fake: FakeSshOptions = { allowSftp: true }) {
  const server = await FakeSshServer.start(fake);
  const temp = await tempDir();
  const local = await mkdtemp(path.join(tmpdir(), "myssh-mcp-file-"));
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [{
      name: "local",
      addr: server.addr,
      user: "test",
      auth: { password: "secret" },
    }],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(new Service(new Store(file)));
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanupFns.push(
    () => server.close(),
    temp.cleanup,
    async () => rm(local, { recursive: true, force: true }),
  );
  return { server, client, local };
}

describe("upload/download MCP tools", () => {
  it("uploads a local file and downloads it back", async () => {
    const { server, client, local } = await startApp();
    const login = await call(client, "login", { name: "local" });
    const sid = login.json().sid;

    const src = path.join(local, "upload.txt");
    await writeFile(src, "through-mcp");
    const upload = await call(client, "upload", { sid, src, dst: "/up.txt" });
    expect(upload.isError).toBe(false);
    expect(upload.json()).toEqual({
      sid, ok: true, bytes: 11, timed_out: false, remote_url: "/up.txt",
    });
    expect(await readFile(path.join(server.sftpRoot, "up.txt"), "utf8")).toBe("through-mcp");

    const dst = path.join(local, "download.txt");
    const download = await call(client, "download", { sid, src: "/up.txt", dst });
    expect(download.isError).toBe(false);
    expect(download.json()).toEqual({
      sid, ok: true, bytes: 11, timed_out: false, local_url: dst,
    });
    expect(await readFile(dst, "utf8")).toBe("through-mcp");
  });

  it("reports open/create local errors with sshmng prefixes", async () => {
    const { client, local } = await startApp();
    const sid = (await call(client, "login", { name: "local" })).json().sid;

    const missing = await call(client, "upload", {
      sid, src: path.join(local, "missing"), dst: "/x",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^open local .*missing: /);

    const badDst = await call(client, "download", {
      sid, src: "/x", dst: path.join(local, "no-such-dir", "x"),
    });
    expect(badDst.isError).toBe(true);
    expect(badDst.text).toMatch(/^create local .*: /);
  });

  it("returns an error when sftp is unavailable", async () => {
    const { client, local } = await startApp({ allowSftp: false });
    const login = await call(client, "login", { name: "local" });
    expect(login.json().sftp_available).toBe(false);
    const src = path.join(local, "a.txt");
    await writeFile(src, "x");
    const upload = await call(client, "upload", {
      sid: login.json().sid, src, dst: "/x",
    });
    expect(upload.isError).toBe(true);
    expect(upload.text).toBe("sftp not available for this session");
  });

  it("keeps partial bytes on timeout but does not set isError", async () => {
    const { client, local } = await startApp({ allowSftp: true, sftpDelayMs: 200 });
    const sid = (await call(client, "login", { name: "local" })).json().sid;
    const src = path.join(local, "slow.bin");
    await writeFile(src, "x".repeat(200_000));
    const upload = await call(client, "upload", { sid, src, dst: "/slow.bin", timeout_ms: 50 });
    expect(upload.isError).toBe(false);
    expect(upload.json().timed_out).toBe(true);
    expect(upload.json().ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/file_tools.test.ts`
Expected: FAIL — tool `upload` not found.

- [ ] **Step 3: Implement `src/mcp/tools_file.ts` (single-file half)**

```ts
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { parseConflictPolicy, type DirTransferOutcome } from "../sftp/types.js";
import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function uploadTool(
  svc: Service,
  args: { sid: string; src: string; dst: string; timeout_ms?: number },
) {
  try {
    const session = svc.manager.get(args.sid);
    let fh;
    try {
      fh = await open(args.src, "r");
    } catch (err) {
      return errorResult(`open local ${args.src}: ${message(err)}`);
    }
    let source: Readable;
    try {
      source = fh.createReadStream({ autoClose: true }) as unknown as Readable;
      const outcome = await session.upload(source, args.dst, args.timeout_ms ?? 0);
      if (outcome.error && !outcome.timedOut) return errorResult(message(outcome.error));
      return textResult({
        sid: args.sid,
        ok: !outcome.error,
        bytes: outcome.bytes,
        timed_out: outcome.timedOut,
        remote_url: args.dst,
      });
    } finally {
      try { await fh.close(); } catch { /* stream may own the fd */ }
    }
  } catch (err) {
    return errorResult(message(err));
  }
}

export async function downloadTool(
  svc: Service,
  args: { sid: string; src: string; dst: string; timeout_ms?: number },
) {
  try {
    const session = svc.manager.get(args.sid);
    const dst = createWriteStream(args.dst, { flags: "w" });
    // Surface create/open failures with Go's prefix.
    try {
      await once(dst, "open");
    } catch (err) {
      return errorResult(`create local ${args.dst}: ${message(err)}`);
    }
    const onError = (): void => { /* reported via outcome */ };
    dst.on("error", onError);
    try {
      const outcome = await session.download(args.src, dst as Writable, args.timeout_ms ?? 0);
      dst.end();
      try { await once(dst, "finish"); } catch { /* already errored */ }
      if (outcome.error && !outcome.timedOut) return errorResult(message(outcome.error));
      return textResult({
        sid: args.sid,
        ok: !outcome.error,
        bytes: outcome.bytes,
        timed_out: outcome.timedOut,
        local_url: args.dst,
      });
    } finally {
      dst.off("error", onError);
      dst.destroy();
    }
  } catch (err) {
    return errorResult(message(err));
  }
}
```

Remove the unused `createReadStream`/`parseConflictPolicy`/`DirTransferOutcome` imports until Task 7 (or use them there). The executor should keep imports minimal per commit.

- [ ] **Step 4: Register the tools in `src/mcp/server.ts`**

Import:

```ts
import { downloadTool, uploadTool } from "./tools_file.js";
```

Register after `read_in_session` and before `return server;`:

```ts
  server.registerTool("upload", {
    description: "Upload a local file to the remote host via sftp. Requires sftp_available=true on the session (check stat first). Returns {bytes, timed_out}. Fails with 'sftp not available' if session's sftp channel wasn't established (server doesn't support sftp subsystem).",
    inputSchema: {
      sid: z.string(),
      src: z.string().describe("local file path to upload (must exist)"),
      dst: z.string().describe("remote file path to write (e.g. /tmp/remote.txt)"),
      timeout_ms: z.number().int().optional().describe(
        "optional, 0 = default 300000 (300s). Returns timed_out=true + partial bytes if exceeded",
      ),
    },
  }, (args) => uploadTool(svc, args));

  server.registerTool("download", {
    description: "Download a remote file to local via sftp. Requires sftp_available=true on the session (check stat first). Returns {bytes, timed_out}. Fails with 'sftp not available' if session's sftp channel wasn't established.",
    inputSchema: {
      sid: z.string(),
      src: z.string().describe("remote file path to read"),
      dst: z.string().describe("local file path to write (overwritten if exists)"),
      timeout_ms: z.number().int().optional().describe(
        "optional, 0 = default 300000 (300s). Returns timed_out=true + partial bytes if exceeded",
      ),
    },
  }, (args) => downloadTool(svc, args));
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mcp/file_tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools_file.ts src/mcp/server.ts tests/mcp/file_tools.test.ts
git commit -m "feat(mcp): add upload and download tools"
```

---

### Task 7: MCP directory tools

**Files:**
- Modify: `src/mcp/tools_file.ts`, `src/mcp/server.ts`
- Test: `tests/mcp/file_tools.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp/file_tools.test.ts`:

```ts
describe("upload_dir/download_dir MCP tools", () => {
  it("uploads and downloads a tree with the documented result fields", async () => {
    const { server, client, local } = await startApp();
    const sid = (await call(client, "login", { name: "local" })).json().sid;

    const src = path.join(local, "tree");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "a.txt"), "alpha");
    await writeFile(path.join(src, "sub", "b.txt"), "bravo");

    const up = await call(client, "upload_dir", { sid, src, dst: "/tree" });
    expect(up.isError).toBe(false);
    expect(up.json()).toEqual({
      sid, ok: true, bytes: 10, files: 2, skipped: 0, renamed: 0, timed_out: 0,
    });
    expect(await readFile(path.join(server.sftpRoot, "tree/sub/b.txt"), "utf8")).toBe("bravo");

    const dst = path.join(local, "back");
    const down = await call(client, "download_dir", { sid, src: "/tree", dst });
    expect(down.json()).toEqual({
      sid, ok: true, bytes: 10, files: 2, skipped: 0, renamed: 0, timed_out: 0,
    });
    expect(await readFile(path.join(dst, "sub", "b.txt"), "utf8")).toBe("bravo");
  });

  it("propagates the skip conflict policy", async () => {
    const { server, client, local } = await startApp();
    const sid = (await call(client, "login", { name: "local" })).json().sid;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(server.sftpRoot, "r"), { recursive: true });
    await writeFile(path.join(server.sftpRoot, "r/a.txt"), "old");
    const src = path.join(local, "tree");
    await mkdir(src);
    await writeFile(path.join(src, "a.txt"), "new");

    const up = await call(client, "upload_dir", {
      sid, src, dst: "/r", conflict: "skip",
    });
    expect(up.json()).toEqual({
      sid, ok: true, bytes: 0, files: 0, skipped: 1, renamed: 0, timed_out: 0,
    });
    expect(await readFile(path.join(server.sftpRoot, "r/a.txt"), "utf8")).toBe("old");
  });

  it("returns ok:false in the body (not isError) when sftp is unavailable", async () => {
    const { client, local } = await startApp({ allowSftp: false });
    const sid = (await call(client, "login", { name: "local" })).json().sid;
    const src = path.join(local, "tree");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(src);

    const up = await call(client, "upload_dir", { sid, src, dst: "/r" });
    expect(up.isError).toBe(false);
    expect(up.json()).toMatchObject({
      sid, ok: false, bytes: 0, files: 0, skipped: 0, renamed: 0, timed_out: 0,
      err: "sftp not available for this session",
    });
  });

  it("reports per-file timeouts as a partial result", async () => {
    const { client, local } = await startApp({ allowSftp: true, sftpDelayMs: 200 });
    const sid = (await call(client, "login", { name: "local" })).json().sid;
    const src = path.join(local, "tree");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(src);
    await writeFile(path.join(src, "a.txt"), "alpha");
    await writeFile(path.join(src, "b.txt"), "bravo");

    const up = await call(client, "upload_dir", {
      sid, src, dst: "/slow", timeout_ms: 50,
    });
    expect(up.isError).toBe(false);
    expect(up.json()).toMatchObject({
      sid, ok: false, bytes: 0, files: 0, timed_out: 2,
    });
    expect(up.json().err).toContain("timed out");
  });

  it("returns isError for an unknown sid", async () => {
    const { client, local } = await startApp();
    const up = await call(client, "upload_dir", { sid: "nope", src: local, dst: "/x" });
    expect(up.isError).toBe(true);
    expect(up.text).toContain('session "nope" not found');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/file_tools.test.ts -t "upload_dir"`
Expected: FAIL — tool `upload_dir` not found.

- [ ] **Step 3: Implement the directory tools in `src/mcp/tools_file.ts`**

Add imports: `parseConflictPolicy`, `type DirTransferOutcome` from `../sftp/types.js`.

```ts
function dirBody(
  sid: string,
  outcome: DirTransferOutcome,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sid,
    ok: !outcome.error,
    bytes: outcome.result.bytes,
    files: outcome.result.files,
    skipped: outcome.result.skipped,
    renamed: outcome.result.renamed,
    timed_out: outcome.result.timedOut,
  };
  if (outcome.error) body.err = outcome.error.message;
  return body;
}

export async function uploadDirTool(
  svc: Service,
  args: {
    sid: string;
    src: string;
    dst: string;
    conflict?: string;
    concurrency?: number;
    timeout_ms?: number;
  },
) {
  try {
    const session = svc.manager.get(args.sid);
    const outcome = await session.uploadDir(args.src, args.dst, {
      conflict: parseConflictPolicy(args.conflict),
      concurrency: args.concurrency ?? 0,
      timeoutMs: args.timeout_ms ?? 0,
    });
    return textResult(dirBody(args.sid, outcome));
  } catch (err) {
    return errorResult(message(err));
  }
}

export async function downloadDirTool(
  svc: Service,
  args: {
    sid: string;
    src: string;
    dst: string;
    conflict?: string;
    concurrency?: number;
    timeout_ms?: number;
  },
) {
  try {
    const session = svc.manager.get(args.sid);
    const outcome = await session.downloadDir(args.src, args.dst, {
      conflict: parseConflictPolicy(args.conflict),
      concurrency: args.concurrency ?? 0,
      timeoutMs: args.timeout_ms ?? 0,
    });
    return textResult(dirBody(args.sid, outcome));
  } catch (err) {
    return errorResult(message(err));
  }
}
```

- [ ] **Step 4: Register the tools in `src/mcp/server.ts`**

Extend the import to `downloadDirTool, downloadTool, uploadDirTool, uploadTool`. Register after `download`:

```ts
  const dirTransferSchema = {
    sid: z.string(),
    src: z.string(),
    dst: z.string(),
    conflict: z.string().optional().describe(
      "optional, default 'overwrite'. One of: overwrite, skip, rename",
    ),
    concurrency: z.number().int().optional().describe(
      "optional, default 4. Number of files to transfer in parallel",
    ),
    timeout_ms: z.number().int().optional().describe(
      "optional, 0 = default 300000 (300s). Per-file timeout",
    ),
  };

  server.registerTool("upload_dir", {
    description: "Upload a local directory tree to the remote host via sftp. Walks the local tree, creates remote dirs (MkdirAll), transfers files concurrently (default 4). Conflict policy: overwrite (default) / skip / rename. Per-file errors don't abort the transfer; aggregated in result. Requires sftp_available=true on the session. Note: partial failures return ok:false in the result body with IsError not set; check the ok field, not the MCP error flag.",
    inputSchema: dirTransferSchema,
  }, (args) => uploadDirTool(svc, args));

  server.registerTool("download_dir", {
    description: "Download a remote directory tree to local via sftp. Walks the remote tree, creates local dirs (MkdirAll), transfers files concurrently (default 4). Conflict policy: overwrite (default) / skip / rename. Per-file errors don't abort the transfer; aggregated in result. Requires sftp_available=true on the session. Note: partial failures return ok:false in the result body with IsError not set; check the ok field, not the MCP error flag.",
    inputSchema: dirTransferSchema,
  }, (args) => downloadDirTool(svc, args));
```

Zod's inference for `dirTransferSchema` works with `registerTool`; if the shared object causes type widening issues, inline the schema in both registrations instead.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mcp/file_tools.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools_file.ts src/mcp/server.ts tests/mcp/file_tools.test.ts
git commit -m "feat(mcp): add upload_dir and download_dir tools"
```

---

### Task 8: Relay transfer

**Files:**
- Create: `src/session/relay.ts`, `src/mcp/tools_relay.ts`
- Modify: `src/session/manager.ts`, `src/mcp/server.ts`
- Test: `tests/mcp/relay.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/mcp/relay.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text,
    json: () => JSON.parse(text),
  };
}

async function startRelayApp(
  specs: Array<{ name: string; fake: FakeSshOptions }>,
) {
  const servers = await Promise.all(
    specs.map((spec) => FakeSshServer.start(spec.fake)),
  );
  const temp = await tempDir();
  const local = await mkdtemp(path.join(tmpdir(), "myssh-relay-"));
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: specs.map((spec, index) => ({
      name: spec.name,
      addr: servers[index]!.addr,
      user: "test",
      auth: { password: "secret" },
    })),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(new Service(new Store(file)));
  await mcp.connect(serverTransport);
  const client = new Client({ name: "relay-test", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanupFns.push(
    ...servers.map((server) => () => server.close()),
    temp.cleanup,
    async () => rm(local, { recursive: true, force: true }),
  );
  return { servers, client, local };
}

async function loginSid(client: Client, name: string): Promise<string> {
  const login = await call(client, "login", { name });
  expect(login.isError).toBe(false);
  return login.json().sid as string;
}

describe("relay_transfer", () => {
  it("streams one source file to two destinations in order", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "dst1", fake: { allowSftp: true } },
      { name: "dst2", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "file.bin"), "relay-payload");
    const srcSid = await loginSid(client, "src");
    const dst1 = await loginSid(client, "dst1");
    const dst2 = await loginSid(client, "dst2");

    const result = await call(client, "relay_transfer", {
      src_sid: srcSid,
      src_path: "/file.bin",
      dst_sids: [dst1, dst2],
      dst_path: "/landed.bin",
    });
    expect(result.isError).toBe(false);
    expect(result.json()).toEqual({
      ok: true,
      downloaded_bytes: 13,
      timed_out: false,
      src_server: "src",
      destinations: [
        { dst_sid: dst1, dst_server: "dst1", ok: true, bytes: 13, timed_out: false },
        { dst_sid: dst2, dst_server: "dst2", ok: true, bytes: 13, timed_out: false },
      ],
    });
    expect(await readFile(path.join(servers[1]!.sftpRoot, "landed.bin"), "utf8"))
      .toBe("relay-payload");
    expect(await readFile(path.join(servers[2]!.sftpRoot, "landed.bin"), "utf8"))
      .toBe("relay-payload");
  });

  it("supports 1:1 with a single-element dst_sids", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "dst", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "one"), "1");
    const srcSid = await loginSid(client, "src");
    const dst = await loginSid(client, "dst");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/one", dst_sids: [dst], dst_path: "/one",
    });
    expect(result.json().ok).toBe(true);
    expect(result.json().destinations).toHaveLength(1);
    expect(await readFile(path.join(servers[1]!.sftpRoot, "one"), "utf8")).toBe("1");
  });

  it("reports per-destination preflight failures without aborting the others", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "good", fake: { allowSftp: true } },
      { name: "nosftp", fake: { allowSftp: false } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "f"), "x");
    const srcSid = await loginSid(client, "src");
    const good = await loginSid(client, "good");
    const nosftp = await loginSid(client, "nosftp");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid,
      src_path: "/f",
      dst_sids: [srcSid, good, nosftp, "missing"],
      dst_path: "/out",
    });
    expect(result.isError).toBe(false);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("one or more relay destinations failed");
    expect(body.destinations[0]).toMatchObject({
      dst_sid: srcSid, ok: false, error: "cannot relay a session to itself",
    });
    expect(body.destinations[1]).toMatchObject({ ok: true, bytes: 1 });
    expect(body.destinations[2]).toMatchObject({
      dst_sid: nosftp, dst_server: "nosftp", ok: false,
      error: "sftp not available for this session",
    });
    expect(body.destinations[3]).toMatchObject({
      dst_sid: "missing", ok: false, error: 'session "missing" not found',
    });
    expect(body.downloaded_bytes).toBe(1);
  });

  it("fails all destinations when the source is not a regular file", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "dst", fake: { allowSftp: true } },
    ]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(servers[0]!.sftpRoot, "dir"));
    const srcSid = await loginSid(client, "src");
    const dst = await loginSid(client, "dst");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/dir", dst_sids: [dst], dst_path: "/x",
    });
    expect(result.json()).toMatchObject({
      ok: false,
      error: "source not a regular file",
      destinations: [{
        dst_sid: dst, dst_server: "dst", ok: false, bytes: 0,
        timed_out: false, error: "source not a regular file",
      }],
    });
  });

  it("returns isError for hard errors", async () => {
    const { client } = await startRelayApp([{ name: "src", fake: { allowSftp: true } }]);
    const srcSid = await loginSid(client, "src");
    const empty = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/x", dst_sids: [], dst_path: "/x",
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toBe("no relay destinations");
    const missing = await call(client, "relay_transfer", {
      src_sid: "nope", src_path: "/x", dst_sids: [srcSid], dst_path: "/x",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('session "nope" not found');
  });

  it("marks a busy destination but still delivers to healthy ones", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "busy", fake: { allowSftp: true } },
      { name: "healthy", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "f"), "payload");
    const srcSid = await loginSid(client, "src");
    const busy = await loginSid(client, "busy");
    const healthy = await loginSid(client, "healthy");

    const running = call(client, "run_in_session", { sid: busy, cmd: "sleep 1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const relay = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/f", dst_sids: [busy, healthy], dst_path: "/f",
    });
    await running;
    const body = relay.json();
    expect(body.destinations[0]).toMatchObject({ ok: false, error: "session busy" });
    expect(body.destinations[1]).toMatchObject({ ok: true, bytes: 7 });
  });

  it("times out without isError and reports timed_out at the top level", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true, sftpDelayMs: 200 } },
      { name: "dst", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "big"), "x".repeat(100_000));
    const srcSid = await loginSid(client, "src");
    const dst = await loginSid(client, "dst");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/big", dst_sids: [dst], dst_path: "/big", timeout_ms: 50,
    });
    expect(result.isError).toBe(false);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(body.timed_out).toBe(true);
    expect(body.destinations[0].timed_out).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/relay.test.ts`
Expected: FAIL — tool `relay_transfer` not found / module `src/session/relay.js` missing.

- [ ] **Step 3: Implement `src/session/relay.ts`**

```ts
import { PassThrough, Writable } from "node:stream";
import type { SessionManager } from "./manager.js";
import type { Session } from "./session.js";
import { SFTP_UNAVAILABLE } from "../sftp/types.js";

export const ALL_DESTINATIONS_FAILED = "all relay destinations failed";

interface Slot {
  stream: PassThrough;
  dead: boolean;
}

/** Writable that fans every chunk out to N PassThroughs with backpressure. */
export class FanoutSink extends Writable {
  private readonly slots: Slot[];

  constructor(count: number) {
    super({ highWaterMark: 64 * 1024 });
    this.slots = Array.from({ length: count }, () => {
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      const slot: Slot = { stream, dead: false };
      stream.on("error", () => { slot.dead = true; });
      stream.on("close", () => { slot.dead = true; });
      return slot;
    });
  }

  streams(): PassThrough[] {
    return this.slots.map((slot) => slot.stream);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const live = this.slots.filter((slot) => !slot.dead && !slot.stream.destroyed);
    if (live.length === 0) {
      callback(new Error(ALL_DESTINATIONS_FAILED));
      return;
    }
    void Promise.all(live.map((slot) => this.writeSlot(slot, chunk))).then(() => {
      if (this.liveCount() === 0) callback(new Error(ALL_DESTINATIONS_FAILED));
      else callback();
    });
  }

  override _final(callback: () => void): void {
    for (const slot of this.slots) {
      if (!slot.stream.destroyed) {
        try { slot.stream.end(); } catch { /* already ended */ }
      }
    }
    callback();
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    for (const slot of this.slots) {
      try { slot.stream.destroy(err ?? undefined); } catch { /* ignore */ }
    }
    callback();
  }

  private liveCount(): number {
    return this.slots.filter((slot) => !slot.dead && !slot.stream.destroyed).length;
  }

  private writeSlot(slot: Slot, chunk: Buffer): Promise<void> {
    return new Promise<void>((resolve) => {
      if (slot.dead || slot.stream.destroyed) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (dead: boolean): void => {
        if (settled) return;
        settled = true;
        slot.stream.off("drain", onDrain);
        slot.stream.off("error", onError);
        slot.stream.off("close", onClose);
        if (dead) slot.dead = true;
        resolve();
      };
      const onDrain = (): void => finish(false);
      const onError = (): void => finish(true);
      const onClose = (): void => finish(true);
      slot.stream.once("drain", onDrain);
      slot.stream.once("error", onError);
      slot.stream.once("close", onClose);
      try {
        if (slot.stream.write(chunk)) finish(false);
      } catch {
        finish(true);
      }
    });
  }
}

export interface RelayDestinationResult {
  dstSid: string;
  dstServer: string;
  ok: boolean;
  bytes: number;
  timedOut: boolean;
  error?: string;
}

export interface RelayOutcome {
  ok: boolean;
  downloadedBytes: number;
  timedOut: boolean;
  srcServer: string;
  destinations: RelayDestinationResult[];
  error?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function relayTransfer(
  manager: SessionManager,
  srcSid: string,
  srcPath: string,
  dstSids: string[],
  dstPath: string,
  timeoutMs = 0,
): Promise<RelayOutcome> {
  const srcSession = manager.get(srcSid);
  if (dstSids.length === 0) throw new Error("no relay destinations");

  if (!srcSession.sftpAvailable) {
    return {
      ok: false,
      downloadedBytes: 0,
      timedOut: false,
      srcServer: srcSession.serverName,
      destinations: dstSids.map((dstSid) => ({
        dstSid,
        dstServer: "",
        ok: false,
        bytes: 0,
        timedOut: false,
        error: "source sftp unavailable",
      })),
      error: SFTP_UNAVAILABLE,
    };
  }

  const destinations: RelayDestinationResult[] = dstSids.map((dstSid) => ({
    dstSid,
    dstServer: "",
    ok: false,
    bytes: 0,
    timedOut: false,
  }));

  interface LiveEntry {
    index: number;
    session: Session;
  }
  const live: LiveEntry[] = [];

  for (let index = 0; index < dstSids.length; index += 1) {
    const dstSid = dstSids[index]!;
    const destination = destinations[index]!;
    if (dstSid === srcSid) {
      destination.error = "cannot relay a session to itself";
      continue;
    }
    let dstSession: Session;
    try {
      dstSession = manager.get(dstSid);
    } catch (err) {
      destination.error = message(err);
      continue;
    }
    destination.dstServer = dstSession.serverName;
    if (!dstSession.sftpAvailable) {
      destination.error = SFTP_UNAVAILABLE;
      continue;
    }
    if (dstSession.state !== "idle") {
      destination.error = "session busy";
      continue;
    }
    live.push({ index, session: dstSession });
  }

  if (live.length === 0) {
    return {
      ok: false,
      downloadedBytes: 0,
      timedOut: false,
      srcServer: srcSession.serverName,
      destinations,
      error: "no live relay destinations (all failed pre-flight)",
    };
  }

  let size: number | undefined;
  try {
    const st = await srcSession.sftpStat(srcPath);
    if (!st.isFile) {
      for (const entry of live) {
        destinations[entry.index]!.error = "source not a regular file";
      }
      return {
        ok: false,
        downloadedBytes: 0,
        timedOut: false,
        srcServer: srcSession.serverName,
        destinations,
        error: "source not a regular file",
      };
    }
    size = st.size;
  } catch {
    size = undefined;
  }

  const sink = new FanoutSink(live.length);
  const streams = sink.streams();

  const downloadPromise = srcSession.download(srcPath, sink, timeoutMs);
  const uploadPromises = live.map(async (entry, streamIndex) => {
    const stream = streams[streamIndex]!;
    try {
      const outcome = await entry.session.upload(stream, dstPath, timeoutMs);
      const destination = destinations[entry.index]!;
      destination.ok = !outcome.error && !outcome.timedOut;
      destination.bytes = outcome.bytes;
      destination.timedOut = outcome.timedOut;
      if (outcome.error) destination.error = outcome.error.message;
    } catch (err) {
      const destination = destinations[entry.index]!;
      destination.error = message(err);
    } finally {
      try { stream.destroy(); } catch { /* ignore */ }
    }
  });

  const downloaded = await downloadPromise;
  if (downloaded.error) sink.destroy(downloaded.error);
  else sink.end();
  await Promise.all(uploadPromises);

  let timedOut = downloaded.timedOut;
  for (const destination of destinations) {
    if (destination.timedOut) timedOut = true;
  }

  let allOk = !downloaded.error && !downloaded.timedOut
    && destinations.every((destination) => destination.ok);
  if (allOk && size !== undefined) {
    if (downloaded.bytes !== size) allOk = false;
    for (const destination of destinations) {
      if (destination.bytes !== size) {
        destination.ok = false;
        allOk = false;
      }
    }
  }

  const result: RelayOutcome = {
    ok: allOk,
    downloadedBytes: downloaded.bytes,
    timedOut,
    srcServer: srcSession.serverName,
    destinations,
  };
  if (!allOk) {
    result.error = downloaded.error?.message ?? "one or more relay destinations failed";
  }
  return result;
}
```

- [ ] **Step 4: Delegate from `SessionManager`**

In `src/session/manager.ts`:

```ts
import { relayTransfer as relayTransferImpl, type RelayOutcome } from "./relay.js";
```

```ts
  relayTransfer(
    srcSid: string,
    srcPath: string,
    dstSids: string[],
    dstPath: string,
    timeoutMs = 0,
  ): Promise<RelayOutcome> {
    return relayTransferImpl(this, srcSid, srcPath, dstSids, dstPath, timeoutMs);
  }
```

- [ ] **Step 5: Implement and register the MCP tool**

`src/mcp/tools_relay.ts`:

```ts
import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function relayTransferTool(
  svc: Service,
  args: {
    src_sid: string;
    src_path: string;
    dst_sids: string[];
    dst_path: string;
    timeout_ms?: number;
  },
) {
  try {
    const outcome = await svc.manager.relayTransfer(
      args.src_sid,
      args.src_path,
      args.dst_sids,
      args.dst_path,
      args.timeout_ms ?? 0,
    );
    const destinations = outcome.destinations.map((destination) => {
      const entry: Record<string, unknown> = {
        dst_sid: destination.dstSid,
        dst_server: destination.dstServer,
        ok: destination.ok,
        bytes: destination.bytes,
        timed_out: destination.timedOut,
      };
      if (destination.error) entry.error = destination.error;
      return entry;
    });
    const body: Record<string, unknown> = {
      ok: outcome.ok,
      downloaded_bytes: outcome.downloadedBytes,
      timed_out: outcome.timedOut,
      src_server: outcome.srcServer,
      destinations,
    };
    if (outcome.error) body.error = outcome.error;
    return textResult(body);
  } catch (err) {
    return errorResult(message(err));
  }
}
```

Register in `src/mcp/server.ts`:

```ts
import { relayTransferTool } from "./tools_relay.js";
```

```ts
  server.registerTool("relay_transfer", {
    description: "Relay (stream) a remote file from one session to one or more other sessions through the myssh process, without landing it on local disk and without waiting for the full download before uploading. 1:N fanout: the source is read once and streamed concurrently to all destinations (sharded/replicated deploy). 1:1 is the single-element dst_sids case. Requires sftp_available=true on the source and every destination (check stat first). All destinations share the same dst_path. Returns {ok, downloaded_bytes, timed_out, src_server, destinations:[{dst_sid, dst_server, ok, bytes, timed_out, error}]}. Per-destination failures do not abort the others; partial failures return ok:false in the result body with IsError not set (check the ok field, not the MCP error flag).",
    inputSchema: {
      src_sid: z.string(),
      src_path: z.string().describe("remote file path on the source session to relay"),
      dst_sids: z.array(z.string()).describe(
        "destination session sids; 1:1 = single-element array",
      ),
      dst_path: z.string().describe("remote write path shared by all destinations"),
      timeout_ms: z.number().int().optional().describe(
        "optional, 0 = default 300000 (300s). Each of download + every upload side gets its own budget (concurrent)",
      ),
    },
  }, (args) => relayTransferTool(svc, args));
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/mcp/relay.test.ts`
Expected: PASS (7 tests).

If the busy-destination test is flaky because `sleep 1` has not started yet, increase the wait to 100ms; do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/session/relay.ts src/session/manager.ts src/mcp/tools_relay.ts src/mcp/server.ts tests/mcp/relay.test.ts
git commit -m "feat: add 1:N streaming relay transfer"
```

---

### Task 9: Tool registration, instructions, docs, full verification

**Files:**
- Modify: `src/mcp/server.ts`, `tests/mcp/tools_config.test.ts`, `README.md`

- [ ] **Step 1: Update the tool-count test**

Open `tests/mcp/tools_config.test.ts`; change the expected count from 16 to 21 and add the five names:

```ts
    expect(names).toEqual([
      "list_ssh_servers",
      "get_ssh_server",
      "update_ssh_server",
      "list_jumphosts",
      "get_jumphost",
      "update_jumphost",
      "list_proxies",
      "get_proxy",
      "update_proxy",
      "login",
      "run_in_session",
      "close_session",
      "stat",
      "get_trace",
      "send_in_session",
      "read_in_session",
      "upload",
      "download",
      "upload_dir",
      "download_dir",
      "relay_transfer",
    ]);
```

Keep the assertions that already exist (sorted or ordered) in the file; match its actual style. If it asserts `names.sort()`, sort this list alphabetically instead.

- [ ] **Step 2: Extend the MCP instructions**

In `src/mcp/server.ts`, add to the `instructions` template literal:

```text
File transfer:
- login -> sftp_available. Direct and Pattern A: true; Pattern B: false.
- upload/download: single files, atomic remote/local writes, timeout via timeout_ms (default 300s). Partial timeout returns {ok:false, timed_out:true} without an MCP error.
- upload_dir/download_dir: recursive, default concurrency 4, conflict overwrite|skip|rename. Per-file failures aggregate into {ok:false, err} with IsError not set.
- relay_transfer: stream src_sid:src_path to N sessions sharing dst_path; the source is read once. Requires sftp on every participant; per-destination failures are isolated.
- upload/download "sftp not available" -> check stat.sftp_available first.
```

Also update the `login` tool description mention of sftp if needed (Pattern A true, Pattern B false is already implied by the returned field).

- [ ] **Step 3: Update README**

- Change the milestone status line to M4 complete.
- Replace the “16 tools” list with 21 entries, including one-line descriptions for the five file tools.
- Add a short example block:

```markdown
### File transfer

```
login(name) -> {sid, sftp_available: true}
upload(sid, "/local/report.pdf", "/tmp/report.pdf") -> {ok, bytes, timed_out}
download(sid, "/tmp/report.pdf", "./report.pdf") -> {ok, bytes, timed_out}
upload_dir(sid, "./dist", "/srv/app", conflict="overwrite", concurrency=4)
download_dir(sid, "/var/log/app", "./logs", conflict="skip")
relay_transfer(src_sid, "/srv/app.tar", [dst_sid_1, dst_sid_2], "/srv/app.tar") -> 1:N fanout
```
```

- [ ] **Step 4: Run the whole verification suite**

```bash
npx tsc --noEmit
npx vitest run
npm run build
```

Expected: typecheck clean, all tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/tools_config.test.ts README.md
git commit -m "docs: expose M4 file transfer tools and update README"
```

- [ ] **Step 6: Finish the branch**

Use `superpowers:finishing-a-development-branch`: verify tests, then merge `m4-sftp` into `main` locally (standing user preference), re-run the suite on `main`, and delete the feature branch.

---

## Self-review notes

- Every Go-visible error string and result field is covered by a task.
- Atomicity is tested on both directions, including timeout cleanup.
- Conflict policies are tested for remote and local destinations.
- Relay covers 1:N order, 1:1, preflight isolation, non-regular source, hard errors, busy destination, and timeout.
- Fake-server tests always exercise the no-extension fallback path because ssh2 server mode cannot advertise `posix-rename`/`fsync`.
- The session state machine is tested for running/idle transitions, busy, closed, and unavailable sftp.

