import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostRecentBoundary, nextBoundary, msUntilNextRun, scheduleDailyAt } from '../src/scheduling.js';

test('mostRecentBoundary returns today\'s boundary when it has already passed', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = mostRecentBoundary('00:00', now);
  assert.equal(boundary.toISOString().slice(0, 10), '2026-07-22');
  assert.equal(boundary.getHours(), 0);
});

test('mostRecentBoundary returns yesterday\'s boundary when today\'s hasn\'t happened yet', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = mostRecentBoundary('23:00', now);
  assert.equal(boundary.getDate(), 21);
});

test('nextBoundary returns tomorrow when today\'s boundary already passed', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = nextBoundary('00:00', now);
  assert.equal(boundary.getDate(), 23);
});

test('nextBoundary returns today when the boundary hasn\'t happened yet', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = nextBoundary('23:00', now);
  assert.equal(boundary.getDate(), 22);
});

test('msUntilNextRun computes correct delay', () => {
  const now = new Date('2026-07-22T23:00:00');
  const ms = msUntilNextRun('23:30', now);
  assert.equal(ms, 30 * 60 * 1000);
});

test('scheduleDailyAt schedules a timer and reschedules after each firing', () => {
  const calls = [];
  const scheduled = [];
  const fakeSetTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };
  const fakeClearTimeout = () => {};

  scheduleDailyAt('00:00', () => calls.push('fired'), {
    now: () => new Date('2026-07-22T10:00:00'),
    setTimeoutImpl: fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout
  });

  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay > 0);

  scheduled[0].fn();
  assert.deepEqual(calls, ['fired']);
  assert.equal(scheduled.length, 2);
});

test('scheduleDailyAt.cancel prevents further rescheduling', () => {
  const scheduled = [];
  let cleared = false;
  const fakeSetTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };
  const fakeClearTimeout = () => { cleared = true; };

  const handle = scheduleDailyAt('00:00', () => {}, {
    now: () => new Date('2026-07-22T10:00:00'),
    setTimeoutImpl: fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout
  });

  handle.cancel();
  assert.equal(cleared, true);

  scheduled[0].fn();
  assert.equal(scheduled.length, 1, 'should not schedule again after cancel');
});
