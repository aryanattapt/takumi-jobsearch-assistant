import { z } from 'zod';

export const ScheduleRuleSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  times: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .min(1)
    .max(48),
  lateToleranceMinutes: z.number().int().min(0).max(1440).optional(),
});

export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Drop sub-second noise before comparing.
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return (asUtc - wholeSecond) / 60_000;
}

function parseLocalDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid local date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseLocalTime(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`Invalid local time: ${time}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Resolve a local wall-clock slot to UTC.
 * - Nonexistent local times (DST spring-forward gap) return null → skip.
 * - Ambiguous local times (fall-back overlap) return the first occurrence.
 */
export function resolveLocalSlot(
  localDate: string,
  localTime: string,
  timeZone: string,
): Date | null {
  const date = parseLocalDate(localDate);
  const time = parseLocalTime(localTime);
  const guess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0);

  const probes = [guess - 26 * 3_600_000, guess, guess + 26 * 3_600_000];
  const offsets = new Set<number>();
  for (const probe of probes) {
    offsets.add(offsetMinutes(new Date(probe), timeZone));
  }

  const candidates: Date[] = [];
  for (const offset of offsets) {
    const candidate = new Date(guess - offset * 60_000);
    const parts = zonedParts(candidate, timeZone);
    if (
      parts.year === date.year &&
      parts.month === date.month &&
      parts.day === date.day &&
      parts.hour === time.hour &&
      parts.minute === time.minute
    ) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((candidate) => candidate.getTime())));
}

export function slotDayOfWeek(localDate: string): number {
  const { year, month, day } = parseLocalDate(localDate);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function scheduledSlotsForDate(
  rule: ScheduleRule,
  localDate: string,
): string[] {
  if (!rule.daysOfWeek.includes(slotDayOfWeek(localDate))) return [];
  return [...new Set(rule.times)].sort();
}

export function isWithinLateTolerance(
  scheduledForUtc: Date,
  now: Date,
  toleranceMinutes: number,
): boolean {
  const delta = now.getTime() - scheduledForUtc.getTime();
  return delta >= 0 && delta <= toleranceMinutes * 60_000;
}
