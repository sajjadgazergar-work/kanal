'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Start-run form (plan §12.2, §14.2). Submits to the API route handler; on
 * success it navigates to the new run's trace. This is a client component so
 * the form state and submission stay interactive after the RSC shell renders.
 */

export function StartRunForm({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [lane, setLane] = useState<'auto' | 'copilot' | 'manual'>('copilot');
  const [orgId, setOrgId] = useState('00000000-0000-0000-0000-000000000001');
  const [channelId, setChannelId] = useState('');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('0.15');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId,
          channelId,
          lane,
          brief: brief.trim() ? { rawBrief: brief } : {},
          manifestSetHash: 'dev',
          promptPackVersion: 'default@1',
          budgetCapUsd: Number(budget),
        }),
      });
      const body = (await res.json()) as { runId?: string; error?: string; message?: string };
      if (!res.ok || !body.runId) {
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/runs/${body.runId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="lane">Lane</label>
          <select id="lane" value={lane} onChange={(e) => setLane(e.target.value as typeof lane)}>
            <option value="copilot">CO-PILOT (approve topic + publish)</option>
            <option value="auto">AUTO (unattended)</option>
            <option value="manual">MANUAL (write it yourself)</option>
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="orgId">Org id</label>
          <input id="orgId" type="text" value={orgId} onChange={(e) => setOrgId(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="channelId">Channel id</label>
        <input
          id="channelId"
          type="text"
          placeholder="-1001234567890"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="brief">Brief</label>
        <textarea
          id="brief"
          rows={3}
          placeholder="e.g. A 2–3 paragraph explainer on why pnpm is faster than npm for our team."
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
      </div>
      <div className="row">
        <div className="field" style={{ width: 180 }}>
          <label htmlFor="budget">Budget cap (USD)</label>
          <input id="budget" type="number" step="0.01" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || disabled}>
          {busy ? 'Starting…' : 'Start run'}
        </button>
      </div>
      {error ? (
        <div className="banner-error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
