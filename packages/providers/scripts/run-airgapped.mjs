// Runs the full unit suite with KANAL_EGRESS=deny so any feature that
// silently requires the internet fails (plan §11.8). Cross-platform: spawns
// the vitest CLI with the env var set, no shell quoting involved.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('vitest/package.json');
const cli = join(dirname(pkgPath), 'vitest.mjs');

const res = spawnSync(process.execPath, [cli, 'run'], {
  stdio: 'inherit',
  env: { ...process.env, KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: '' },
});
process.exit(res.status ?? 1);
