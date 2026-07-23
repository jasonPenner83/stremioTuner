import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, parseConfig, loadConfig } from '../src/config.js';

test('slugify lowercases and dashes non-alnum characters', () => {
  assert.equal(slugify('Marvel Movies'), 'marvel-movies');
  assert.equal(slugify('  90s Sitcoms!! '), '90s-sitcoms');
});

test('parseConfig accepts a valid config', () => {
  const parsed = parseConfig({
    refreshTime: '00:00',
    channels: [
      { name: 'Marvel Movies', addon: 'org.stremio.torrentio.addon', catalog: 'marvel-movies', mode: 'random-start', minQuality: '720p', language: 'en' }
    ]
  });
  assert.equal(parsed.refreshTime, '00:00');
  assert.deepEqual(parsed.channels, [
    { id: 'marvel-movies', name: 'Marvel Movies', addon: 'org.stremio.torrentio.addon', catalog: 'marvel-movies', mode: 'random-start', minQuality: '720p', language: 'en' }
  ]);
});

test('parseConfig rejects missing refreshTime', () => {
  assert.throws(() => parseConfig({ channels: [] }), /refreshTime/);
});

test('parseConfig rejects empty channels', () => {
  assert.throws(() => parseConfig({ refreshTime: '00:00', channels: [] }), /at least one channel/);
});

test('parseConfig rejects invalid mode', () => {
  assert.throws(() => parseConfig({
    refreshTime: '00:00',
    channels: [{ name: 'X', addon: 'a', catalog: 'c', mode: 'shuffle', minQuality: '720p', language: 'en' }]
  }), /invalid mode/);
});

test('parseConfig rejects channel missing a required field', () => {
  assert.throws(() => parseConfig({
    refreshTime: '00:00',
    channels: [{ name: 'X', catalog: 'c', mode: 'random', minQuality: '720p', language: 'en' }]
  }), /addon/);
});

test('loadConfig reads and parses YAML from disk', async () => {
  const fakeFs = {
    readFile: async (p) => {
      assert.equal(p, '/data/config.yml');
      return 'refreshTime: "00:00"\nchannels:\n  - name: X\n    addon: a\n    catalog: c\n    mode: random\n    minQuality: "480p"\n    language: en\n';
    }
  };
  const parsed = await loadConfig('/data/config.yml', { fs: fakeFs });
  assert.equal(parsed.channels[0].id, 'x');
});
