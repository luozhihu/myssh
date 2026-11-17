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
import type { Stats as FsStats } from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import type { Attributes, FileEntry, SFTPWrapper } from "ssh2";

const { utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const ZERO_ATTRS: Attributes = {
  mode: 0o040755,
  uid: 0,
  gid: 0,
  size: 0,
  atime: 0,
  mtime: 0,
};

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

function attrsOf(st: FsStats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longnameOf(st: FsStats, name: string): string {
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
          const full = name === "."
            ? target
            : name === ".."
              ? path.dirname(target)
              : path.join(target, name);
          const est = lstatSync(full);
          entries.push({
            filename: name,
            longname: longnameOf(est, name),
            attrs: attrsOf(est),
          });
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
        this.sftp.name(reqId, [{
          filename: resolved,
          longname: resolved,
          attrs: ZERO_ATTRS,
        }]);
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
    // Delayed handlers can outlive a closed channel; nothing to answer then.
    try {
      this.sftp.status(reqId, code);
    } catch { /* channel closed */ }
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
