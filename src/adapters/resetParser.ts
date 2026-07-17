const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Best-effort parser for reset phrases seen in CLI rate-limit messages,
 * e.g. "resets 3:45pm", "resets Mon 12:00am", "resets at 14:00".
 * Returns the next future occurrence of that local time, or null.
 */
export function parseResetPhrase(message: string, now: Date): Date | null {
  const m = message.match(
    /resets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i
  );
  if (!m) return null;

  const [, dayName, hourStr, minStr, ampm] = m;
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  if (ampm) {
    const lower = ampm.toLowerCase();
    if (lower === 'pm' && hour !== 12) hour += 12;
    if (lower === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);

  if (dayName) {
    const targetDow = DAY_NAMES.indexOf(dayName.toLowerCase());
    while (candidate.getDay() !== targetDow || candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }
  } else if (candidate <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /hit your (session|weekly|opus|5-hour) limit/i,
  /usage limit reached/i,
  /rate limit(ed)?/i,
  /limit will reset/i,
];

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Conservative back-off when a rate-limit message's reset time couldn't be
 * parsed. A weekly cap blocks for days — retrying in 3h would just burn
 * attempts — while a 5h-window hit clears within hours.
 */
export function coolOffMsForUnparseableReset(message: string): number {
  return /weekly/i.test(message) ? 24 * 3600 * 1000 : 3 * 3600 * 1000;
}
