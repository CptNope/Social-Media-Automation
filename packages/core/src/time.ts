/**
 * Time-zone helpers without dependencies (Intl only). Scheduling is done in the client's
 * local time and stored as UTC instants.
 */
const dtf = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtf.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    dtf.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at the given instant. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = Object.fromEntries(formatter(tz).formatToParts(instant).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Local wall-clock date ("YYYY-MM-DD") and time ("HH:MM") in `tz` → UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dm || !tm) throw new Error(`Invalid local date/time: ${date} ${time}`);
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  // Two passes handle DST transitions.
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz);
  return new Date(utc);
}

/** UTC instant → local "YYYY-MM-DD" in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const p = Object.fromEntries(formatter(tz).formatToParts(instant).map((x) => [x.type, x.value])) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Add days to a "YYYY-MM-DD" calendar date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const DEFAULT_TIMEZONE = "America/New_York";
