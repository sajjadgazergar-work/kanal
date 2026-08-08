'use client';

import { useState } from 'react';

/**
 * Provider validation form (plan §14.2 W1). POSTs to the API's
 * /providers/validate through the web route handler. Shows the raw probe
 * result as JSON so a failure is visible and copyable.
 */
export function ProviderValidateForm() {
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api');
  const [authKind, setAuthKind] = useState<'none' | 'bearer' | 'x_api_key' | 'custom_header'>('none');
  const [authHeader, setAuthHeader] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/providers/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, authKind, authHeader: authHeader || undefined }),
      });
      const body = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <div className="field">
        <label htmlFor="baseUrl">Base URL</label>
        <input id="baseUrl" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
      </div>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="authKind">Auth kind</label>
        <select id="authKind" value={authKind} onChange={(e) => setAuthKind(e.target.value as typeof authKind)}>
          <option value="none">none</option>
          <option value="bearer">Bearer</option>
          <option value="x_api_key">x-api-key</option>
          <option value="custom_header">custom header</option>
        </select>
      </div>
      {authKind !== 'none' ? (
        <div className="field">
          <label htmlFor="authHeader">Auth header value</label>
          <input id="authHeader" type="password" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
        </div>
      ) : null}
      <div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Probing…' : 'Validate'}
        </button>
      </div>
      {error ? (
        <div className="banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {result !== null ? (
        <pre style={{ background: 'var(--bg-subtle)', padding: 'var(--sp-3)', borderRadius: 6, overflow: 'auto', fontSize: 13 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </form>
  );
}
