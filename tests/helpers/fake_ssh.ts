import net from "node:net";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { Connection, Server as SshServer } from "ssh2";

const { Server, utils } = ssh2;

export interface FakeSshOptions {
  user?: string;
  password?: string;
  raw?: boolean;
  allowSftp?: boolean;
  allowPublicKey?: boolean;
}

export class FakeShell {
  private line = "";
  private sid = "";
  private token = "";
  private commandActive = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly raw: boolean,
  ) {}

  /** 喂入终端字节。 */
  input(chunk: Buffer): void {
    if (this.raw) {
      this.send(chunk.toString("latin1"));
      return;
    }
    for (const byte of chunk) {
      if (byte === 0x03) {
        this.cancelSleep();
        if (this.commandActive) {
          this.commandActive = false;
          this.prompt(130);
        }
        this.line = "";
        continue;
      }
      if (byte === 0x0a) {
        const line = this.line.replace(/\r$/, "");
        this.line = "";
        this.handleLine(line);
      } else {
        this.line += String.fromCharCode(byte);
      }
    }
  }

  cancel(): void {
    this.cancelSleep();
  }

  private cancelSleep(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
  }

  private prompt(code: number): void {
    if (this.token) this.send(`_${code}__${this.sid}_${this.token}__]# `);
    else this.send(`_${code}__${this.sid}___]# `);
  }

  private handleLine(line: string): void {
    const detect = /^__sshmng_dr=([0-9a-f]+);/.exec(line);
    if (detect) {
      this.send(
        `__SHELL_DETECT__:/bin/bash:5.2.15(1)-release:\r\n__DETECT_END_${detect[1]!}__\r\n`,
      );
      return;
    }
    const initial = /^export PS1='\$\(echo _\$\?\)__([0-9a-f]+)___\]# '$/.exec(line);
    if (initial) {
      this.sid = initial[1]!;
      this.token = "";
      this.prompt(0);
      return;
    }
    const setup = /^PS1='\$\(echo _\$\?\)__([0-9a-f]+)_([0-9a-f]+)__\]# '$/.exec(line);
    if (setup) {
      this.sid = setup[1]!;
      this.token = setup[2]!;
      this.prompt(0);
      return;
    }
    // RC 注入的 export/set/stty 等按真实 shell 行为静默执行。
    if (/^(export|set|setopt|unset|stty|umask)\b/.test(line)) return;
    if (!this.commandActive) this.runCommand(line);
  }

  private runCommand(line: string): void {
    this.commandActive = true;
    let match: RegExpExecArray | null;
    if ((match = /^echo (.*)$/.exec(line))) {
      this.finish(`${match[1]!}\r\n`, 0);
    } else if (line === "false") {
      this.finish("", 1);
    } else if (line === "true") {
      this.finish("", 0);
    } else if ((match = /^sleep ([0-9.]+)$/.exec(line))) {
      this.sleepTimer = setTimeout(() => this.finish("", 0), Number(match![1]) * 1000);
    } else if (line === "pwd") {
      this.finish("/home/test\r\n", 0);
    } else if ((match = /^seq (\d+)$/.exec(line))) {
      const count = Number(match[1]);
      const lines: string[] = [];
      for (let i = 1; i <= count; i += 1) lines.push(String(i));
      this.finish(`${lines.join("\r\n")}\r\n`, 0);
    } else {
      this.finish(`sh: ${line}: command not found\r\n`, 127);
    }
  }

  private finish(output: string, code: number): void {
    this.commandActive = false;
    if (output) this.send(output);
    this.prompt(code);
  }
}

export class FakeSshServer {
  private constructor(
    readonly port: number,
    readonly hostKeyBase64: string,
    private readonly server: SshServer,
    private readonly clients: Connection[],
  ) {}

  static async start(opts: FakeSshOptions = {}): Promise<FakeSshServer> {
    const { private: hostKey } = utils.generateKeyPairSync("ed25519");
    const parsedHostKey = utils.parseKey(hostKey);
    if (parsedHostKey instanceof Error) throw parsedHostKey;
    const hostKeyBase64 = parsedHostKey.getPublicSSH().toString("base64");
    const clients: Connection[] = [];
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      clients.push(client);
      client.on("error", () => { /* client aborted; tests assert on the caller side */ });
      client.on("authentication", (ctx) => {
        if (
          ctx.method === "password"
          && ctx.username === (opts.user ?? "test")
          && ctx.password === (opts.password ?? "secret")
        ) {
          ctx.accept();
        } else if (ctx.method === "publickey" && opts.allowPublicKey) {
          ctx.accept();
        } else {
          ctx.reject();
        }
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          const shell = new FakeShell((text) => stream.write(text), !!opts.raw);
          stream.on("data", (data: Buffer) => shell.input(data));
          stream.on("error", () => { /* client went away */ });
          stream.on("close", () => shell.cancel());
        });
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (opts.allowSftp) acceptSftp();
          else rejectSftp();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return new FakeSshServer(port, hostKeyBase64, server, clients);
  }

  get addr(): string {
    return `127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
