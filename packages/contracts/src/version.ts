/**
 * The compatibility contract (plan §7.6).
 *
 * The core exports this semver. Every agent manifest and prompt pack declares a
 * `core_api` range that must be satisfied for it to load. Bumping this major
 * means existing manifests refuse to load and `kanal migrate manifests` emits a
 * patch proposal per manifest.
 */
export const CORE_API_VERSION = '1.2.0';

/** Satisfies a `core_api` range like "^1.2" or ">=1.0 <2.0". */
export function satisfiesCoreApi(
  declaredRange: string,
  actual: string = CORE_API_VERSION,
): boolean {
  return satisfiesRange(declaredRange, actual);
}

/**
 * Minimal semver range checker. Supports:
 *   - exact "1.2.0"
 *   - caret "^1.2" / "^1.2.3"
 *   - tilde "~1.2"
 *   - OR ("||") and space-separated AND lists
 *   - comparison operators >=, <=, >, <, =
 */
export function satisfiesRange(range: string, version: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  // Split on "||" — any alternative satisfying is enough.
  return range
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((alt) => alt.split(/\s+/).every((part) => singleSatisfies(part, v)));
}

function singleSatisfies(single: string, v: Semver): boolean {
  const m = single.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return false;
  const [, op, rawVersion] = m as [string, string | undefined, string];
  const target = parseSemver(rawVersion);
  if (!target) return false;
  switch (op ?? '=') {
    case '=':
      return cmp(v, target) === 0;
    case '>':
      return cmp(v, target) > 0;
    case '<':
      return cmp(v, target) < 0;
    case '>=':
      return cmp(v, target) >= 0;
    case '<=':
      return cmp(v, target) <= 0;
    case '~': {
      // ~1.2.3 := >=1.2.3 <1.3.0
      const lo: Semver = { ...target, patch: target.patch };
      const hi: Semver = { ...target, minor: target.minor + 1, patch: 0 };
      return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
    }
    case '^': {
      // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2 := >=0.2 <0.3 ; ^0.0.3 := <0.0.4
      const lo: Semver = { ...target };
      if (target.major > 0) {
        return cmp(v, lo) >= 0 && cmp(v, { major: target.major + 1, minor: 0, patch: 0 }) < 0;
      }
      if (target.minor > 0) {
        return cmp(v, lo) >= 0 && cmp(v, { major: 0, minor: target.minor + 1, patch: 0 }) < 0;
      }
      return cmp(v, lo) >= 0 && cmp(v, { major: 0, minor: 0, patch: target.patch + 1 }) < 0;
    }
    default:
      return false;
  }
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): Semver | null {
  const m = s
    .trim()
    .match(
      /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
  };
}

function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
