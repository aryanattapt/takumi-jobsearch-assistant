import { describe, expect, it } from 'vitest';
import {
  isWithinLateTolerance,
  resolveLocalSlot,
  scheduledSlotsForDate,
  slotDayOfWeek,
  zonedParts,
} from '@/lib/schedule/time';

describe('local slot resolution', () => {
  it('converts Asia/Jakarta (no DST) to UTC', () => {
    const instant = resolveLocalSlot('2026-11-08', '09:30', 'Asia/Jakarta');
    expect(instant?.toISOString()).toBe('2026-11-08T02:30:00.000Z');
    expect(zonedParts(instant!, 'Asia/Jakarta')).toMatchObject({
      year: 2026,
      month: 11,
      day: 8,
      hour: 9,
      minute: 30,
    });
  });

  it('skips a nonexistent DST spring-forward time', () => {
    // America/New_York jumps from 02:00 to 03:00 on 2026-03-08.
    expect(resolveLocalSlot('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(
      resolveLocalSlot('2026-03-08', '03:30', 'America/New_York')?.toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });

  it('uses the first occurrence for an ambiguous DST fall-back time', () => {
    // 01:30 occurs twice on 2026-11-01 in New York: 05:30Z (EDT) and 06:30Z (EST).
    const instant = resolveLocalSlot('2026-11-01', '01:30', 'America/New_York');
    expect(instant?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(() => resolveLocalSlot('2026-13-01', '09:00', 'Asia/Jakarta')).not.toThrow();
    expect(resolveLocalSlot('2026-02-30', '09:00', 'Asia/Jakarta')).toBeNull();
    expect(() => resolveLocalSlot('2026-11-08', '25:00', 'Asia/Jakarta')).toThrow();
  });
});

describe('schedule rules', () => {
  it('computes weekday in the local calendar', () => {
    expect(slotDayOfWeek('2026-11-08')).toBe(0); // Sunday
    expect(slotDayOfWeek('2026-11-09')).toBe(1); // Monday
  });

  it('returns sorted, deduplicated slots for matching days only', () => {
    const rule = { daysOfWeek: [0], times: ['18:00', '09:00', '09:00'] };
    expect(scheduledSlotsForDate(rule, '2026-11-08')).toEqual(['09:00', '18:00']);
    expect(scheduledSlotsForDate(rule, '2026-11-09')).toEqual([]);
  });

  it('applies the late tolerance window', () => {
    const scheduled = new Date('2026-11-08T02:00:00.000Z');
    expect(isWithinLateTolerance(scheduled, new Date('2026-11-08T02:10:00.000Z'), 15)).toBe(true);
    expect(isWithinLateTolerance(scheduled, new Date('2026-11-08T02:20:00.000Z'), 15)).toBe(false);
    expect(isWithinLateTolerance(scheduled, new Date('2026-11-08T01:59:00.000Z'), 15)).toBe(false);
  });
});
