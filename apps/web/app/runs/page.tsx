import { getApiConfig } from '@/lib/kanal-api';
import { RunList } from './run-list';

/**
 * Runs list. The API has no list endpoint yet (plan §12.2 is describe-only),
 * so this page hosts the SSE client (run-list.tsx), which accumulates run ids
 * it has seen on the live stream and shows their latest state.
 */

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  let apiOk = true;
  try {
    await getApiConfig();
  } catch {
    apiOk = false;
  }

  return (
    <>
      <h1>Runs</h1>
      {apiOk ? (
        <RunList />
      ) : (
        <div className="banner-error" role="alert">
          KANAL_API_KEY is not configured on the web server. Set it in the web env to talk to the API.
        </div>
      )}
    </>
  );
}
