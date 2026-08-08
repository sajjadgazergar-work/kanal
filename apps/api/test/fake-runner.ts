import type { Runner, RunSignal, StartRunInput, RunSnapshot } from '@kanal/core';

/**
 * In-memory fake implementing the `Runner` seam (plan §12.2). Lets the API
 * routes be tested with `fastify.inject()` without touching Postgres.
 */
export class FakeRunner implements Runner {
  public starts: StartRunInput[] = [];
  public signals: Array<{ runId: string; sig: RunSignal }> = [];
  public cancels: Array<{ runId: string; reason: string }> = [];
  /** runId → snapshot returned by describe. */
  public snapshots = new Map<string, RunSnapshot>();
  /** When set, describe throws (simulates a missing run). */
  public describeThrows = false;
  public signalThrows = false;

  async start(input: StartRunInput): Promise<{ runId: string }> {
    this.starts.push(input);
    return { runId: `run-${this.starts.length}` };
  }

  async signal(runId: string, sig: RunSignal): Promise<void> {
    if (this.signalThrows) throw new Error('invalid transition');
    this.signals.push({ runId, sig });
    if (sig.kind === 'cancel') {
      await this.cancel(runId, 'cancel signal');
    }
  }

  async cancel(runId: string, reason: string): Promise<void> {
    this.cancels.push({ runId, reason });
  }

  async describe(runId: string): Promise<RunSnapshot> {
    if (this.describeThrows) throw new Error('row not found');
    const snap = this.snapshots.get(runId);
    if (snap === undefined) {
      throw new Error(`no such run ${runId}`);
    }
    return snap;
  }

  /** Convenience: register a snapshot for describe(). */
  setSnapshot(runId: string, snapshot: Partial<RunSnapshot>): void {
    this.snapshots.set(runId, {
      runId,
      orgId: '00000000-0000-0000-0000-000000000001',
      state: 'intake',
      cursorStage: 'intake',
      lane: 'copilot',
      spentUsd: 0,
      budgetCapUsd: 0.15,
      cancelRequested: false,
      steps: [],
      ...snapshot,
    });
  }
}

export function sampleSnapshot(runId: string): RunSnapshot {
  return {
    runId,
    orgId: '00000000-0000-0000-0000-000000000001',
    state: 'review_pending',
    cursorStage: 'ops.publish',
    lane: 'copilot',
    spentUsd: 0.0123,
    budgetCapUsd: 0.15,
    cancelRequested: false,
    steps: [{ stage: 'strategy.brief', attempt: 1, state: 'done' }],
  };
}
