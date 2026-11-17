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
  forwarding?: boolean;
  bastion?: boolean;
  banner?: string;
}

export interface FakeShellOptions {
  raw?: boolean;
  bastion?: boolean;
  banner?: string;
}

export const BASTION_MENU =
  "Welcome to Jumphost v2\r\nMain menu:\r\n1) prod-db\r\nSelect target: ";

export class FakeShell {
  private line = "";
  private sid = "";
  private token = "";
  private commandActive = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private bastionPhase: "menu" | "user" | "pass" | "shell" | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly raw: boolean,
    options: FakeShellOptions = {},
  ) {
    if (options.banner) this.send(options.banner);
    if (options.bastion) {
      this.bastionPhase = "menu";
      this.send(BASTION_MENU);
    }
  }

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
      // 真实 PTY 默认 ICRNL：Enter 发送的 \r 被终端驱动转为 \n。
      if (byte === 0x0a || byte === 0x0d) {
        const line = this.line;
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
    if (this.bastionPhase && this.bastionPhase !== "shell") {
      this.handleBastionLine(line);
      return;
    }
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

  /** 交互式堡垒机菜单：选择目标 → target 登录 → 进入 target shell。 */
  private handleBastionLine(line: string): void {
    switch (this.bastionPhase) {
      case "menu":
        if (line === "1") {
          this.send("Connecting to prod-db...\r\nlogin: ");
          this.bastionPhase = "user";
        }
        return;
      case "user":
        this.send("Password: ");
        this.bastionPhase = "pass";
        return;
      case "pass":
        if (line === "wonderland") {
          this.send("Welcome to prod-db!\r\n");
          this.bastionPhase = "shell";
        } else {
          this.send("Login incorrect\r\nSelect target: ");
          this.bastionPhase = "menu";
        }
        return;
      default:
        return;
    }
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
          const shell = new FakeShell((text) => stream.write(text), !!opts.raw, {
            bastion: opts.bastion,
            banner: opts.banner,
          });
          stream.on("data", (data: Buffer) => shell.input(data));
          stream.on("error", () => { /* client went away */ });
          stream.on("close", () => shell.cancel());
        });
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (opts.allowSftp) acceptSftp();
          else rejectSftp();
        });
      });
      client.on("tcpip", (accept, reject, info) => {
        if (opts.forwarding === false) {
          reject();
          return;
        }
        const upstream = net.connect(info.destPort, info.destIP, () => {
          let channel;
          try {
            channel = accept();
          } catch {
            upstream.destroy();
            return;
          }
          channel.pipe(upstream).pipe(channel);
          channel.on("error", () => upstream.destroy());
          channel.on("close", () => upstream.destroy());
          upstream.on("error", () => channel.destroy());
          upstream.on("close", () => channel.destroy());
        });
        upstream.on("error", () => {
          try {
            reject();
          } catch {
            /* already settled */
          }
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
