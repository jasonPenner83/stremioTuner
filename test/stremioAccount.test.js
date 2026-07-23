import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, getInstalledAddons, findAddonById, getAuthKey, invalidateAuthKey } from '../src/stremioAccount.js';

function fakeFetch(responses) {
  let call = 0;
  return async (url, opts) => {
    const r = responses[call++];
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body
    };
  };
}

test('login posts credentials and returns the authKey', async () => {
  const fetchImpl = fakeFetch([{ body: { result: { authKey: 'abc123' } } }]);
  const authKey = await login('a@b.com', 'pw', { fetchImpl, apiBase: 'https://api.example' });
  assert.equal(authKey, 'abc123');
});

test('login throws on error response', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401, body: { error: { message: 'bad creds' } } }]);
  await assert.rejects(() => login('a@b.com', 'wrong', { fetchImpl }), /bad creds/);
});

test('getInstalledAddons returns the addons array', async () => {
  const fetchImpl = fakeFetch([{ body: { result: { addons: [{ transportUrl: 'https://x/manifest.json', manifest: { id: 'org.x' } }] } } }]);
  const addons = await getInstalledAddons('abc123', { fetchImpl });
  assert.equal(addons[0].manifest.id, 'org.x');
});

test('findAddonById returns the matching addon', () => {
  const addons = [
    { transportUrl: 'https://a', manifest: { id: 'org.a' } },
    { transportUrl: 'https://b', manifest: { id: 'org.b' } }
  ];
  assert.equal(findAddonById(addons, 'org.b').transportUrl, 'https://b');
});

test('findAddonById throws when no addon matches', () => {
  assert.throws(() => findAddonById([], 'org.missing'), /org.missing/);
});

test('getAuthKey returns the cached key without logging in again', async () => {
  const fakeFs = { readFile: async () => JSON.stringify({ authKey: 'cached-key' }) };
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const authKey = await getAuthKey({ email: 'a@b.com', password: 'pw', cachePath: '/data/auth.json', fs: fakeFs, fetchImpl });
  assert.equal(authKey, 'cached-key');
});

test('getAuthKey logs in and writes the cache when no cache exists', async () => {
  let written = null;
  const fakeFs = {
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    writeFile: async (p, content) => { written = { p, content }; }
  };
  const fetchImpl = fakeFetch([{ body: { result: { authKey: 'fresh-key' } } }]);
  const authKey = await getAuthKey({ email: 'a@b.com', password: 'pw', cachePath: '/data/auth.json', fs: fakeFs, fetchImpl });
  assert.equal(authKey, 'fresh-key');
  assert.equal(JSON.parse(written.content).authKey, 'fresh-key');
});

test('invalidateAuthKey deletes the cache file so the next getAuthKey call re-logs in', async () => {
  let unlinked = null;
  const fakeFs = {
    unlink: async (p) => { unlinked = p; }
  };
  await invalidateAuthKey('/data/auth.json', { fs: fakeFs });
  assert.equal(unlinked, '/data/auth.json');
});

test('invalidateAuthKey tolerates a missing cache file', async () => {
  const fakeFs = {
    unlink: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
  };
  await assert.doesNotReject(() => invalidateAuthKey('/data/auth.json', { fs: fakeFs }));
});

test('invalidateAuthKey followed by getAuthKey forces a fresh login instead of reusing stale cache', async () => {
  let cacheContent = JSON.stringify({ authKey: 'stale-key' });
  const fakeFs = {
    readFile: async () => {
      if (cacheContent === null) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return cacheContent;
    },
    unlink: async () => { cacheContent = null; },
    writeFile: async (p, content) => { cacheContent = content; }
  };
  const fetchImpl = fakeFetch([{ body: { result: { authKey: 'fresh-key' } } }]);

  await invalidateAuthKey('/data/auth.json', { fs: fakeFs });
  const authKey = await getAuthKey({ email: 'a@b.com', password: 'pw', cachePath: '/data/auth.json', fs: fakeFs, fetchImpl });

  assert.equal(authKey, 'fresh-key');
});
