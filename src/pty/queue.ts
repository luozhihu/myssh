/** 单消费者字节队列：push / drain / wait，关闭后不再接收数据。 */
export class ByteQueue {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private closedRaw = false;
  private waiters: Array<() => void> = [];

  push(data: Buffer): void {
    if (this.closedRaw || data.length === 0) return;
    this.chunks.push(data);
    this.bytes += data.length;
    this.wake();
  }

  pushBack(data: Buffer): void {
    if (data.length === 0) return;
    this.chunks.unshift(data);
    this.bytes += data.length;
    this.wake();
  }

  drain(): Buffer {
    const out = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  get size(): number {
    return this.bytes;
  }

  get closed(): boolean {
    return this.closedRaw;
  }

  close(): void {
    this.closedRaw = true;
    this.wake();
  }

  /** 有数据 / 已关闭 / 超时后 resolve。 */
  wait(ms: number): Promise<void> {
    if (this.bytes > 0 || this.closedRaw || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve();
      };
      const timer = setTimeout(waiter, ms);
      this.waiters.push(waiter);
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
