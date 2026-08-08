'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/** Minimal shape of the LiveEvent envelope (plan §13.3). */
interface LiveEnvelope {
  id: string;
  event: {
    t: string;
    runId?: string;
    state?: string;
    stage?: string;
    at?: string;
    [k: string]: unknown;
  };
}

interface RunView {
  runId: string;
  state: string;
  lastStage: string;
  updatedAt: string;
  seen: number;
}

/**
 * Live run list fed by the SSE proxy. The API has no list endpoint yet
 * (plan §12.2 is describe-only), so this accumulates run ids from the stream
 * and shows their latest known state. New runs are added at the top; a run
 * that stops producing events still appears with its last state.
 */
export function RunList() {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      es = new EventSource('/api/stream');
      setError(null);

      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // The EventSource retries automatically; surface a stale state after
        // a few seconds rather than a noisy banner on every transient drop.
        if (retry === null) {
          retry = setTimeout(() => {
            if (!disposed && es !== null && es.readyState !== EventSource.OPEN) {
              setError('Live stream disconnected. Reconnecting automatically.');
            }
            retry = null;
          }, 8000);
        }
      };
      es.onmessage = (msg) => {
        try {
          const env = JSON.parse(msg.data) as LiveEnvelope;
          const runId = env.event.runId;
          if (!runId) return;
          setRuns((prev) => {
            const idx = prev.findIndex((r) => r.runId === runId);
            const view: RunView = {
              runId,
              state: env.event.state ?? prev[idx]?.state ?? 'unknown',
              lastStage: env.event.stage ?? prev[idx]?.lastStage ?? '—',
              updatedAt: env.event.at ?? prev[idx]?.updatedAt ?? '',
              seen: (prev[idx]?.seen ?? 0) + 1,
            };
            if (idx === -1) return [view, ...prev];
            const next = [...prev];
            next[idx] = view;
            return next;
          });
        } catch {
          // malformed frame — skip
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      es?.close();
    };
  }, []);

  if (error) {
    return (
      <div className="banner-error" role="alert">
        {error}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="card">
        <p className="muted">
          {connected ? 'No runs yet. Start one from Today.' : 'Connecting to the live stream…'}
        </p>
        <Link className="btn" href="/">
          Start a run
        </Link>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row">
        <p className="muted">
          Live {connected ? '· connected' : '· reconnecting'} · {runs.length} run{runs.length === 1 ? '' : 's'} seen
        </p>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Run</th>
            <th>State</th>
            <th>Stage</th>
            <th>Events</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId}>
              <td>
                <span className="code">{r.runId.slice(0, 12)}</span>
                {r.updatedAt ? <span className="muted"> · {r.updatedAt}</span> : null}
              </td>
              <td>
                <span className="badge" data-state={r.state}>
                  {r.state}
                </span>
              </td>
              <td>{r.lastStage}</td>
              <td>{r.seen}</td>
              <td>
                <Link className="btn" href={`/runs/${r.runId}`}>
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
