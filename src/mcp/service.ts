import type { Store } from "../config/store.js";

export class Service {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly store: Store) {}

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
