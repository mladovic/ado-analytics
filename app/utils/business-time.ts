export type Schedule = Readonly<{
  tz: "UTC";
  start: "09:00";
  end: "17:00";
  // Weekdays only (Mon-Fri). Numbers follow JS getUTCDay: 0=Sun ... 6=Sat
  days: ReadonlyArray<1 | 2 | 3 | 4 | 5>;
}>;

/**
 * Compute duration in business hours between two timestamps (ms).
 * - Interprets schedule in UTC (MVP fixed).
 * - Sums overlap with [start,end) across days included in `schedule.days`.
 */
export function businessDuration(start: Date, end: Date, schedule: Schedule): number {
  const tStart = start.getTime();
  const tEnd = end.getTime();
  if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) return 0;

  // Parse HH:mm boundaries (MVP fixed to 09:00-17:00 but keep generic).
  const [sh, sm] = parseHm(schedule.start);
  const [eh, em] = parseHm(schedule.end);
  if (sh == null || eh == null) return 0;

  let total = 0;

  // Iterate from the UTC date of `start` to the UTC date of `end` inclusive.
  let cursor = utcMidnight(start);
  const lastDay = utcMidnight(end);

  while (cursor.getTime() <= lastDay.getTime()) {
    const dow = cursor.getUTCDay();
    if ((schedule.days as ReadonlyArray<number>).includes(dow as 1 | 2 | 3 | 4 | 5)) {
      const winStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), sh, sm, 0, 0));
      const winEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), eh, em, 0, 0));
      const overlap = overlapMs(tStart, tEnd, winStart.getTime(), winEnd.getTime());
      if (overlap > 0) total += overlap;
    }
    cursor = addUtcDays(cursor, 1);
  }

  return total;
}

function parseHm(v: string): [number, number] | [null, null] {
  const m = /^(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return [null, null];
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return [null, null];
  if (h < 0 || h > 23 || min < 0 || min > 59) return [null, null];
  return [h, min];
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addUtcDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

