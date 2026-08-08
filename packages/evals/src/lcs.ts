/**
 * Longest common substring between two strings. O(n·m) DP, with a
 * single-array optimization. Returns the start offsets in each string and the
 * length of the first maximal match; the tie-break is the earliest start in
 * `a` (stable across calls).
 */
export interface LcsMatch {
  aStart: number;
  bStart: number;
  len: number;
}

export function longestCommonSubstring(a: string, b: string): LcsMatch {
  const n = a.length;
  const m = b.length;
  let best = 0;
  let aStart = 0;
  let bStart = 0;
  // dp[j] = length of common suffix ending at a[i-1] / b[j-1].
  const dp: Uint32Array = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j] ?? 0;
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        const cur = prev + 1;
        dp[j] = cur;
        if (cur > best) {
          best = cur;
          aStart = i - cur;
          bStart = j - cur;
        }
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return { aStart, bStart, len: best };
}
