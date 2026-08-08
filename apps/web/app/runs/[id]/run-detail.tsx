'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RunSnapshot } from '@/lib/kanal-api';

/**
 * Run detail: server snapshot + live SSE + signal actions. State changes from
 * the stream update the header badge and the step list in place; the signal
 * buttons POST to the API proxy and refresh the snapshot.
 */

const TERMINAL = new Set(['cancelled', 'published', 'failed', 'dead']);

export function RunDetail({ runId, initial }: { runId: string; initial: RunSnapshot }) {
  const router = useRouter();
  const [run, setRun] = useState<RunSnapshot>(initial);
  const [liveStage, setLiveStage] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const env = JSON.parse(msg.data) as {
          event: { runId?: string; state?: string; stage?: string };
        };
        if (env.event.runId !== runId) return;
        if (env.event.state) {
          setRun((prev) => ({ ...prev, state: env.event.state as RunSnapshot['state'] }));
        }
        if (env.event.stage) setLiveStage(env.event.stage);
      } catch {
        // malformed frame
      }
    };
    return () => es.close();
  }, [runId]);

  async function signal(body: unknown) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok) {
        setError(payload.message ?? payload.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  const canApprove = run.state === 'review_pending';
  const canCancel = !TERMINAL.has(run.state);

  return (
    <>
      <div className="row" style={{ marginBottom: 'var(--sp-4)' }}>
        <h1 style={{ margin: 0 }}>Run</h1>
        <span className="code">{runId.slice(0, 16)}</span>
        <span className="badge" data-state={run.state}>
          {run.state}
        </span>
        <span className="muted">{connected ? 'live' : 'reconnecting'}</span>
      </div>

      <div className="card">
        <div className="row">
          <p className="muted">
            Lane <strong>{run.lane}</strong>
          </p>
          <p className="muted">
            Stage <span className="code">{run.cursorStage}</span>
            {liveStage ? <> · live <span className="code">{liveStage}</span></> : null}
          </p>
          <p className="muted">
            Spend <strong>${run.spentUsd.toFixed(4)}</strong> / cap ${run.budgetCapUsd.toFixed(2)}
          </p>
        </div>

        <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
          {canApprove ? (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => signal({ kind: 'approval', gate: 'draft', decision: 'granted', decidedBy: 'dashboard' })}
            >
              Approve
            </button>
          ) : null}
          {canApprove ? (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => signal({ kind: 'approval', gate: 'draft', decision: 'denied', decidedBy: 'dashboard' })}
            >
              Deny
            </button>
          ) : null}
          {canCancel ? (
            <button className="btn btn-danger" disabled={busy} onClick={() => signal({ kind: 'cancel' })}>
              Cancel run
            </button>
          ) : null}
          {!TERMINAL.has(run.state) ? (
            <button className="btn" disabled={busy} onClick={() => signal({ kind: 'resume' })}>
              Resume
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="banner-error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>
            {error}
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>Steps</h2>
        {run.steps.length === 0 ? (
          <p className="muted">No steps recorded yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Attempt</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((s, i) => (
                <tr key={`${s.stage}-${s.attempt}-${i}`}>
                  <td>
                    <span className="code">{s.stage}</span>
                  </td>
                  <td>{s.attempt}</td>
                  <td>
                    <span className="badge" data-state={s.state}>
                      {s.state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
