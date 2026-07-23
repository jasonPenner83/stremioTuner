import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelActions, ValidationError, NotFoundError } from '../src/channelActions.js';

function baseDeps(overrides = {}) {
  return {
    dataDir: '/data',
    channels: [],
    discoverInstalledAddons: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', name: 'Addon A', catalogs: [{ id: 'cat-a', name: 'Cat A', type: 'movie' }] } }
    ],
    resolveSourceImpl: (channel, installedAddons) => {
      if (!installedAddons) return null;
      const addonEntry = installedAddons.find((a) => a.manifest.id === channel.addon);
      if (!addonEntry) return null;
      const catalog = addonEntry.manifest.catalogs.find((c) => c.id === channel.catalog);
      if (!catalog) return null;
      return { transportUrl: addonEntry.transportUrl, type: catalog.type };
    },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {},
    ...overrides
  };
}

test('listCatalogs returns degraded when Stremio discovery is unavailable', async () => {
  const actions = createChannelActions(baseDeps({ discoverInstalledAddons: async () => null }));
  const result = await actions.listCatalogs();
  assert.deepEqual(result, { degraded: true, catalogs: [] });
});

test('listCatalogs flattens every installed addon\'s catalogs and marks already-added ones', async () => {
  const actions = createChannelActions(baseDeps({
    readChannelsImpl: async () => [{ id: 'org-a-cat-a', addon: 'org.a', catalog: 'cat-a' }]
  }));
  const result = await actions.listCatalogs();
  assert.equal(result.degraded, false);
  assert.deepEqual(result.catalogs, [{
    addon: 'org.a', addonName: 'Addon A', catalog: 'cat-a', catalogName: 'Cat A', type: 'movie', channelId: 'org-a-cat-a'
  }]);
});

test('listCatalogs marks a catalog with no matching channel as channelId: null', async () => {
  const actions = createChannelActions(baseDeps());
  const result = await actions.listCatalogs();
  assert.equal(result.catalogs[0].channelId, null);
});

test('listChannels returns the persisted channel list', async () => {
  const actions = createChannelActions(baseDeps({ readChannelsImpl: async () => [{ id: 'x' }] }));
  const result = await actions.listChannels();
  assert.deepEqual(result, [{ id: 'x' }]);
});

test('addChannel rejects an invalid mode before touching the network or disk', async () => {
  let discoverCalled = false;
  const actions = createChannelActions(baseDeps({ discoverInstalledAddons: async () => { discoverCalled = true; return []; } }));
  await assert.rejects(
    () => actions.addChannel({ addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'bogus', minQuality: '720p', language: 'en' }),
    ValidationError
  );
  assert.equal(discoverCalled, false);
});

test('addChannel rejects when the addon/catalog cannot be resolved', async () => {
  const actions = createChannelActions(baseDeps({ resolveSourceImpl: () => null }));
  await assert.rejects(
    () => actions.addChannel({ addon: 'org.missing', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en' }),
    ValidationError
  );
});

test('addChannel rejects a duplicate addon/catalog combination', async () => {
  const actions = createChannelActions(baseDeps({
    readChannelsImpl: async () => [{ id: 'org-a-cat-a', addon: 'org.a', catalog: 'cat-a' }]
  }));
  await assert.rejects(
    () => actions.addChannel({ addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en' }),
    ValidationError
  );
});

test('addChannel persists the record, pushes it into the live channels array with a resolved source, and regenerates its schedule', async () => {
  const channels = [];
  let written = null;
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    writeChannelsImpl: async (dataDir, list) => { written = list; },
    regenerateImpl: async (liveChannel) => { regenerated = liveChannel; }
  }));

  const record = await actions.addChannel({ addon: 'org.a', catalog: 'cat-a', name: 'Marvel Movies', mode: 'random-start', minQuality: '720p', language: 'en' });

  assert.equal(record.id, 'org-a-cat-a');
  assert.equal(record.enabled, true);
  assert.deepEqual(written, [record]);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.equal(regenerated, channels[0]);
});

test('updateChannel rejects an unknown id', async () => {
  const actions = createChannelActions(baseDeps());
  await assert.rejects(() => actions.updateChannel('unknown', { enabled: false }), NotFoundError);
});

test('updateChannel disabling a channel removes it from the live array but keeps it persisted', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const channels = [{ ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } }];
  let written = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async (dataDir, list) => { written = list; }
  }));

  const updated = await actions.updateChannel('x', { enabled: false });

  assert.equal(updated.enabled, false);
  assert.equal(channels.length, 0);
  assert.equal(written[0].enabled, false);
});

test('updateChannel enabling a previously-disabled channel re-resolves its source and regenerates its schedule', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: false }];
  const channels = [];
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    regenerateImpl: async (liveChannel) => { regenerated = liveChannel; }
  }));

  const updated = await actions.updateChannel('x', { enabled: true });

  assert.equal(updated.enabled, true);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.equal(regenerated, channels[0]);
});

test('updateChannel changing mode on an already-enabled channel mutates it in place and regenerates', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const liveChannel = { ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } };
  const channels = [liveChannel];
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    regenerateImpl: async (ch) => { regenerated = ch; }
  }));

  await actions.updateChannel('x', { mode: 'random-start' });

  assert.equal(channels.length, 1);
  assert.equal(channels[0], liveChannel); // same object reference, mutated in place
  assert.equal(channels[0].mode, 'random-start');
  assert.equal(regenerated, liveChannel);
});

test('updateChannel ignores an "id" field in the patch body, keeping the original id everywhere', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const liveChannel = { ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } };
  const channels = [liveChannel];
  let written = null;
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async (dataDir, list) => { written = list; },
    regenerateImpl: async (ch) => { regenerated = ch; }
  }));

  const updated = await actions.updateChannel('x', { id: '../../../../tmp/evil', mode: 'random-start' });

  assert.equal(updated.id, 'x');
  assert.equal(written[0].id, 'x');
  assert.equal(channels[0].id, 'x');
  assert.equal(regenerated.id, 'x');
});

test('updateChannel rejects a non-boolean "enabled" value instead of silently treating it as enabled', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const channels = [{ ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } }];
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted
  }));

  await assert.rejects(() => actions.updateChannel('x', { enabled: 'false' }), ValidationError);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].enabled, true);
});
