import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/bootstrap.js';

function fakeApp() {
  return { listen: (port, cb) => { cb?.(); return { address: () => ({ port }) }; } };
}

function channel(overrides = {}) {
  return { mode: 'random', minQuality: '480p', language: 'en', enabled: true, ...overrides };
}

test('bootstrap resolves each channel\'s source and only regenerates stale schedules', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { DATA_DIR: '/data', PORT: '9999', BASE_URL: 'http://localhost:9999', STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'fresh', name: 'Fresh', addon: 'org.a', catalog: 'cat-a' }),
      channel({ id: 'stale', name: 'Stale', addon: 'org.b', catalog: 'cat-b', mode: 'random-start' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://b/manifest.json', manifest: { id: 'org.b', catalogs: [{ id: 'cat-b', type: 'series' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async (dataDir, channelId) => (channelId === 'fresh' ? { generatedAt: '2026-07-22T00:00:00.000Z', items: [] } : null),
    isScheduleFreshImpl: (schedule) => schedule !== null,
    generateChannelScheduleImpl: async ({ channel }) => ({ generatedAt: 'new', items: [], channelId: channel.id }),
    writeScheduleImpl: async (dataDir, channelId, schedule) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.deepEqual(writtenSchedules, ['stale']);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'fresh').source.transportUrl, 'https://a/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'stale').source.type, 'series');
  assert.equal(result.app, createdAppArgs[0] && result.app);
  assert.ok(result.channelActions);
});

test('bootstrap only loads enabled channels into the live array', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'on', name: 'On', addon: 'org.a', catalog: 'cat-a', enabled: true }),
      channel({ id: 'off', name: 'Off', addon: 'org.a', catalog: 'cat-a', enabled: false })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.deepEqual(createdAppArgs[0].channels.map((c) => c.id), ['on']);
});

test('bootstrap retries a failing getAuthKey with backoff before giving up', async () => {
  let attempts = 0;
  const sleeps = [];
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('login failed');
      return 'auth-key';
    },
    sleepImpl: async (ms) => { sleeps.push(ms); },
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async () => ({ generatedAt: 'new', items: [] }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(attempts, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(createdAppArgs[0].channels[0].source.transportUrl, 'https://a/manifest.json');
});

test('bootstrap still starts the server with source: null when login fails permanently', async () => {
  const createdAppArgs = [];
  const writtenSchedules = [];

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'wrong' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => { throw new Error('always fails'); },
    invalidateAuthKeyImpl: async () => {},
    sleepImpl: async () => {},
    readScheduleImpl: async () => ({ generatedAt: '2026-07-22T00:00:00.000Z', items: [] }),
    isScheduleFreshImpl: () => true,
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.equal(createdAppArgs[0].channels[0].source, null);
  assert.deepEqual(writtenSchedules, []);
  assert.ok(result.server);
});

test('bootstrap catches a schedule generation failure for one channel without affecting others', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'bad', name: 'Bad', addon: 'org.a', catalog: 'cat-a' }),
      channel({ id: 'good', name: 'Good', addon: 'org.b', catalog: 'cat-b' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://b/manifest.json', manifest: { id: 'org.b', catalogs: [{ id: 'cat-b', type: 'series' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => {
      if (ch.id === 'bad') throw new Error('generation exploded');
      return { generatedAt: 'new', items: [], channelId: ch.id };
    },
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.deepEqual(writtenSchedules, ['good']);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'bad').source.transportUrl, 'https://a/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'good').source.transportUrl, 'https://b/manifest.json');
  assert.ok(result.server);
});

test('bootstrap resolves source: null for a channel whose addon lookup fails while another channel resolves normally', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'missing', name: 'Missing', addon: 'org.missing', catalog: 'cat-a' }),
      channel({ id: 'ok', name: 'Ok', addon: 'org.b', catalog: 'cat-b' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://b/manifest.json', manifest: { id: 'org.b', catalogs: [{ id: 'cat-b', type: 'series' }] } }
    ],
    findAddonByIdImpl: (addons, id) => {
      const found = addons.find((a) => a.manifest.id === id);
      if (!found) throw new Error(`addon not found: ${id}`);
      return found;
    },
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'missing').source, null);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'ok').source.transportUrl, 'https://b/manifest.json');
  assert.deepEqual(writtenSchedules.sort(), ['ok']);
  assert.ok(result.server);
});

test('bootstrap calls app.listen before the startup schedule-regeneration pass resolves', async () => {
  const events = [];
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => {
      await generationGate;
      events.push('generated');
      return { generatedAt: 'new', items: [], channelId: ch.id };
    },
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => ({
      listen: (port, cb) => { events.push('listen'); cb?.(); return { address: () => ({ port }) }; }
    })
  });

  assert.deepEqual(events, ['listen']);

  releaseGeneration();
  await result.startupRegenerationDone;
  assert.deepEqual(events, ['listen', 'generated']);
});

test('daily cron re-resolves a channel whose source is null and regenerates its schedule', async () => {
  const writtenSchedules = [];
  let cronCallback;
  let discoveryAttempts = 0;

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => {
      discoveryAttempts += 1;
      if (discoveryAttempts <= 4) throw new Error('login failed at startup');
      return 'auth-key';
    },
    invalidateAuthKeyImpl: async () => {},
    sleepImpl: async () => {},
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: (refreshTime, cb) => { cronCallback = cb; return { cancel() {} }; },
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].source, null);
  assert.deepEqual(writtenSchedules, []);

  await cronCallback();

  assert.equal(result.channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.deepEqual(writtenSchedules, ['x']);
});

test('daily cron invalidates the cached auth key when re-resolution discovery fails again', async () => {
  let invalidateCalls = 0;
  let cronCallback;

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => { throw new Error('always fails'); },
    invalidateAuthKeyImpl: async () => { invalidateCalls += 1; },
    sleepImpl: async () => {},
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: (refreshTime, cb) => { cronCallback = cb; return { cancel() {} }; },
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(invalidateCalls, 1);
  assert.equal(result.channels[0].source, null);

  await cronCallback();

  assert.equal(invalidateCalls, 2);
  assert.equal(result.channels[0].source, null);
});

test('bootstrap wires a real channelActions instance that can add a channel and have it appear live immediately', async () => {
  const writtenSchedules = [];
  let writtenChannels = null;

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => [],
    writeChannelsImpl: async (dataDir, list) => { writtenChannels = list; },
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', name: 'Addon A', catalogs: [{ id: 'cat-a', name: 'Cat A', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels.length, 0);

  const record = await result.channelActions.addChannel({
    addon: 'org.a', catalog: 'cat-a', name: 'New Channel', mode: 'random', minQuality: '480p', language: 'en'
  });

  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].id, record.id);
  assert.equal(result.channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.deepEqual(writtenChannels, [record]);
  assert.deepEqual(writtenSchedules, [record.id]);
});
