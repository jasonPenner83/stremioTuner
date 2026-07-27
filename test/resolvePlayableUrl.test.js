import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlayableUrl } from '../src/resolvePlayableUrl.js';

const ITEM = { id: 'tt1' };
const CHANNEL = { minQuality: '480p', language: 'en' };
const STREAM_SOURCE = { transportUrl: 'https://addon/manifest.json' };

test('returns a direct-URL candidate that passes the size check', async () => {
  const url = await resolvePlayableUrl({
    item: ITEM,
    type: 'movie',
    channel: CHANNEL,
    streamSource: STREAM_SOURCE,
    realDebridApiKey: null,
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', url: 'http://good' }],
    isLikelyPlayableSizeImpl: async () => true
  });
  assert.equal(url, 'http://good');
});

test('falls back to the next-ranked candidate when a direct URL fails the size check', async () => {
  const checkedUrls = [];
  const url = await resolvePlayableUrl({
    item: ITEM,
    type: 'movie',
    channel: CHANNEL,
    streamSource: STREAM_SOURCE,
    realDebridApiKey: null,
    fetchStreamsImpl: async () => [
      { title: '1080p 👤 50', url: 'http://placeholder' },
      { title: '1080p 👤 10', url: 'http://good' }
    ],
    isLikelyPlayableSizeImpl: async (u) => { checkedUrls.push(u); return u !== 'http://placeholder'; }
  });
  assert.equal(url, 'http://good');
  assert.deepEqual(checkedUrls, ['http://placeholder', 'http://good']);
});

test('resolves an RD-cached magnet candidate via resolveStreamImpl', async () => {
  let resolvedArgs = null;
  const url = await resolvePlayableUrl({
    item: ITEM,
    type: 'movie',
    channel: CHANNEL,
    streamSource: STREAM_SOURCE,
    realDebridApiKey: 'rd-key',
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', infoHash: 'abc123' }],
    checkInstantAvailabilityImpl: async () => new Set(['abc123']),
    resolveStreamImpl: async (apiKey, infoHash, opts) => { resolvedArgs = { apiKey, infoHash, opts }; return 'https://direct/play.mkv'; }
  });
  assert.equal(url, 'https://direct/play.mkv');
  assert.deepEqual(resolvedArgs, { apiKey: 'rd-key', infoHash: 'abc123', opts: { season: undefined, episode: undefined } });
});

test('ignores magnet candidates entirely when no realDebridApiKey is provided', async () => {
  let checkCalled = false;
  const url = await resolvePlayableUrl({
    item: ITEM,
    type: 'movie',
    channel: CHANNEL,
    streamSource: STREAM_SOURCE,
    realDebridApiKey: null,
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', infoHash: 'abc123' }],
    checkInstantAvailabilityImpl: async () => { checkCalled = true; return new Set(['abc123']); }
  });
  assert.equal(url, null);
  assert.equal(checkCalled, false);
});

test('falls back to the next candidate when Real-Debrid resolution fails, and returns null if all fail', async () => {
  const attempts = [];
  const url = await resolvePlayableUrl({
    item: ITEM,
    type: 'movie',
    channel: CHANNEL,
    streamSource: STREAM_SOURCE,
    realDebridApiKey: 'rd-key',
    fetchStreamsImpl: async () => [
      { title: '1080p 👤 50', infoHash: 'bad-one' },
      { title: '1080p 👤 10', infoHash: 'also-bad' }
    ],
    checkInstantAvailabilityImpl: async () => new Set(['bad-one', 'also-bad']),
    resolveStreamImpl: async (apiKey, infoHash) => { attempts.push(infoHash); throw new Error('always fails'); }
  });
  assert.equal(url, null);
  assert.deepEqual(attempts, ['bad-one', 'also-bad']);
});

test('returns null when no candidates are found at all', async () => {
  const url = await resolvePlayableUrl({
    item: ITEM,
    type: 'movie',
    channel: CHANNEL,
    streamSource: STREAM_SOURCE,
    realDebridApiKey: null,
    fetchStreamsImpl: async () => []
  });
  assert.equal(url, null);
});
