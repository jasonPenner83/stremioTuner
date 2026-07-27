import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsActions } from '../src/settingsActions.js';
import { ValidationError } from '../src/channelActions.js';

function baseDeps(overrides = {}) {
  return {
    dataDir: '/data',
    settings: {},
    channels: [],
    discoverInstalledAddons: async () => [],
    resolveStreamSourceImpl: () => null,
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    ...overrides
  };
}

test('getSettings returns the persisted settings', async () => {
  const actions = createSettingsActions(baseDeps({
    readSettingsImpl: async () => ({ defaultStreamAddon: 'org.torrentio' })
  }));
  const result = await actions.getSettings();
  assert.deepEqual(result, { defaultStreamAddon: 'org.torrentio' });
});

test('updateSettings persists and returns the new defaultStreamAddon', async () => {
  let written = null;
  const actions = createSettingsActions(baseDeps({
    writeSettingsImpl: async (dataDir, settings) => { written = settings; }
  }));
  const result = await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });
  assert.deepEqual(result, { defaultStreamAddon: 'org.torrentio' });
  assert.deepEqual(written, { defaultStreamAddon: 'org.torrentio' });
});

test('updateSettings rejects a non-string/non-null defaultStreamAddon without persisting', async () => {
  let writeCalled = false;
  const actions = createSettingsActions(baseDeps({
    writeSettingsImpl: async () => { writeCalled = true; }
  }));
  await assert.rejects(() => actions.updateSettings({ defaultStreamAddon: 42 }), ValidationError);
  assert.equal(writeCalled, false);
});

test('updateSettings normalizes an empty string to null', async () => {
  let written = null;
  const actions = createSettingsActions(baseDeps({
    writeSettingsImpl: async (dataDir, settings) => { written = settings; }
  }));
  const result = await actions.updateSettings({ defaultStreamAddon: '' });
  assert.equal(result.defaultStreamAddon, null);
  assert.equal(written.defaultStreamAddon, null);
});

test('updateSettings mutates the shared settings object in place rather than replacing it', async () => {
  const settings = {};
  const actions = createSettingsActions(baseDeps({ settings }));
  await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });
  assert.equal(settings.defaultStreamAddon, 'org.torrentio');
});

test('updateSettings re-resolves streamSource for a live channel with no per-channel streamAddon override', async () => {
  const channels = [{ id: 'a', name: 'A', streamSource: null }];
  const installedAddons = [{ manifest: { id: 'org.torrentio' }, transportUrl: 'https://torrentio/manifest.json' }];
  const actions = createSettingsActions(baseDeps({
    channels,
    discoverInstalledAddons: async () => installedAddons,
    resolveStreamSourceImpl: (channel, addons) => {
      const found = addons.find((a) => a.manifest.id === 'org.torrentio');
      return found ? { transportUrl: found.transportUrl } : null;
    }
  }));

  await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });

  assert.equal(channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
});

test('updateSettings does not call resolveStreamSourceImpl for a channel with its own streamAddon override', async () => {
  const channels = [{ id: 'b', name: 'B', streamAddon: 'org.other', streamSource: { transportUrl: 'https://other/manifest.json' } }];
  const calledFor = [];
  const actions = createSettingsActions(baseDeps({
    channels,
    resolveStreamSourceImpl: (channel) => { calledFor.push(channel.id); return null; }
  }));

  await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });

  assert.deepEqual(calledFor, []);
  assert.equal(channels[0].streamSource.transportUrl, 'https://other/manifest.json');
});

test('updateSettings does not touch channels or call discoverInstalledAddons when the patch does not include defaultStreamAddon', async () => {
  const channels = [{ id: 'a', streamSource: null }];
  let discoverCalled = false;
  const actions = createSettingsActions(baseDeps({
    channels,
    discoverInstalledAddons: async () => { discoverCalled = true; return []; }
  }));
  await actions.updateSettings({});
  assert.equal(discoverCalled, false);
  assert.equal(channels[0].streamSource, null);
});

test('listAddons returns degraded when Stremio discovery is unavailable', async () => {
  const actions = createSettingsActions(baseDeps({ discoverInstalledAddons: async () => null }));
  const result = await actions.listAddons();
  assert.deepEqual(result, { degraded: true, addons: [] });
});

test('listAddons flattens every installed addon into id/name pairs, regardless of catalogs', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.torrentio', name: 'Torrentio', catalogs: [] }, transportUrl: 'https://torrentio/manifest.json' },
      { manifest: { id: 'org.cinemeta', name: 'Cinemeta', catalogs: [{ id: 'top', type: 'movie' }] }, transportUrl: 'https://cinemeta/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.deepEqual(result, {
    degraded: false,
    addons: [
      { id: 'org.torrentio', name: 'Torrentio', supportsStreams: false },
      { id: 'org.cinemeta', name: 'Cinemeta', supportsStreams: false }
    ]
  });
});

test('listAddons reports supportsStreams: true when manifest.resources is an array of strings including "stream"', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.torrentio', name: 'Torrentio', resources: ['catalog', 'stream'] }, transportUrl: 'https://torrentio/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.equal(result.addons[0].supportsStreams, true);
});

test('listAddons reports supportsStreams: true when manifest.resources is an array of descriptor objects', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.torrentio', name: 'Torrentio', resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }] }, transportUrl: 'https://torrentio/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.equal(result.addons[0].supportsStreams, true);
});

test('listAddons reports supportsStreams: false when manifest.resources is absent entirely (no crash)', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.cinemeta', name: 'Cinemeta' }, transportUrl: 'https://cinemeta/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.equal(result.addons[0].supportsStreams, false);
});
