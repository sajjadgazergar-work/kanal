import { NextResponse } from 'next/server';
import { getApiConfig, signalRun, KanalApiError, type RunSignal } from '@/lib/kanal-api';

/** POST /api/runs/:id/signal — proxy to the KANAL API signal route. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let sig: RunSignal;
  try {
    sig = (await request.json()) as RunSignal;
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'request body must be JSON' }, { status: 400 });
  }

  try {
    await signalRun(getApiConfig(), id, sig);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof KanalApiError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'internal', message: 'proxy request failed' }, { status: 502 });
  }
}
