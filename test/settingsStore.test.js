import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { settingsPath, readSettings, writeSettings } from '../src/settingsStore.js';

test('settingsPath joins dataDir/settings.json', () => {
  assert.equal(settingsPath('/data'), path.join('/data', 'settings.json'));
});

test('readSettings returns an empty object when the file does not exist', async () => {
  const fakeFs = {
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
  };
  const result = await readSettings('/data', { fs: fakeFs });
  assert.deepEqual(result, {});
});

test('readSettings parses the persisted JSON', async () => {
  const fakeFs = { readFile: async () => JSON.stringify({ defaultStreamAddon: 'org.torrentio' }) };
  const result = await readSettings('/data', { fs: fakeFs });
  assert.deepEqual(result, { defaultStreamAddon: 'org.torrentio' });
});

test('readSettings rethrows a non-ENOENT error', async () => {
  const fakeFs = { readFile: async () => { throw new Error('disk exploded'); } };
  await assert.rejects(() => readSettings('/data', { fs: fakeFs }), /disk exploded/);
});

test('writeSettings creates the directory and writes JSON', async () => {
  const calls = { mkdir: null, writeFile: null };
  const fakeFs = {
    mkdir: async (dir, opts) => { calls.mkdir = { dir, opts }; },
    writeFile: async (p, content) => { calls.writeFile = { p, content }; }
  };
  await writeSettings('/data', { defaultStreamAddon: 'org.torrentio' }, { fs: fakeFs });
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.ok(calls.writeFile.p.endsWith('settings.json'));
  assert.deepEqual(JSON.parse(calls.writeFile.content), { defaultStreamAddon: 'org.torrentio' });
});
