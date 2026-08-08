import { getApiConfig, healthz } from '@/lib/kanal-api';
import { StartRunForm } from './start-run-form';
import { KanalApiError } from '@/lib/kanal-api';

/**
 * Today (plan §14.2, band 1). With no runs yet this is the M0 landing: a short
 * explanation, one primary action, and an API health check. The live run list
 * lives on /runs; the SSE stream feeds the client updates.
 */

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let apiOk: boolean;
  let apiError: string | null = null;
  try {
    const cfg = getApiConfig();
    const h = await healthz(cfg);
    apiOk = h.status === 'ok';
  } catch (err) {
    apiOk = false;
    apiError = err instanceof KanalApiError ? err.message : err instanceof Error ? err.message : 'unknown error';
  }

  return (
    <>
      <h1>Today</h1>

      {apiOk ? null : (
        <div className="banner-error" role="alert">
          <strong>API unreachable.</strong> {apiError ?? 'Check KANAL_API_URL and KANAL_API_KEY in the web env.'}
        </div>
      )}

      <div className="card">
        <h2>Start a run</h2>
        <p className="muted">
          A run is one editorial job from brief to publish. Choose a lane — AUTO runs unattended,
          CO-PILOT asks you to approve, MANUAL keeps every step human.
        </p>
        <StartRunForm disabled={!apiOk} />
      </div>

      <div className="card">
        <h2>What happens next</h2>
        <p>
          The worker picks up the run, moves it through the pipeline stages, and parks it at any
          human gate. Every stage emits a span — the trace view on <span className="code">/runs/:id</span>{' '}
          renders the same data.
        </p>
      </div>
    </>
  );
}
