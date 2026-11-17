/** PTY 输出通道已关闭（SSH channel EOF / 连接断开）。 */
export class ConnLostError extends Error {
  constructor() {
    super("connection lost");
    this.name = "ConnLostError";
  }
}

export function isConnLost(err: unknown): boolean {
  return err instanceof Error && err.message === "connection lost";
}

/** PTY 状态机不可恢复（setup token 超时 / drain 失败），Session 应关闭连接。 */
export class PtyUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtyUnusableError";
  }
}
