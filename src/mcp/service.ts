import path from "node:path";
import type { Store } from "../config/store.js";
import { nullLogger, type Logger } from "../log.js";
import { SessionManager } from "../session/manager.js";
import { KnownHostsStore } from "../ssh/known_hosts.js";

export interface ServiceOptions {
  manager?: SessionManager;
  knownHosts?: KnownHostsStore;
  logger?: Logger;
}

export class Service {
  private tail: Promise<unknown> = Promise.resolve();
  readonly manager: SessionManager;
  readonly knownHosts: KnownHostsStore;
  readonly logger: Logger;

  constructor(readonly store: Store, options: ServiceOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.manager = options.manager ?? new SessionManager({ logger: this.logger });
    this.knownHosts = options.knownHosts
      ?? new KnownHostsStore(path.join(path.dirname(store.path), "known_hosts"));
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
