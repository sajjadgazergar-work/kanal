import { getApiConfig, getRun, KanalApiError } from '@/lib/kanal-api';
import { RunDetail } from './run-detail';
import type { RunSnapshot } from '@/lib/kanal-api';

/**
 * Run trace (plan §14.2 W3, §13.5). Server-rendered snapshot from the API,
 * then the client component subscribes to the SSE stream for live updates and
 * exposes the signal actions (approve, cancel, resume, lane change).
 */
export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let snapshot: RunSnapshot | null = null;
  let error: string | null = null;

  try {
    snapshot = await getRun(getApiConfig(), id);
  } catch (err) {
    if (err instanceof KanalApiError && err.status === 404) {
      error = 'run_not_found';
    } else {
      error = err instanceof Error ? err.message : 'failed to load run';
    }
  }

  if (error === 'run_not_found') {
    return (
      <>
        <h1>Run not found</h1>
        <p className="muted">No run with id <span className="code">{id}</span> exists, or the API cannot reach the database.</p>
        <a className="btn" href="/runs">
          Back to runs
        </a>
      </>
    );
  }

  if (error !== null || snapshot === null) {
    return (
      <>
        <h1>Error</h1>
        <div className="banner-error" role="alert">
          {error}
        </div>
      </>
    );
  }

  return <RunDetail runId={id} initial={snapshot} />;
}
