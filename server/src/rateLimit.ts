/** Generic per-connection token bucket, capacity/refill configurable per use site. */

const DEFAULT_CAPACITY = 20;
const DEFAULT_REFILL_PER_SECOND = 15; // PLAN.md Phase 1: block-placement target of 10-20/s

export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly refillPerSecond = DEFAULT_REFILL_PER_SECOND
  ) {
    this.tokens = capacity;
  }

  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
