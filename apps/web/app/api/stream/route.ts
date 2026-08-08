import { getApiConfig } from '@/lib/kanal-api';

/**
 * GET /api/stream — server-side SSE proxy to the KANAL API's live stream
 * (GET /api/v1/streams/runs). The browser connects to the Next server, which
 * pipes the Fastify event stream through, so the API key never leaves the
 * server. `Last-Event-ID` is forwarded so reconnect replays the gap.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cfg = getApiConfig();
  const since = request.headers.get('last-event-id');
  const url = new URL(`${cfg.baseUrl}/api/v1/streams/runs`);
  if (since) url.searchParams.set('since', since);

  const upstream = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      ...(since ? { 'last-event-id': since } : {}),
    },
    cache: 'no-store',
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`upstream error: HTTP ${upstream.status}`, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
