/** PTY 传输抽象：真实实现是 ssh2 channel，测试实现是 FakePtyTransport。 */
export interface PtyTransport {
  write(data: Buffer | string): void;
  onData(handler: (data: Buffer) => void): () => void;
  onClose(handler: (err?: Error) => void): () => void;
  close(): void;
  probeSftp(): Promise<boolean>;
}
