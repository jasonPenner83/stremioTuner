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
    resolveStreamSourceImpl: () => null,
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

test('addChannel resolves an optional streamAddon into streamSource on the live channel', async () => {
  const channels = [];
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([{ manifest: { id: 'org.torrentio' }, transportUrl: 'https://torrentio/manifest.json' }]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel, installedAddons) => {
      const found = installedAddons.find((a) => a.manifest.id === channel.streamAddon);
      return found ? { transportUrl: found.transportUrl } : null;
    },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {}
  });

  const record = await actions.addChannel({
    addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', streamAddon: 'org.torrentio'
  });

  assert.equal(record.streamAddon, 'org.torrentio');
  assert.equal(channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
});

test('addChannel resolves streamSource via resolveStreamSourceImpl even when streamAddon is omitted (global default may apply)', async () => {
  const channels = [];
  let calledWith = null;
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel) => { calledWith = channel.streamAddon; return null; },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {}
  });

  const record = await actions.addChannel({
    addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en'
  });

  assert.equal(record.streamAddon, undefined);
  assert.equal(calledWith, undefined);
  assert.equal(channels[0].streamSource, null);
});

test('updateChannel re-resolves streamSource when streamAddon is patched on an already-enabled channel', async () => {
  const channels = [{ id: 'x', addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', enabled: true, source: { transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }, streamSource: null }];
  let regeneratedId = null;
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([{ manifest: { id: 'org.torrentio' }, transportUrl: 'https://torrentio/manifest.json' }]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel, installedAddons) => {
      const found = installedAddons.find((a) => a.manifest.id === channel.streamAddon);
      return found ? { transportUrl: found.transportUrl } : null;
    },
    regenerateImpl: async (ch) => { regeneratedId = ch.id; },
    readChannelsImpl: async () => ([{ id: 'x', addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', enabled: true }]),
    writeChannelsImpl: async () => {}
  });

  await actions.updateChannel('x', { streamAddon: 'org.torrentio' });

  assert.equal(channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
  assert.equal(regeneratedId, 'x');
});

test('updateChannel clearing streamAddon on an already-enabled channel falls back to whatever resolveStreamSourceImpl resolves (e.g. a global default), not null', async () => {
  const channels = [{ id: 'x', addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', enabled: true, streamAddon: 'org.other', source: { transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://other/manifest.json' } }];
  let regeneratedId = null;
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([{ manifest: { id: 'org.default' }, transportUrl: 'https://default-addon/manifest.json' }]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel) => {
      // simulates bootstrap.js's resolveStreamSource closure falling back to a global default
      // when the channel has no streamAddon override of its own
      return channel.streamAddon ? { transportUrl: 'https://other/manifest.json' } : { transportUrl: 'https://default-addon/manifest.json' };
    },
    regenerateImpl: async (ch) => { regeneratedId = ch.id; },
    readChannelsImpl: async () => ([{ id: 'x', addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', enabled: true, streamAddon: 'org.other' }]),
    writeChannelsImpl: async () => {}
  });

  await actions.updateChannel('x', { streamAddon: '' });

  assert.equal(channels[0].streamSource.transportUrl, 'https://default-addon/manifest.json');
  assert.equal(regeneratedId, 'x');
});

test('deleteChannel removes the channel from the persisted list', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  let written = null;
  const actions = createChannelActions(baseDeps({
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async (dataDir, list) => { written = list; }
  }));

  await actions.deleteChannel('x');

  assert.deepEqual(written, []);
});

test('deleteChannel removes the channel from the live array when it is currently live', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const channels = [{ ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } }];
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async () => {}
  }));

  await actions.deleteChannel('x');

  assert.equal(channels.length, 0);
});

test('deleteChannel is a no-op on the live array when the channel is not currently live', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: false }];
  const channels = [];
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async () => {}
  }));

  await actions.deleteChannel('x');

  assert.equal(channels.length, 0);
});

test('deleteChannel throws NotFoundError for an unknown id', async () => {
  const actions = createChannelActions(baseDeps({ readChannelsImpl: async () => [] }));
  await assert.rejects(() => actions.deleteChannel('unknown'), NotFoundError);
});
