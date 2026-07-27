import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuality, qualityRank, parsePeers, matchesLanguage, selectStream, rankStreams } from '../src/streamSelect.js';

test('parseQuality finds known quality tokens', () => {
  assert.equal(parseQuality('Movie.Title.2020.1080p.WEB-DL'), '1080p');
  assert.equal(parseQuality('Movie.Title.2020.2160p.UHD'), '2160p');
  assert.equal(parseQuality('Movie.Title.2020.4K.REMUX'), '2160p');
  assert.equal(parseQuality('Movie.Title.2020'), null);
});

test('qualityRank orders qualities and returns null for unknown', () => {
  assert.ok(qualityRank('1080p') > qualityRank('720p'));
  assert.equal(qualityRank(null), null);
});

test('parsePeers reads Torrentio-style emoji peer counts', () => {
  assert.equal(parsePeers('👤 45 💾 2.1GB ⚙️ Group'), 45);
});

test('parsePeers falls back to "N seeds"/"N peers" text', () => {
  assert.equal(parsePeers('120 seeds, 4.2GB'), 120);
  assert.equal(parsePeers('7 peers'), 7);
});

test('parsePeers defaults to 0 when nothing found', () => {
  assert.equal(parsePeers('no peer info here'), 0);
});

test('matchesLanguage matches an explicit non-English language', () => {
  assert.equal(matchesLanguage('Movie [Spanish Dub] 1080p', 'es'), true);
  assert.equal(matchesLanguage('Movie [Spanish Dub] 1080p', 'en'), false);
});

test('matchesLanguage treats untagged titles as English by default', () => {
  assert.equal(matchesLanguage('Movie.Title.2020.1080p.WEB-DL', 'en'), true);
});

test('matchesLanguage rejects English when another language is tagged', () => {
  assert.equal(matchesLanguage('Movie [French] 1080p', 'en'), false);
});

test('selectStream picks the highest-peer stream meeting language + minQuality', () => {
  const streams = [
    { title: '1080p 👤 10', url: 'http://a' },
    { title: '1080p 👤 50', url: 'http://b' },
    { title: '720p 👤 999', url: 'http://c' }
  ];
  const result = selectStream(streams, { minQuality: '1080p', language: 'en' });
  assert.equal(result.url, 'http://b');
});

test('selectStream relaxes quality but keeps language when nothing meets minQuality', () => {
  const streams = [
    { title: '480p 👤 5', url: 'http://a' },
    { title: '480p 👤 20', url: 'http://b' }
  ];
  const result = selectStream(streams, { minQuality: '1080p', language: 'en' });
  assert.equal(result.url, 'http://b');
});

test('selectStream returns null when nothing matches language at all', () => {
  const streams = [
    { title: '[French] 1080p 👤 50', url: 'http://a' }
  ];
  const result = selectStream(streams, { minQuality: '480p', language: 'en' });
  assert.equal(result, null);
});

test('selectStream ignores candidates without a url', () => {
  const streams = [
    { title: '1080p 👤 999' },
    { title: '1080p 👤 5', url: 'http://a' }
  ];
  const result = selectStream(streams, { minQuality: '720p', language: 'en' });
  assert.equal(result.url, 'http://a');
});

test('selectStream accepts magnet-only candidates (infoHash, no url) alongside url candidates', () => {
  const streams = [
    { title: '1080p 👤 5', infoHash: 'abc123' },
    { title: '1080p 👤 50', url: 'http://b' }
  ];
  const result = selectStream(streams, { minQuality: '1080p', language: 'en' });
  assert.equal(result.url, 'http://b');
});

test('selectStream returns infoHash on the winning candidate when it has no url', () => {
  const streams = [
    { title: '1080p 👤 999', infoHash: 'abc123' }
  ];
  const result = selectStream(streams, { minQuality: '1080p', language: 'en' });
  assert.equal(result.url, undefined);
  assert.equal(result.infoHash, 'abc123');
});

test('selectStream ignores candidates with neither url nor infoHash', () => {
  const streams = [
    { title: '1080p 👤 999' },
    { title: '1080p 👤 5', infoHash: 'abc123' }
  ];
  const result = selectStream(streams, { minQuality: '720p', language: 'en' });
  assert.equal(result.infoHash, 'abc123');
});

test('rankStreams orders strict-tier candidates by peers descending, ahead of relaxed-tier candidates', () => {
  const streams = [
    { title: '480p 👤 999', url: 'http://relaxed-high' },
    { title: '1080p 👤 5', url: 'http://strict-low' },
    { title: '1080p 👤 50', url: 'http://strict-high' }
  ];
  const result = rankStreams(streams, { minQuality: '1080p', language: 'en' });
  assert.deepEqual(result.map((c) => c.url), ['http://strict-high', 'http://strict-low', 'http://relaxed-high']);
});

test('rankStreams does not list a candidate twice when it qualifies for both tiers', () => {
  const streams = [
    { title: '1080p 👤 10', url: 'http://a' }
  ];
  const result = rankStreams(streams, { minQuality: '720p', language: 'en' });
  assert.equal(result.length, 1);
});

test('rankStreams falls back to sorted relaxed-tier candidates when no strict-tier candidate exists', () => {
  const streams = [
    { title: '480p 👤 5', url: 'http://a' },
    { title: '480p 👤 20', url: 'http://b' }
  ];
  const result = rankStreams(streams, { minQuality: '1080p', language: 'en' });
  assert.deepEqual(result.map((c) => c.url), ['http://b', 'http://a']);
});

test('rankStreams returns an empty array when nothing matches language at all', () => {
  const streams = [
    { title: '[French] 1080p 👤 50', url: 'http://a' }
  ];
  const result = rankStreams(streams, { minQuality: '480p', language: 'en' });
  assert.deepEqual(result, []);
});
