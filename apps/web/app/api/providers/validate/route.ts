import { NextResponse } from 'next/server';
import { getApiConfig, validateProvider, KanalApiError, type ValidateProviderBody } from '@/lib/kanal-api';

/** POST /api/providers/validate — proxy to the KANAL API provider probe. */
export async function POST(request: Request) {
  let body: ValidateProviderBody;
  try {
    body = (await request.json()) as ValidateProviderBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'request body must be JSON' }, { status: 400 });
  }

  try {
    const result = await validateProvider(getApiConfig(), body);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof KanalApiError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'internal', message: 'proxy request failed' }, { status: 502 });
  }
}
