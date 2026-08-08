import { ProviderValidateForm } from './provider-validate-form';

/**
 * Provider settings (plan §14.2 W1, §11.2). V1 exposes the discovery + probe
 * flow; adding a persisted provider row is a later milestone that needs the
 * provider table write path.
 */
export const dynamic = 'force-dynamic';

export default function ProvidersPage() {
  return (
    <>
      <h1>Providers</h1>
      <div className="card">
        <h2>Validate a provider endpoint</h2>
        <p className="muted">
          Runs discovery + capability probes against a base URL. The probe reports
          which of the six capabilities the endpoint supports (plan §11.4).
        </p>
        <ProviderValidateForm />
      </div>
    </>
  );
}
