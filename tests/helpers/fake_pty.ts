import type { PtyTransport } from "../../src/pty/transport.js";
import { FakeShell } from "./fake_ssh.js";

export class FakePtyTransport implements PtyTransport {
  readonly written: Buffer[] = [];
  readonly windowSizes: Array<{ rows: number; cols: number }> = [];
  autoRespond: boolean;
  private readonly dataHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(err?: Error) => void>();
  private readonly shell: FakeShell;

  constructor(opts: { raw?: boolean } = {}) {
    this.autoRespond = !opts.raw;
    this.shell = new FakeShell((text) => this.emit(Buffer.from(text)), !!opts.raw);
  }

  write(data: Buffer | string): void {
    const buf = Buffer.from(data);
    this.written.push(buf);
    if (this.autoRespond) this.shell.input(buf);
  }

  emit(data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const handler of this.dataHandlers) handler(buf);
  }

  onData(handler: (data: Buffer) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: (err?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  setWindow(rows: number, cols: number): void {
    this.windowSizes.push({ rows, cols });
  }

  close(): void {
    this.shell.cancel();
    for (const handler of this.closeHandlers) handler();
  }

  allWritten(): string {
    return Buffer.concat(this.written).toString("latin1");
  }
}
