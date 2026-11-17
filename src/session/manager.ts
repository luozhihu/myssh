import { nullLogger, type Logger } from "../log.js";
import type { SessionConn, SessionOptions, SessionStat } from "./session.js";
import { Session } from "./session.js";
import { GRAVE_TTL_MS, truncateTraces, type CommandTrace } from "./trace.js";

interface GraveEntry {
  traces: CommandTrace[];
  closedAt: number;
}

export interface ManagerOptions {
  now?: () => number;
  logger?: Logger;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly graveyard = new Map<string, GraveEntry>();
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(options: ManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? nullLogger;
  }

  newSession(
    sid: string,
    serverName: string,
    conn: SessionConn,
    idleTimeoutMs: number,
    options: Omit<SessionOptions, "idleTimeoutMs" | "now" | "logger" | "onClosed"> = {},
  ): Session {
    const session = new Session(sid, serverName, conn, {
      ...options,
      idleTimeoutMs,
      now: this.now,
      logger: this.logger,
      onClosed: (closed) => this.bury(closed),
    });
    this.sessions.set(sid, session);
    return session;
  }

  get(sid: string): Session {
    const session = this.sessions.get(sid);
    if (!session) throw new Error(`session ${JSON.stringify(sid)} not found`);
    return session;
  }

  find(sid: string): Session | undefined {
    return this.sessions.get(sid);
  }

  stat(): SessionStat[] {
    return [...this.sessions.values()]
      .map((session) => session.stat())
      .sort((a, b) => a.sid.localeCompare(b.sid));
  }

  getTrace(sid: string, lastN: number, truncOutput: number): CommandTrace[] {
    const alive = this.sessions.get(sid);
    if (alive) return alive.getTraces(lastN, truncOutput);
    this.cleanupGraveyard();
    const entry = this.graveyard.get(sid);
    if (!entry) {
      throw new Error(`session ${JSON.stringify(sid)} not found (alive or within trace TTL)`);
    }
    return truncateTraces(entry.traces, lastN, truncOutput);
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) session.close();
  }

  private bury(session: Session): void {
    this.sessions.delete(session.sid);
    this.graveyard.set(session.sid, {
      traces: session.getTraces(0, 0),
      closedAt: this.now(),
    });
  }

  private cleanupGraveyard(): void {
    const now = this.now();
    for (const [sid, entry] of this.graveyard) {
      if (now - entry.closedAt > GRAVE_TTL_MS) this.graveyard.delete(sid);
    }
  }
}
