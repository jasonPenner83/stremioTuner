import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildM3u } from '../src/m3u.js';

test('buildM3u emits one EXTINF + URL pair per channel', () => {
  const m3u = buildM3u([
    { id: 'marvel-movies', name: 'Marvel Movies' },
    { id: 'sitcoms-90s', name: '90s Sitcoms' }
  ], 'http://localhost:8080');

  const expected = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="marvel-movies" tvg-name="Marvel Movies" group-title="stremioTuner",Marvel Movies',
    'http://localhost:8080/stream/marvel-movies',
    '#EXTINF:-1 tvg-id="sitcoms-90s" tvg-name="90s Sitcoms" group-title="stremioTuner",90s Sitcoms',
    'http://localhost:8080/stream/sitcoms-90s',
    ''
  ].join('\n');

  assert.equal(m3u, expected);
});
