import { runRegression, formatRegressionReport } from './regression.js';

/**
 * `pnpm eval:run` — executes the fixed briefs through the deterministic
 * scorers and reports the composite distribution. Fails (exit 1) when the mean
 * drops ≥ 0.05 against the committed baseline.
 */

async function main(): Promise<void> {
  const report = await runRegression();
  console.log(formatRegressionReport(report));
  if (!report.pass) {
    console.error(`eval:run FAILED: mean composite dropped ${report.drop.toFixed(4)} (limit 0.05)`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('eval:run crashed', err);
  process.exitCode = 1;
});
