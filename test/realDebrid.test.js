import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeasonEpisode, pickTorrentFile, checkInstantAvailability, resolveStream } from '../src/realDebrid.js';

test('parseSeasonEpisode extracts season/episode from a "tt123:S:E" id', () => {
  assert.deepEqual(parseSeasonEpisode('tt1234567:2:5'), { season: 2, episode: 5 });
});

test('parseSeasonEpisode returns empty object for a plain movie id', () => {
  assert.deepEqual(parseSeasonEpisode('tt1234567'), {});
});

test('pickTorrentFile matches SxxEyy filename when season/episode given', () => {
  const files = [
    { id: 1, path: '/Show.S01E01.mkv', bytes: 500 },
    { id: 2, path: '/Show.S01E02.mkv', bytes: 600 },
    { id: 3, path: '/Show.S01E02.sample.mkv', bytes: 10 }
  ];
  const result = pickTorrentFile(files, { season: 1, episode: 2 });
  assert.equal(result.id, 2);
});

test('pickTorrentFile falls back to the largest file when no season/episode given', () => {
  const files = [
    { id: 1, path: '/Movie.sample.mkv', bytes: 10 },
    { id: 2, path: '/Movie.mkv', bytes: 5000 }
  ];
  const result = pickTorrentFile(files, {});
  assert.equal(result.id, 2);
});

test('pickTorrentFile returns null for an empty file list', () => {
  assert.equal(pickTorrentFile([], {}), null);
});

test('checkInstantAvailability returns the subset of hashes RD reports as cached', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/hash1/hash2');
    return {
      ok: true,
      json: async () => ({
        hash1: { rd: [{ 1: { filename: 'a.mkv' } }] },
        hash2: {}
      })
    };
  };
  const cached = await checkInstantAvailability('key', ['hash1', 'hash2'], { fetchImpl });
  assert.deepEqual([...cached], ['hash1']);
});

test('checkInstantAvailability returns an empty set without calling fetch for an empty input', async () => {
  let called = false;
  const cached = await checkInstantAvailability('key', [], { fetchImpl: async () => { called = true; } });
  assert.deepEqual([...cached], []);
  assert.equal(called, false);
});

test('checkInstantAvailability throws on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => checkInstantAvailability('key', ['hash1'], { fetchImpl }));
});

test('resolveStream reuses an existing torrent by hash without re-adding it', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents') {
      return { ok: true, json: async () => ([{ hash: 'ABC123', links: ['https://rd/link1'] }]) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/unrestrict/link') {
      assert.equal(opts.method, 'POST');
      return { ok: true, json: async () => ({ download: 'https://direct/play.mkv' }) };
    }
    throw new Error(`unexpected call to ${url}`);
  };
  const result = await resolveStream('key', 'abc123', {}, { fetchImpl });
  assert.equal(result, 'https://direct/play.mkv');
  assert.deepEqual(calls, [
    'https://api.real-debrid.com/rest/1.0/torrents',
    'https://api.real-debrid.com/rest/1.0/unrestrict/link'
  ]);
});

test('resolveStream adds a magnet, selects the matching episode file, and unrestricts the link when not already added', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents') {
      return { ok: true, json: async () => ([]) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/addMagnet') {
      assert.match(opts.body.toString(), /magnet%3A%3Fxt%3Durn%3Abtih%3Aabc123/);
      return { ok: true, json: async () => ({ id: 'tid1' }) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/info/tid1') {
      const infoCallIndex = calls.filter((c) => c === url).length;
      if (infoCallIndex === 1) {
        return { ok: true, json: async () => ({ files: [{ id: 1, path: '/Show.S01E01.mkv', bytes: 500 }, { id: 2, path: '/Show.S01E02.mkv', bytes: 600 }] }) };
      }
      return { ok: true, json: async () => ({ links: ['https://rd/link2'] }) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/selectFiles/tid1') {
      assert.equal(opts.body.toString(), 'files=2');
      return { ok: true, json: async () => ({}) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/unrestrict/link') {
      return { ok: true, json: async () => ({ download: 'https://direct/ep2.mkv' }) };
    }
    throw new Error(`unexpected call to ${url}`);
  };
  const result = await resolveStream('key', 'abc123', { season: 1, episode: 2 }, { fetchImpl });
  assert.equal(result, 'https://direct/ep2.mkv');
});

test('resolveStream throws when no link is produced after selecting files', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents') return { ok: true, json: async () => ([]) };
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/addMagnet') return { ok: true, json: async () => ({ id: 'tid1' }) };
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/info/tid1') {
      return { ok: true, json: async () => ({ files: [{ id: 1, path: '/a.mkv', bytes: 100 }], links: [] }) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/selectFiles/tid1') return { ok: true, json: async () => ({}) };
    throw new Error(`unexpected call to ${url}`);
  };
  await assert.rejects(() => resolveStream('key', 'abc123', {}, { fetchImpl }), /No link produced/);
});

test('resolveStream throws when the unrestricted file is too small on the reuse-by-hash path (likely a takedown placeholder)', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents') {
      return { ok: true, json: async () => ([{ hash: 'ABC123', links: ['https://rd/link1'] }]) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/unrestrict/link') {
      return { ok: true, json: async () => ({ download: 'https://direct/placeholder.mkv', filesize: 2 * 1024 * 1024 }) };
    }
    throw new Error(`unexpected call to ${url}`);
  };
  await assert.rejects(() => resolveStream('key', 'abc123', {}, { fetchImpl }), /too small/);
});

test('resolveStream throws when the unrestricted file is too small on the fresh add/select/unrestrict path', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents') {
      return { ok: true, json: async () => ([]) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/addMagnet') {
      return { ok: true, json: async () => ({ id: 'tid1' }) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/info/tid1') {
      const infoCallIndex = calls.filter((c) => c === url).length;
      if (infoCallIndex === 1) {
        return { ok: true, json: async () => ({ files: [{ id: 1, path: '/Movie.mkv', bytes: 5000 }] }) };
      }
      return { ok: true, json: async () => ({ links: ['https://rd/link2'] }) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents/selectFiles/tid1') {
      return { ok: true, json: async () => ({}) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/unrestrict/link') {
      return { ok: true, json: async () => ({ download: 'https://direct/placeholder.mkv', filesize: 2 * 1024 * 1024 }) };
    }
    throw new Error(`unexpected call to ${url}`);
  };
  await assert.rejects(() => resolveStream('key', 'abc123', {}, { fetchImpl }), /too small/);
});

test('resolveStream resolves normally when filesize is at or above the minimum threshold', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.real-debrid.com/rest/1.0/torrents') {
      return { ok: true, json: async () => ([{ hash: 'ABC123', links: ['https://rd/link1'] }]) };
    }
    if (url === 'https://api.real-debrid.com/rest/1.0/unrestrict/link') {
      return { ok: true, json: async () => ({ download: 'https://direct/play.mkv', filesize: 500 * 1024 * 1024 }) };
    }
    throw new Error(`unexpected call to ${url}`);
  };
  const result = await resolveStream('key', 'abc123', {}, { fetchImpl });
  assert.equal(result, 'https://direct/play.mkv');
});
