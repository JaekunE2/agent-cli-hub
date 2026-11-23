'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createCalendar = require('../calendar');

test('toGoogle prevents empty or reversed time ranges across late-night and inverted end times', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cal-'));
  try {
    const cal = createCalendar({
      config: {
        calendar: {
          todo: path.join(dir, 'todo.md'),
          events: path.join(dir, 'calendar.json'),
          secretsDir: path.join(dir, 'secrets'),
          timeZone: 'Asia/Seoul',
        },
      },
    });

    const inverted = cal.toGoogle({ kind: 'event', id: 'ev-1', title: 'Inverted', date: '2026-11-27', time: '21:25', end: '16:25' });
    assert.equal(inverted.start.dateTime, '2026-11-27T21:25:00');
    assert.equal(inverted.end.dateTime, '2026-11-27T22:25:00');

    const late = cal.toGoogle({ kind: 'event', id: 'ev-2', title: 'Late', date: '2026-11-27', time: '23:30', end: null });
    assert.equal(late.start.dateTime, '2026-11-27T23:30:00');
    assert.equal(late.end.dateTime, '2026-11-28T00:30:00');

    assert.throws(() => cal.upsertEvent({ title: 'Bad', date: '2026-11-27', time: '21:25', end: '16:25' }), /늦어야/);
    const ok = cal.upsertEvent({ title: 'Good', date: '2026-11-27', time: '16:25', end: '21:25' });
    assert.equal(ok.end, '21:25');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
