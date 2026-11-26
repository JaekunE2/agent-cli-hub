'use strict';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const HORIZON = 366 * 5 * DAY;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_TRIGGER' });
}

function field(source, low, high) {
  const values = new Set();
  for (const part of source.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw invalid('Invalid cron field');
    const [, range, stride] = match;
    const [start, end = stride ? high : Number(range)] = range === '*'
      ? [low, high] : range.split('-').map(Number);
    const step = stride === undefined ? 1 : Number(stride);
    if (start < low || end > high || start > end || !Number.isSafeInteger(step) || step < 1) {
      throw invalid('Cron field out of range');
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function compile(trigger) {
  if (trigger?.kind === 'interval') {
    if (!Number.isInteger(trigger.everyMinutes) || trigger.everyMinutes < 1 || trigger.everyMinutes > 10080) {
      throw invalid('Interval must be between 1 and 10080 minutes');
    }
    return { period: trigger.everyMinutes * MINUTE, anchor: Date.parse(trigger.anchorAt) };
  }
  if (trigger?.kind !== 'cron' || typeof trigger.expression !== 'string' || !trigger.timeZone) {
    throw invalid('Expected an interval or five-field cron with an IANA time zone');
  }
  const parts = trigger.expression.trim().split(/\s+/);
  if (parts.length !== 5) throw invalid('Expected five cron fields');
  const minutes = field(parts[0], 0, 59);
  const hours = field(parts[1], 0, 23);
  const days = field(parts[2], 1, 31);
  const months = field(parts[3], 1, 12);
  const weekdays = field(parts[4], 0, 7);
  if (weekdays.delete(7)) weekdays.add(0);

  let format;
  try {
    if (typeof trigger.timeZone !== 'string' || /^[+-]/.test(trigger.timeZone)) throw invalid('Invalid time zone');
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: trigger.timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
  } catch {
    throw invalid('Invalid IANA time zone');
  }
  const local = utc => {
    const p = Object.fromEntries(format.formatToParts(utc).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  const domRestricted = !parts[2].startsWith('*') || days.size !== 31;
  const dowRestricted = !parts[4].startsWith('*') || weekdays.size !== 7;
  return {
    local, minutes, hours,
    matches(date) {
      const dom = days.has(date.getUTCDate());
      const dow = weekdays.has(date.getUTCDay());
      return months.has(date.getUTCMonth() + 1) && (domRestricted && dowRestricted ? dom || dow : dom && dow);
    },
  };
}

function findCron(cron, from, through, direction) {
  const midnight = value => Math.floor(value / DAY) * DAY;
  const start = midnight(cron.local(direction > 0 ? from : through));
  const end = midnight(cron.local(direction > 0 ? through : from));
  const times = [...cron.hours].flatMap(hour => [...cron.minutes].map(minute => hour * 60 + minute));
  times.sort((a, b) => direction * (a - b));
  for (let day = start; direction * (end - day) >= 0; day += direction * DAY) {
    if (!cron.matches(new Date(day))) continue;
    // Sample both sides of a transition, then round-trip each possible UTC instant.
    const offsets = new Set();
    for (let probe = day - DAY; probe <= day + 2 * DAY; probe += 6 * 60 * MINUTE) {
      offsets.add(cron.local(probe) - probe);
    }
    for (const time of times) {
      const wall = day + time * MINUTE;
      const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b);
      if (candidates[0] > through || candidates.at(-1) < from) continue;
      const first = candidates.find(utc => cron.local(utc) === wall);
      if (first >= from && first <= through) return first;
    }
  }
  return null;
}

function nextSlot(trigger, after, { allowDistant = false } = {}) {
  const timing = compile(trigger);
  if (timing.period) {
    if (!Number.isFinite(timing.anchor)) throw invalid('Invalid interval anchor');
    return timing.anchor + Math.max(1, Math.floor((after - timing.anchor) / timing.period) + 1) * timing.period;
  }
  const next = findCron(timing, after + 1, after + (allowDistant ? 2 * HORIZON : HORIZON), 1);
  if (next === null) throw invalid('Cron has no occurrence within five years');
  return next;
}

function latestSlot(trigger, from, through) {
  if (through < from) return null;
  const timing = compile(trigger);
  if (!timing.period) return findCron(timing, from, through, -1);
  const slot = timing.anchor + Math.floor((through - timing.anchor) / timing.period) * timing.period;
  return slot >= from && slot > timing.anchor ? slot : null;
}

module.exports = { nextSlot, latestSlot };
