import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateChannelSchedule } from '../src/generateSchedule.js';

const ITEMS = [
  { id: 'tt1', type: 'movie', name: 'Movie One' },
  { id: 'tt2', type: 'movie', name: 'Movie Two' }
];

function makeAddonClientImpl({ metaByFor = {} } = {}) {
  return {
    fetchCatalog: async () => ITEMS,
    fetchMeta: async (transportUrl, type, id) => metaByFor[id] || null
  };
}

test('random-start mode wraps the catalog sequentially starting at a random index', async () => {
  const addonClientImpl = makeAddonClientImpl({ metaByFor: { tt1: { runtime: '60 min' }, tt2: { runtime: '60 min' } } });
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 3 * 60 * 60 * 1000, // 3 hours -> 3 items at 60 min each
    rng: () => 0.9 // floor(0.9*2) = 1 -> starts at tt2
  });

  assert.equal(schedule.generatedAt, '2026-07-22T00:00:00.000Z');
  assert.deepEqual(schedule.items.map((i) => i.id), ['tt2', 'tt1', 'tt2']);
  assert.equal(schedule.items[0].start, '2026-07-22T00:00:00.000Z');
  assert.equal(schedule.items[0].end, '2026-07-22T01:00:00.000Z');
  assert.equal(schedule.items[1].start, '2026-07-22T01:00:00.000Z');
});

test('random mode independently picks items and allows repeats', async () => {
  const addonClientImpl = makeAddonClientImpl({ metaByFor: { tt1: { runtime: '60 min' }, tt2: { runtime: '60 min' } } });
  const values = [0, 0, 0];
  let i = 0;
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 2.5 * 60 * 60 * 1000,
    rng: () => values[i++]
  });

  assert.deepEqual(schedule.items.map((i) => i.id), ['tt1', 'tt1', 'tt1']);
});

test('falls back to the default runtime when meta has no runtime', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 90 * 60 * 1000,
    defaultRuntimeMs: 90 * 60 * 1000,
    rng: () => 0
  });
  assert.equal(schedule.items.length, 1);
  assert.equal(schedule.items[0].end, '2026-07-22T01:30:00.000Z');
});

test('caches meta lookups so a repeated item is not fetched twice', async () => {
  let fetchCount = 0;
  const addonClientImpl = {
    fetchCatalog: async () => ITEMS,
    fetchMeta: async () => { fetchCount += 1; return { runtime: '30 min' }; }
  };
  await generateChannelSchedule({
    channel: { mode: 'random', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 90 * 60 * 1000,
    rng: () => 0 // always picks ITEMS[0] = tt1
  });
  assert.equal(fetchCount, 1);
});

test('throws when the catalog returns no items', async () => {
  const addonClientImpl = { fetchCatalog: async () => [], fetchMeta: async () => null };
  await assert.rejects(() => generateChannelSchedule({
    channel: { mode: 'random', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl
  }), /no items/);
});

test('treats zero-runtime metadata as invalid and falls back to defaultRuntimeMs', async () => {
  const addonClientImpl = makeAddonClientImpl({ metaByFor: { tt1: { runtime: '0 min' }, tt2: { runtime: '0 min' } } });
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 60 * 60 * 1000, // 60 minutes target
    defaultRuntimeMs: 60 * 60 * 1000, // 60 minutes default (fallback for zero metadata)
    rng: () => 0 // starts at tt1
  });
  // Loop condition: while (cursorTime - startTime < targetWindowMs)
  // Item 1: cursorTime=0, check 0 < 60*60*1000? YES, add item, cursorTime=60*60*1000
  // Item 2: check 60*60*1000 < 60*60*1000? NO, exit loop
  assert.equal(schedule.items.length, 1);
  // Verify the end time reflects the 60-minute default, not the 0 from metadata (which would cause infinite loop)
  assert.equal(schedule.items[0].end, '2026-07-22T01:00:00.000Z');
});
