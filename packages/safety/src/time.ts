/**
 * Deterministic time helpers for the safety engine (plan §15.6).
 *
 * `quiet_hours.tz` may be 'channel', in which case the caller supplies the
 * channel's IANA timezone so quiet hours are evaluated in channel-local wall
 * clock time (a "00:30" quiet start means 00:30 in Tehran, not in UTC).
 *
 * All engine math is pure over explicit timestamps; `now` is always injected
 * by the caller (defaults to `new Date().toISOString()` in convenience
 * wrappers only). This keeps the engine deterministic and testable.
 */

/** Hours as "HH:mm" (24-hour, zero-padded). */
export type ClockTime = string;

/** Returns the minute-of-day for a "HH:mm" string, or null when malformed. */
export function minutesOfDay(hhmm: string): number | null {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return h * 60 + Number(m[2]);
}

/** True when `atMs` falls inside the inclusive window [start, end]. */
export function inQuietHours(
  atMs: number,
  start: string,
  end: string,
  tz: string,
  channelTz?: string,
): boolean {
  const tzFor = tz === 'channel' ? channelTz : tz;
  if (!tzFor) throw new Error(`quiet_hours.tz is '${tz}' but no channel timezone was supplied`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tzFor,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(atMs);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return minutesOfDay(`${pad2(hour)}:${pad2(minute)}`) === null
    ? false
    : inWindow(minutesOfDay(`${pad2(hour)}:${pad2(minute)}`) as number, start, end);
}

function inWindow(min: number, start: string, end: string): boolean {
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s === null || e === null) return false;
  if (s === e) return false; // zero-length window
  // End is exclusive: a post exactly at the window end is the first legal slot.
  if (s < e) return min >= s && min < e;
  // Overnight window (e.g. 22:00 → 06:00 crosses midnight).
  return min >= s || min < e;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** End of the current quiet window in epoch ms, used to compute deferrals. */
export function quietWindowEnd(
  atMs: number,
  start: string,
  end: string,
  tz: string,
  channelTz?: string,
): number {
  // Walk forward at most 24h looking for a minute not inside quiet hours.
  let t = atMs;
  for (let i = 0; i < 24 * 60; i++) {
    if (!inQuietHours(t, start, end, tz, channelTz)) return t;
    t += 60_000;
  }
  return t;
}

/** Minutes until the next minute that is not inside quiet hours. */
export function minutesUntilQuietEnd(
  atMs: number,
  start: string,
  end: string,
  tz: string,
  channelTz?: string,
): number {
  const endMs = quietWindowEnd(atMs, start, end, tz, channelTz);
  return Math.max(0, Math.ceil((endMs - atMs) / 60_000));
}
