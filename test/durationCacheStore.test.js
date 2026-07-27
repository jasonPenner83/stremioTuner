import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { durationCachePath, readDurationCache, writeDurationCache } from '../src/durationCacheStore.js';

test('durationCachePath builds a path under dataDir', () => {
  assert.equal(durationCachePath('/data'), path.join('/data', 'runtimeCache.json'));
});

test('readDurationCache returns an empty object when no file exists', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cache = await readDurationCache(dataDir);
  assert.deepEqual(cache, {});
});

test('writeDurationCache then readDurationCache round-trips the data', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cache = { tt1: { ms: 5400000, source: 'meta', resolvedAt: '2026-07-27T00:00:00.000Z' } };
  await writeDurationCache(dataDir, cache);
  const readBack = await readDurationCache(dataDir);
  assert.deepEqual(readBack, cache);
});
