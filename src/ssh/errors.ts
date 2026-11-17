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
