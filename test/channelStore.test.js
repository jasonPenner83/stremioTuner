import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  channelsPath,
  readChannels,
  writeChannels,
  channelId,
  slugify,
  validateNewChannelFields,
  validatePatchFields
} from '../src/channelStore.js';

test('channelsPath joins dataDir/channels.json', () => {
  assert.equal(channelsPath('/data'), path.join('/data', 'channels.json'));
});

test('slugify lowercases and dashes non-alnum characters', () => {
  assert.equal(slugify('org.stremio.torrentio.addon:marvel-movies'), 'org-stremio-torrentio-addon-marvel-movies');
});

test('channelId derives a stable id from addon and catalog', () => {
  assert.equal(channelId('org.a', 'cat-b'), slugify('org.a:cat-b'));
});

test('readChannels returns an empty array when the file does not exist', async () => {
  const fakeFs = {
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
  };
  const result = await readChannels('/data', { fs: fakeFs });
  assert.deepEqual(result, []);
});

test('readChannels parses the persisted JSON', async () => {
  const fakeFs = { readFile: async () => JSON.stringify([{ id: 'x' }]) };
  const result = await readChannels('/data', { fs: fakeFs });
  assert.deepEqual(result, [{ id: 'x' }]);
});

test('writeChannels creates the directory and writes JSON', async () => {
  const calls = { mkdir: null, writeFile: null };
  const fakeFs = {
    mkdir: async (dir, opts) => { calls.mkdir = { dir, opts }; },
    writeFile: async (p, content) => { calls.writeFile = { p, content }; }
  };
  await writeChannels('/data', [{ id: 'x' }], { fs: fakeFs });
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.ok(calls.writeFile.p.endsWith('channels.json'));
  assert.deepEqual(JSON.parse(calls.writeFile.content), [{ id: 'x' }]);
});

test('validateNewChannelFields accepts a valid mode/minQuality/language combination', () => {
  assert.doesNotThrow(() => validateNewChannelFields({ mode: 'random-start', minQuality: '720p', language: 'en' }));
});

test('validateNewChannelFields rejects an invalid mode', () => {
  assert.throws(() => validateNewChannelFields({ mode: 'shuffle', minQuality: '720p', language: 'en' }), /mode/);
});

test('validateNewChannelFields rejects an invalid minQuality', () => {
  assert.throws(() => validateNewChannelFields({ mode: 'random', minQuality: '4k', language: 'en' }), /minQuality/);
});

test('validateNewChannelFields rejects an invalid language', () => {
  assert.throws(() => validateNewChannelFields({ mode: 'random', minQuality: '720p', language: 'xx' }), /language/);
});

test('validatePatchFields ignores fields that are absent', () => {
  assert.doesNotThrow(() => validatePatchFields({ enabled: false }));
});

test('validatePatchFields validates fields that are present', () => {
  assert.throws(() => validatePatchFields({ mode: 'bogus' }), /mode/);
});
