import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalog, fetchMeta, fetchStreams, resolveChannelSource } from '../src/addonClient.js';

function fakeFetch(expectedUrl, body, ok = true) {
  return async (url) => {
    assert.equal(url, expectedUrl);
    return { ok, status: ok ? 200 : 500, json: async () => body };
  };
}

test('fetchCatalog requests the correct URL and returns metas', async () => {
  const fetchImpl = fakeFetch(
    'https://addon.example/catalog/movie/marvel-movies.json',
    { metas: [{ id: 'tt1', type: 'movie', name: 'Iron Man' }] }
  );
  const items = await fetchCatalog('https://addon.example/manifest.json', 'movie', 'marvel-movies', { fetchImpl });
  assert.deepEqual(items, [{ id: 'tt1', type: 'movie', name: 'Iron Man' }]);
});

test('fetchCatalog throws on a non-ok response', async () => {
  const fetchImpl = fakeFetch('https://addon.example/catalog/movie/x.json', {}, false);
  await assert.rejects(() => fetchCatalog('https://addon.example/manifest.json', 'movie', 'x', { fetchImpl }));
});

test('fetchMeta returns the meta object', async () => {
  const fetchImpl = fakeFetch(
    'https://addon.example/meta/movie/tt1.json',
    { meta: { id: 'tt1', runtime: '126 min' } }
  );
  const meta = await fetchMeta('https://addon.example/manifest.json', 'movie', 'tt1', { fetchImpl });
  assert.equal(meta.runtime, '126 min');
});

test('fetchMeta returns null on a non-ok response', async () => {
  const fetchImpl = fakeFetch('https://addon.example/meta/movie/tt1.json', {}, false);
  const meta = await fetchMeta('https://addon.example/manifest.json', 'movie', 'tt1', { fetchImpl });
  assert.equal(meta, null);
});

test('fetchStreams returns the streams array', async () => {
  const fetchImpl = fakeFetch(
    'https://addon.example/stream/movie/tt1.json',
    { streams: [{ title: '1080p', url: 'http://x' }] }
  );
  const streams = await fetchStreams('https://addon.example/manifest.json', 'movie', 'tt1', { fetchImpl });
  assert.deepEqual(streams, [{ title: '1080p', url: 'http://x' }]);
});

test('resolveChannelSource finds the catalog\'s type by id', () => {
  const manifest = { id: 'org.x', catalogs: [{ id: 'marvel-movies', type: 'movie' }, { id: 'sitcoms', type: 'series' }] };
  assert.deepEqual(resolveChannelSource(manifest, 'sitcoms'), { type: 'series', catalogId: 'sitcoms' });
});

test('resolveChannelSource throws when the catalog id is not in the manifest', () => {
  const manifest = { id: 'org.x', catalogs: [] };
  assert.throws(() => resolveChannelSource(manifest, 'missing'), /missing/);
});
