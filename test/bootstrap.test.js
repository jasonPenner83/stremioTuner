import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/bootstrap.js';

function fakeApp() {
  return { listen: (port, cb) => { cb?.(); return { address: () => ({ port }) }; } };
}

test('bootstrap resolves each channel\'s source and only regenerates stale schedules', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { DATA_DIR: '/data', CONFIG_PATH: '/data/config.yml', PORT: '9999', BASE_URL: 'http://localhost:9999', STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    loadConfigImpl: async () => ({
      refreshTime: '00:00',
      channels: [
        { id: 'fresh', name: 'Fresh', addon: 'org.a', catalog: 'cat-a', mode: 'random', minQuality: '480p', language: 'en' },
        { id: 'stale', name: 'Stale', addon: 'org.b', catalog: 'cat-b', mode: 'random-start', minQuality: '480p', language: 'en' }
      ]
    }),
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

  assert.deepEqual(writtenSchedules, ['stale']);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'fresh').source.transportUrl, 'https://a/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'stale').source.type, 'series');
  assert.equal(result.app, createdAppArgs[0] && result.app);
});

test('bootstrap retries a failing getAuthKey with backoff before giving up', async () => {
  let attempts = 0;
  const sleeps = [];
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    loadConfigImpl: async () => ({
      refreshTime: '00:00',
      channels: [{ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', mode: 'random', minQuality: '480p', language: 'en' }]
    }),
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
    loadConfigImpl: async () => ({
      refreshTime: '00:00',
      channels: [{ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', mode: 'random', minQuality: '480p', language: 'en' }]
    }),
    getAuthKeyImpl: async () => { throw new Error('always fails'); },
    sleepImpl: async () => {},
    readScheduleImpl: async () => ({ generatedAt: '2026-07-22T00:00:00.000Z', items: [] }),
    isScheduleFreshImpl: () => true,
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].source, null);
  assert.deepEqual(writtenSchedules, []);
  assert.ok(result.server);
});
