import type { NextConfig } from 'next';

/**
 * The dashboard is a static-ish client that talks to the API through server
 * route handlers. We do not need image optimization; `output` stays on the
 * default node server so the SSE proxy works in `next dev` and `next start`.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The API is the source of truth; the dashboard never bundles secret keys.
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
