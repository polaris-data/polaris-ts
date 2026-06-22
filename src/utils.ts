import type { TimeInput } from "./types";

const EPOCH_RE = /^\d+$/;

// ---------------------------------------------------------------------------
// toIso8601
// ---------------------------------------------------------------------------

/**
 * Convert a {@link TimeInput} value to an ISO 8601 UTC string with a `Z` suffix.
 *
 * - `string` → returned as-is (assumed ISO 8601), unless it looks like an
 *   epoch microsecond integer (13+ digits) in which case it is converted.
 * - `Date`   → converted via `toISOString()`.
 * - `number` → treated as **epoch microseconds** when `> 1e12`,
 *   otherwise as **milliseconds**.
 */
export function toIso8601(value: TimeInput): string {
  if (typeof value === "string") {
    if (EPOCH_RE.test(value) && value.length >= 13) return epochUsToIso(Number(value));
    return value;
  }
  if (value instanceof Date) return dateToIso(value);
  return value > 1e12 ? epochUsToIso(value) : epochMsToIso(value);
}

// ---------------------------------------------------------------------------
// toEpochUs
// ---------------------------------------------------------------------------

/** Convert a {@link TimeInput} to **epoch microseconds** (integer). */
export function toEpochUs(value: TimeInput): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    if (EPOCH_RE.test(value) && value.length >= 13) return Number(value);
    return Math.round(new Date(value).getTime() * 1000);
  }
  return Math.round(value.getTime() * 1000);
}

// ---------------------------------------------------------------------------
// datesInRange
// ---------------------------------------------------------------------------

/**
 * Return an array of `"YYYY-MM-DD"` strings covering every UTC calendar date
 * that intersects `[fromUs, toUs)` (epoch microseconds, inclusive start /
 * exclusive end).
 */
export function datesInRange(fromUs: number, toUs: number): string[] {
  const dates: string[] = [];
  const start = new Date(fromUs / 1000);
  const end = new Date(toUs / 1000);

  const cur = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
  );

  while (cur <= last) {
    dates.push(formatUtcDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return dates;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function epochUsToIso(us: number): string {
  return epochMsToIso(us / 1000);
}

function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

function dateToIso(d: Date): string {
  return d.toISOString().replace(/\.000Z$/, "Z");
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
