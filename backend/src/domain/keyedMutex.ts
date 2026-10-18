/**
 * In-process async mutex keyed by string (e.g. "cart:abc", "product:p-print").
 *
 * Node runs JavaScript on one thread, so a block of code with no `await` can never interleave
 * with another request. Locks are needed only where a flow awaits (the payment call) while it
 * must keep exclusive ownership of a cart, its products and a coupon.
 *
 * Keys are always acquired in sorted order, so two flows that need overlapping keys cannot
 * deadlock. Callers that need the cart lock first take it alone, then take the rest.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async acquire(keys: string[]): Promise<() => void> {
    const ordered = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];
    for (const key of ordered) {
      releases.push(await this.lockOne(key));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  private async lockOne(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
