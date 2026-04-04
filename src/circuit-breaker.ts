/**
 * Per-target circuit breaker.
 * After `threshold` consecutive failures, the circuit opens and rejects
 * all calls for `cooldownMs`. After cooldown, one test call is allowed
 * (half-open). Success resets; failure re-opens.
 */

export enum CircuitState {
  Closed = "closed",
  Open = "open",
  HalfOpen = "half_open",
}

interface Circuit {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number;
  halfOpenAttempts: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private circuits = new Map<string, Circuit>();

  constructor(
    private threshold: number = 5,
    private cooldownMs: number = 120_000,
  ) {}

  private get(key: string): Circuit {
    let c = this.circuits.get(key);
    if (!c) {
      c = {
        state: CircuitState.Closed,
        failureCount: 0,
        lastFailureAt: 0,
        halfOpenAttempts: 0,
        totalFailures: 0,
        totalSuccesses: 0,
      };
      this.circuits.set(key, c);
    }
    return c;
  }

  canRequest(key: string): boolean {
    const c = this.get(key);

    if (c.state === CircuitState.Closed) return true;

    if (c.state === CircuitState.Open) {
      if (Date.now() - c.lastFailureAt >= this.cooldownMs) {
        c.state = CircuitState.HalfOpen;
        c.halfOpenAttempts = 0;
        return true;
      }
      return false;
    }

    // HalfOpen — allow one test
    if (c.halfOpenAttempts < 1) {
      c.halfOpenAttempts++;
      return true;
    }
    return false;
  }

  recordSuccess(key: string): void {
    const c = this.get(key);
    c.failureCount = 0;
    c.state = CircuitState.Closed;
    c.totalSuccesses++;
  }

  recordFailure(key: string): void {
    const c = this.get(key);
    c.failureCount++;
    c.lastFailureAt = Date.now();
    c.totalFailures++;

    if (c.state === CircuitState.HalfOpen) {
      c.state = CircuitState.Open;
      return;
    }

    if (c.failureCount >= this.threshold) {
      c.state = CircuitState.Open;
    }
  }

  getStatus(key: string): {
    key: string;
    state: string;
    failureCount: number;
    cooldownRemaining: number;
    totalFailures: number;
    totalSuccesses: number;
  } {
    const c = this.get(key);
    return {
      key,
      state: c.state,
      failureCount: c.failureCount,
      cooldownRemaining:
        c.state === CircuitState.Open
          ? Math.max(0, this.cooldownMs - (Date.now() - c.lastFailureAt))
          : 0,
      totalFailures: c.totalFailures,
      totalSuccesses: c.totalSuccesses,
    };
  }

  getAllStatuses() {
    return Array.from(this.circuits.keys()).map((k) => this.getStatus(k));
  }

  reset(key: string): void {
    this.circuits.delete(key);
  }

  resetAll(): void {
    this.circuits.clear();
  }
}
