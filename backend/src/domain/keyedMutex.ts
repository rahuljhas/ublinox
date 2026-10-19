import { Errors } from "./errors.js";

/**
 * In-process async mutex keyed by string (e.g. "cart:abc", "product:p-print").
 *
 * Node runs JavaScript on one thread, so a block of code with no `await` can never interleave
 * with another request. Locks are needed only where a flow awaits (the payment call) while it
 * must keep exclusive ownership of a cart, its products and a coupon.
 *
 * Keys are always acquired in sorted order, so two flows that need overlapping keys cannot
 * deadlock. Callers that need the cart lock first take it alone, then take the rest.
 *
 * Waiting is bounded: after `waitMs` in line a request gives up with 503 SERVER_BUSY instead of
 * queueing forever behind a slow checkout.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  constructor(private readonly waitMs = 10_000) {}

  async acquire(keys: string[]): Promise<() => void> {
    const ordered = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of ordered) releases.push(await this.lockOne(key));
    } catch (error) {
      for (const release of releases.reverse()) release(); // do not keep the keys we already got
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  private lockOne(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    const free = () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Give up our place in line, but still pass the lock on when our turn comes,
        // otherwise everyone queued behind us would wait forever.
        void previous.then(free);
        reject(Errors.serverBusy(key));
      }, this.waitMs);
      void previous.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(free);
      });
    });
  }
}
