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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
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

test('bootstrap resolves an optional streamAddon into streamSource, independent of the catalog source', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'with-stream', name: 'WithStream', addon: 'org.a', catalog: 'cat-a', streamAddon: 'org.torrentio' }),
      channel({ id: 'no-stream', name: 'NoStream', addon: 'org.a', catalog: 'cat-a' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://torrentio/manifest.json', manifest: { id: 'org.torrentio', catalogs: [] } }
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
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'with-stream').streamSource.transportUrl, 'https://torrentio/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'no-stream').streamSource, null);
});

test('bootstrap sets streamSource: null (not a crash) when streamAddon does not resolve', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', streamAddon: 'org.missing' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
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
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].streamSource, null);
  assert.equal(createdAppArgs[0].channels[0].source.transportUrl, 'https://a/manifest.json');
});

test('bootstrap resolves streamSource from the global default stream addon when a channel has no per-channel override', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({ defaultStreamAddon: 'org.torrentio' }),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://torrentio/manifest.json', manifest: { id: 'org.torrentio', catalogs: [] } }
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
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
  assert.ok(createdAppArgs[0].settingsActions);
});

test('bootstrap prefers a channel\'s own streamAddon over the global default', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', streamAddon: 'org.other' })]),
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({ defaultStreamAddon: 'org.torrentio' }),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://torrentio/manifest.json', manifest: { id: 'org.torrentio', catalogs: [] } },
      { transportUrl: 'https://other/manifest.json', manifest: { id: 'org.other', catalogs: [] } }
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
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].streamSource.transportUrl, 'https://other/manifest.json');
});

test('bootstrap wires a real settingsActions instance backed by the shared settings object', async () => {
  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [],
    findAddonByIdImpl: (addons, id) => { throw new Error(`addon not found: ${id}`); },
    resolveChannelSourceImpl: () => null,
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async () => ({ generatedAt: 'new', items: [] }),
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });

  assert.ok(result.settingsActions);
  const settings = await result.settingsActions.getSettings();
  assert.deepEqual(settings, {});
});

test('regenerate reads the duration cache, passes it and realDebridApiKey to generateChannelScheduleImpl, and writes it back', async () => {
  let capturedArgs = null;
  let readCalledWith = null;
  let writeCalledWith = null;
  const fakeCache = { tt1: { ms: 1234, source: 'meta', resolvedAt: 'x' } };

  const result = await bootstrap({
    env: { DATA_DIR: '/tmp/unused', REALDEBRID_API_KEY: 'rd-key' },
    readChannelsImpl: async () => [channel({ id: 'x', addon: 'a', catalog: 'c', enabled: true })],
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth',
    getInstalledAddonsImpl: async () => [{ id: 'a', transportUrl: 'https://a/manifest.json', manifest: { id: 'a', catalogs: [{ id: 'c', type: 'movie' }] } }],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.id === id),
    resolveChannelSourceImpl: () => ({ type: 'movie', catalogId: 'c' }),
    generateChannelScheduleImpl: async (args) => { capturedArgs = args; return { generatedAt: 'new', items: [] }; },
    readScheduleImpl: async () => null,
    writeScheduleImpl: async () => {},
    isScheduleFreshImpl: () => false,
    scheduleDailyAtImpl: () => {},
    createAppImpl: () => ({ listen: () => ({ address: () => ({ port: 0 }) }) }),
    readDurationCacheImpl: async (dataDir) => { readCalledWith = dataDir; return fakeCache; },
    writeDurationCacheImpl: async (dataDir, cache) => { writeCalledWith = { dataDir, cache }; }
  });
  await result.startupRegenerationDone;

  assert.equal(readCalledWith, '/tmp/unused');
  assert.equal(capturedArgs.realDebridApiKey, 'rd-key');
  assert.equal(capturedArgs.durationCache, fakeCache);
  assert.deepEqual(writeCalledWith, { dataDir: '/tmp/unused', cache: fakeCache });
});

test('regenerate merges its resolved entries on top of a re-read on-disk cache, preserving concurrently-written entries', async () => {
  // Simulates a concurrent regenerate() call writing a new entry ('concurrent': ...)
  // to disk in between this call's initial read and its final write.
  let onDiskCache = { existing: { ms: 1111, source: 'meta', resolvedAt: 'x' } };
  let readCallCount = 0;
  let writeCalledWith = null;

  const result = await bootstrap({
    env: { DATA_DIR: '/tmp/unused', REALDEBRID_API_KEY: 'rd-key' },
    readChannelsImpl: async () => [channel({ id: 'x', addon: 'a', catalog: 'c', enabled: true })],
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth',
    getInstalledAddonsImpl: async () => [{ id: 'a', transportUrl: 'https://a/manifest.json', manifest: { id: 'a', catalogs: [{ id: 'c', type: 'movie' }] } }],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.id === id),
    resolveChannelSourceImpl: () => ({ type: 'movie', catalogId: 'c' }),
    generateChannelScheduleImpl: async (args) => {
      // Mutates the locally-read cache with a newly-resolved entry, then
      // simulates a concurrent regenerate() call completing (writing its own
      // entry to disk) before this call performs its final write.
      args.durationCache.newlyResolved = { ms: 2222, source: 'probe', resolvedAt: 'y' };
      onDiskCache = { ...onDiskCache, concurrent: { ms: 3333, source: 'meta', resolvedAt: 'z' } };
      return { generatedAt: 'new', items: [] };
    },
    readScheduleImpl: async () => null,
    writeScheduleImpl: async () => {},
    isScheduleFreshImpl: () => false,
    scheduleDailyAtImpl: () => {},
    createAppImpl: () => ({ listen: () => ({ address: () => ({ port: 0 }) }) }),
    readDurationCacheImpl: async () => { readCallCount += 1; return { ...onDiskCache }; },
    writeDurationCacheImpl: async (dataDir, cache) => { writeCalledWith = { dataDir, cache }; }
  });
  await result.startupRegenerationDone;

  assert.ok(readCallCount >= 2, 'expected the duration cache to be re-read before the final write');
  assert.deepEqual(writeCalledWith.cache, {
    existing: { ms: 1111, source: 'meta', resolvedAt: 'x' },
    concurrent: { ms: 3333, source: 'meta', resolvedAt: 'z' },
    newlyResolved: { ms: 2222, source: 'probe', resolvedAt: 'y' }
  });
});

test('regenerate sets channel.lastError on a schedule generation failure', async () => {
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
    generateChannelScheduleImpl: async () => { throw new Error('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'); },
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].lastError, 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON');
});

test('regenerate sets channel.lastError to "No resolved addon source" when the source failed to resolve', async () => {
  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.missing', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [],
    findAddonByIdImpl: () => { throw new Error('not found'); },
    resolveChannelSourceImpl: () => null,
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].lastError, 'No resolved addon source');
});

test('regenerate clears a previously-set lastError after a subsequent successful regeneration', async () => {
  let generationAttempts = 0;
  let cronCallback;

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
      generationAttempts += 1;
      if (generationAttempts === 1) throw new Error('temporary failure');
      return { generatedAt: 'new', items: [], channelId: ch.id };
    },
    writeScheduleImpl: async () => {},
    readDurationCacheImpl: async () => ({}),
    writeDurationCacheImpl: async () => {},
    scheduleDailyAtImpl: (refreshTime, cb) => { cronCallback = cb; return { cancel() {} }; },
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].lastError, 'temporary failure');

  await cronCallback();

  assert.equal(result.channels[0].lastError, null);
});
