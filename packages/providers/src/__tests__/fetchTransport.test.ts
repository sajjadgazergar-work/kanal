import { describe, expect, it, vi } from 'vitest';
import { FetchTransport } from '../fetchTransport.js';
import { loadEgress } from '../egress.js';

describe('FetchTransport guards (plan §16.2 #6 #7, §11.8)', () => {
  // Explicit allow-mode egress so the suite is deterministic under
  // `test:airgapped` (KANAL_EGRESS=deny), where the default would block.
  const allowEgress = loadEgress({});

  it('blocks a private IP before fetch is ever called (SSRF)', async () => {
    const fetchFn = vi.fn();
    const t = new FetchTransport({ ssrf: { allowPrivate: false }, egress: allowEgress, fetchFn });
    await expect(
      t.request({ method: 'GET', url: 'http://127.0.0.1:11434/api/tags' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('blocks a host that resolves to a private IP before fetch', async () => {
    const fetchFn = vi.fn();
    const t = new FetchTransport({ ssrf: { allowPrivate: false }, egress: allowEgress, fetchFn });
    await expect(
      t.request({ method: 'GET', url: 'http://127.0.0.1/x' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects file:// scheme before fetch', async () => {
    const fetchFn = vi.fn();
    const t = new FetchTransport({ ssrf: { allowPrivate: false }, egress: allowEgress, fetchFn });
    await expect(t.request({ method: 'GET', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'egress_denied' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('egress guard blocks an un-allow-listed host in deny mode before fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const egress = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: 'localhost' });
    const t = new FetchTransport({ egress, fetchFn });
    await expect(
      t.request({ method: 'GET', url: 'http://api.openai.com/v1/models' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('egress guard permits an allow-listed host and performs the request', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const egress = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: 'localhost' });
    // allowPrivate permits the loopback host; the egress guard still requires
    // the hostname to be in the allow-list.
    const t = new FetchTransport({ egress, ssrf: { allowPrivate: true }, fetchFn });
    const resp = await t.request({ method: 'GET', url: 'http://localhost:11434/api/tags' });
    expect(resp.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('re-checks SSRF after a redirect hop', async () => {
    // First response redirects to a private address; fetch itself is mocked
    // so the redirect Location header triggers the hop re-check.
    let calls = 0;
    const fetchFn = vi.fn(async (_url: string) => {
      calls++;
      if (calls === 1) {
        return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/meta' } });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    // Host resolves to a public IP (allowed); the redirect target is checked
    // directly by its literal IP so no resolution is needed there.
    const resolver = async () => ['8.8.8.8'];
    const t = new FetchTransport({ ssrf: { allowPrivate: false }, egress: allowEgress, fetchFn, resolver });
    await expect(t.request({ method: 'GET', url: 'https://api.example.com/v1/models' })).rejects.toMatchObject({
      code: 'egress_denied',
    });
  });

  it('passes through a healthy 200 response', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const resolver = async () => ['93.184.216.34'];
    const t = new FetchTransport({ ssrf: { allowPrivate: false }, egress: allowEgress, fetchFn, resolver });
    const resp = await t.request({ method: 'GET', url: 'https://api.example.com/v1/models' });
    expect(resp.status).toBe(200);
  });
});
