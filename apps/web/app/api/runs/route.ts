import { NextResponse } from 'next/server';
import { getApiConfig, startRun, KanalApiError, type StartRunBody } from '@/lib/kanal-api';

/**
 * POST /api/runs — proxy to the KANAL API's POST /api/v1/runs.
 * The API key stays server-side; the browser only ever talks to this route.
 */
export async function POST(request: Request) {
  let body: StartRunBody;
  try {
    body = (await request.json()) as StartRunBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'request body must be JSON' }, { status: 400 });
  }

  // Minimal shape validation — the API re-validates with zod.
  if (!body.orgId || !body.channelId) {
    return NextResponse.json({ error: 'invalid_body', message: 'orgId and channelId are required' }, { status: 400 });
  }

  try {
    const handle = await startRun(getApiConfig(), body);
    return NextResponse.json(handle, { status: 201 });
  } catch (err) {
    if (err instanceof KanalApiError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'internal', message: 'proxy request failed' }, { status: 502 });
  }
}
