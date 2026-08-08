/**
 * Circuit breaker (plan §11.6): 5 failures in a 60 s sliding window opens the
 * circuit for 30 s, then half-open with a single trial request.
 */

export interface CircuitOptions {
  failureThreshold?: number; // 5
  windowMs?: number; // 60_000
  openMs?: number; // 30_000
  now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('circuit is open');
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly openMs: number;
  private readonly now: () => number;
  private state: CircuitState = 'closed';
  private failures: number[] = [];
  private openedAt = 0;
  private halfOpenTrialActive = false;

  constructor(opts: CircuitOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.openMs = opts.openMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openMs) {
      // Transition to half-open lazily on the next call.
      return 'half_open';
    }
    return this.state;
  }

  /** May be called before a request. Throws CircuitOpenError when open and the
   * cooldown hasn't elapsed; when half-open and a trial is already active,
   * the call is shed. */
  async acquire(): Promise<void> {
    const st = this.getState();
    if (st === 'open') {
      const elapsed = this.now() - this.openedAt;
      const remaining = Math.max(0, this.openMs - elapsed);
      throw new CircuitOpenError(remaining);
    }
    if (st === 'half_open') {
      if (this.halfOpenTrialActive) {
        throw new CircuitOpenError(0);
      }
      this.halfOpenTrialActive = true;
      return;
    }
    return;
  }

  /** Record a failure. Returns true when this failure opened the circuit. */
  recordFailure(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    this.failures.push(t);
    if (this.halfOpenTrialActive) {
      // A trial failure re-opens immediately.
      this.halfOpenTrialActive = false;
      this.openCircuit();
      return true;
    }
    if (this.failures.length >= this.failureThreshold) {
      this.openCircuit();
      return true;
    }
    return false;
  }

  /** Record a success. Closes a half-open circuit; resets the failure count. */
  recordSuccess(): void {
    if (this.halfOpenTrialActive) {
      this.halfOpenTrialActive = false;
      this.close();
      return;
    }
    this.close();
  }

  private openCircuit(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.failures = [];
  }

  private close(): void {
    this.state = 'closed';
    this.openedAt = 0;
    this.failures = [];
  }

  /** Half-open is NOT open: a trial request may proceed. */
  isOpen(): boolean {
    return this.getState() === 'open';
  }

  /** Number of failures currently inside the sliding window. */
  recentFailures(): number {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    return this.failures.length;
  }
}
