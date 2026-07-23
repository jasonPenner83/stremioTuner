import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { schedulePath, readSchedule, writeSchedule, isScheduleFresh } from '../src/scheduleStore.js';

test('schedulePath joins dataDir/schedules/<id>.json', () => {
  assert.equal(schedulePath('/data', 'marvel-movies'), path.join('/data', 'schedules', 'marvel-movies.json'));
});

test('readSchedule returns null when file does not exist', async () => {
  const fakeFs = {
    readFile: async () => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    }
  };
  const result = await readSchedule('/data', 'x', { fs: fakeFs });
  assert.equal(result, null);
});

test('readSchedule parses the persisted JSON', async () => {
  const fakeFs = {
    readFile: async () => JSON.stringify({ generatedAt: '2026-07-22T00:00:00.000Z', items: [] })
  };
  const result = await readSchedule('/data', 'x', { fs: fakeFs });
  assert.equal(result.generatedAt, '2026-07-22T00:00:00.000Z');
});

test('writeSchedule creates the schedules directory and writes JSON', async () => {
  const calls = { mkdir: null, writeFile: null };
  const fakeFs = {
    mkdir: async (dir, opts) => { calls.mkdir = { dir, opts }; },
    writeFile: async (p, content) => { calls.writeFile = { p, content }; }
  };
  await writeSchedule('/data', 'x', { generatedAt: 'now', items: [] }, { fs: fakeFs });
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.ok(calls.writeFile.p.endsWith('x.json'));
  assert.deepEqual(JSON.parse(calls.writeFile.content), { generatedAt: 'now', items: [] });
});

test('isScheduleFresh is false for null schedule', () => {
  assert.equal(isScheduleFresh(null, '00:00', new Date()), false);
});

test('isScheduleFresh is true when generatedAt is at or after the most recent boundary', () => {
  const now = new Date('2026-07-22T10:00:00');
  const schedule = { generatedAt: new Date('2026-07-22T00:00:00').toISOString(), items: [] };
  assert.equal(isScheduleFresh(schedule, '00:00', now), true);
});

test('isScheduleFresh is false when generatedAt predates the most recent boundary', () => {
  const now = new Date('2026-07-22T10:00:00');
  const schedule = { generatedAt: new Date('2026-07-20T00:00:00').toISOString(), items: [] };
  assert.equal(isScheduleFresh(schedule, '00:00', now), false);
});
