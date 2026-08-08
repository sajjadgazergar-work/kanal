import { DEFAULT_PACING_POLICY } from '@kanal/contracts';

/**
 * Anomaly detector (plan §15.6 #4).
 *
 * A 5-minute job computes, per channel:
 *   - posting rate versus the 14-day baseline (z-score)
 *   - 429 rate
 *   - subscriber delta versus baseline
 *   - publish failure rate
 *
 * Any of |z| > 3 on posting rate, 429 rate above 5% over 15 minutes, or a
 * subscriber drop exceeding 2% in an hour triggers an automatic channel halt.
 *
 * Auto-halt is deliberately trigger-happy: a false halt costs a delayed post,
 * a missed anomaly can cost a channel. The detector therefore uses a one-sided
 * z (only excessive *or collapsed* posting is suspicious in opposite ways) but
 * treats |z| > 3 on either side as an anomaly.
 */

export interface PostingSample {
  /** Number of publishes in the sample window. */
  count: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface AnomalyInput {
  /** Posting count in the current 5-minute window. */
  currentCount: number;
  currentWindowMs?: number;
  /** 14-day baseline posting samples, one per 5-minute slot. */
  baselineSamples: PostingSample[];
  /** 429 responses in the last 15 minutes. */
  rateLimited15m: number;
  /** Successful publishes in the last 15 minutes. */
  success15m: number;
  /** Subscriber count now. */
  subscribersNow: number;
  /** Subscriber count one hour ago. */
  subscribersHourAgo: number;
  /** Publish failures in the last 15 minutes. */
  failures15m: number;
  publishes15m: number;
}

export interface AnomalyFinding {
  metric: 'posting_rate' | 'rate_429' | 'subscriber_drop' | 'publish_failure';
  severity: 'halt';
  value: number;
  threshold: number;
  message: string;
}

export interface AnomalyReport {
  halted: boolean;
  findings: AnomalyFinding[];
  metrics: {
    zScore: number;
    postingRatePer5m: number;
    baselineMeanPer5m: number;
    baselineStd: number;
    rate429Ratio: number;
    subscriberDeltaPct: number;
    failureRate: number;
  };
}

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** z-score of `x` against baseline. Returns 0 when std is 0. */
export function zScore(x: number, mean: number, std: number): number {
  if (std === 0) return 0;
  return (x - mean) / std;
}

/**
 * Run the anomaly detector. Deliberately trigger-happy: any anomalous signal
 * produces a `halt` finding. Returns a report with `halted` set when any
 * finding fires.
 */
export function detectAnomalies(input: AnomalyInput): AnomalyReport {
  const findings: AnomalyFinding[] = [];

  // Baseline per-5m posting rate.
  const slotMs = input.currentWindowMs ?? 5 * 60_000;
  const currentPer5m = (input.currentCount / slotMs) * 5 * 60_000;
  const baselineRates = input.baselineSamples.map((s) => (s.count / s.windowMs) * 5 * 60_000);
  const { mean, std } = meanStd(baselineRates);
  let z = zScore(currentPer5m, mean, std);
  // Deliberately trigger-happy: a perfectly stable baseline (std 0) means any
  // deviation is anomalous, so we cap the floor of detectability at |z| = 6
  // when the current rate differs at all from the baseline mean.
  if (std === 0 && currentPer5m !== mean) {
    z = currentPer5m > mean ? 6 : -6;
  }

  if (Math.abs(z) > 3) {
    findings.push({
      metric: 'posting_rate',
      severity: 'halt',
      value: z,
      threshold: 3,
      message: `posting rate z-score ${z.toFixed(2)} exceeds |3| (current ${currentPer5m.toFixed(2)}/5m vs baseline mean ${mean.toFixed(2)})`,
    });
  }

  // 429 rate above 5% over 15 minutes.
  const total429 = input.rateLimited15m;
  const rate429Ratio = total429 / Math.max(1, total429 + input.success15m);
  if (rate429Ratio > 0.05) {
    findings.push({
      metric: 'rate_429',
      severity: 'halt',
      value: rate429Ratio,
      threshold: 0.05,
      message: `429 rate ${(rate429Ratio * 100).toFixed(1)}% exceeds 5% over 15 minutes`,
    });
  }

  // Subscriber drop > 2% in an hour.
  const subscriberDeltaPct =
    input.subscribersHourAgo > 0
      ? ((input.subscribersNow - input.subscribersHourAgo) / input.subscribersHourAgo) * 100
      : 0;
  if (subscriberDeltaPct < -2) {
    findings.push({
      metric: 'subscriber_drop',
      severity: 'halt',
      value: subscriberDeltaPct,
      threshold: -2,
      message: `subscriber delta ${subscriberDeltaPct.toFixed(2)}% exceeds 2% drop in the last hour`,
    });
  }

  // Publish failure rate.
  const failureRate = input.publishes15m > 0 ? input.failures15m / input.publishes15m : 0;
  if (failureRate > 0.3) {
    findings.push({
      metric: 'publish_failure',
      severity: 'halt',
      value: failureRate,
      threshold: 0.3,
      message: `publish failure rate ${(failureRate * 100).toFixed(1)}% exceeds 30% over 15 minutes`,
    });
  }

  return {
    halted: findings.length > 0,
    findings,
    metrics: {
      zScore: z,
      postingRatePer5m: currentPer5m,
      baselineMeanPer5m: mean,
      baselineStd: std,
      rate429Ratio,
      subscriberDeltaPct,
      failureRate,
    },
  };
}

export { DEFAULT_PACING_POLICY };
