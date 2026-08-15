/** Token bucket for per-connection block-placement rate limiting (PLAN.md Phase 1: 10-20/s). */

const CAPACITY = 20;
const REFILL_PER_SECOND = 15;

export class TokenBucket {
  private tokens = CAPACITY;
  private lastRefill = Date.now();

  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(CAPACITY, this.tokens + elapsedSeconds * REFILL_PER_SECOND);

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
