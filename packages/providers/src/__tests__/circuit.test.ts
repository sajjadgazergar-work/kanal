import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../circuit.js';

describe('circuit breaker (plan §11.6)', () => {
  it('is closed initially', () => {
    const c = new CircuitBreaker();
    expect(c.getState()).toBe('closed');
    expect(c.isOpen()).toBe(false);
  });

  it('opens after 5 failures in the window', () => {
    const c = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, openMs: 30_000 });
    for (let i = 0; i < 4; i++) {
      c.recordFailure();
      expect(c.isOpen()).toBe(false);
    }
    const opened = c.recordFailure();
    expect(opened).toBe(true);
    expect(c.isOpen()).toBe(true);
  });

  it('acquire() throws CircuitOpenError when open', async () => {
    const c = new CircuitBreaker({ failureThreshold: 2, windowMs: 60_000, openMs: 30_000 });
    c.recordFailure();
    c.recordFailure();
    await expect(c.acquire()).rejects.toThrow(CircuitOpenError);
  });

  it('recovers to half-open after the cooldown, then closes on a trial success', async () => {
    const now = vi.fn(() => 1_000_000);
    const c = new CircuitBreaker({ failureThreshold: 2, windowMs: 60_000, openMs: 30_000, now });
    c.recordFailure();
    c.recordFailure();
    expect(c.getState()).toBe('open');

    // Before cooldown: still open.
    now.mockReturnValue(1_000_000 + 29_000);
    expect(c.isOpen()).toBe(true);

    // After cooldown: half-open.
    now.mockReturnValue(1_000_000 + 30_000);
    expect(c.getState()).toBe('half_open');
    expect(c.isOpen()).toBe(false);

    // Trial success closes.
    await c.acquire();
    c.recordSuccess();
    expect(c.getState()).toBe('closed');
  });

  it('a failed half-open trial re-opens immediately', async () => {
    const now = vi.fn(() => 5_000_000);
    const c = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, openMs: 30_000, now });
    c.recordFailure();
    now.mockReturnValue(5_000_000 + 30_000);
    expect(c.getState()).toBe('half_open');
    await c.acquire();
    const reopened = c.recordFailure();
    expect(reopened).toBe(true);
    expect(c.getState()).toBe('open');
  });

  it('failures older than the window roll off', () => {
    const now = vi.fn(() => 1000);
    const c = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, openMs: 30_000, now });
    c.recordFailure();
    c.recordFailure();
    now.mockReturnValue(70_000);
    expect(c.recentFailures()).toBe(0);
    expect(c.isOpen()).toBe(false);
  });

  it('half-open sheds concurrent trials', async () => {
    const now = vi.fn(() => 1_000);
    const c = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, openMs: 30_000, now });
    c.recordFailure();
    now.mockReturnValue(1_000 + 30_000);
    await c.acquire(); // first trial
    await expect(c.acquire()).rejects.toThrow(CircuitOpenError);
  });

  it('recordSuccess prunes failures and closes', () => {
    const c = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, openMs: 30_000 });
    c.recordFailure();
    c.recordFailure();
    c.recordSuccess();
    expect(c.recentFailures()).toBe(0);
    expect(c.isOpen()).toBe(false);
  });
});
