# Real-Debrid Stream Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a channel use a separate addon for stream lookup (distinct from its catalog addon), and resolve magnet-only stream candidates (`infoHash`, no `url`) to a direct playable link via the Real-Debrid API, restricted to torrents RD already has cached.

**Architecture:** A new `src/realDebrid.js` module wraps the RD REST API (instant-availability check, reuse-by-hash, add/select/unrestrict). `streamSelect.js` is loosened to rank `infoHash` candidates alongside `url` ones. `bootstrap.js`/`channelActions.js` gain an optional `streamAddon` per channel, resolved to `channel.streamSource` the same way `channel.source` is resolved today — when absent, `app.js` falls back to `channel.source` so every existing channel/test keeps working unchanged. `app.js`'s `/stream/:channelId` handler fetches from the (possibly-fallback) stream source, filters magnet candidates down to RD-cached ones before selection, and resolves the chosen candidate via RD only if it's magnet-only.

**Tech Stack:** Node.js (native `fetch`, no new dependencies), `node:test`/`node:assert`.

## Global Constraints

- No new npm dependencies — use native `fetch` (Node 20+) for the Real-Debrid HTTP calls, same as `addonClient.js` and `stremioAccount.js` already do.
- `streamAddon` is **optional** on a channel record — omitting it preserves today's behavior exactly (stream fetch falls back to the catalog addon). This keeps every existing fixture/test in `bootstrap.test.js`, `channelActions.test.js`, and `app.test.js` passing unmodified.
- `REALDEBRID_API_KEY` env var — if unset, magnet-only candidates are simply never selectable (no crash, no per-request error spam — one startup warning log).
- RD torrent entries are reused by hash, never deleted (per the design's decided cleanup approach).
- Follow existing code style: named exports, injectable `fetchImpl`/`*Impl` params for testability, `node:test` + `node:assert/strict`.

---

### Task 1: Loosen `streamSelect.js` to accept magnet-only candidates

**Files:**
- Modify: `src/streamSelect.js:53-74`
- Test: `test/streamSelect.test.js`

**Interfaces:**
- Produces: `selectStream(streams, {minQuality, language})` now returns a candidate object that also carries `infoHash` (when the source stream had one), in addition to the existing `url`, `quality`, `peers`, `languageOk` shape consumed by `app.js`.

- [ ] **Step 1: Write the failing test**

Add to `test/streamSelect.test.js` (after the existing `selectStream ignores candidates without a url` test):

```js
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/streamSelect.test.js`
Expected: the 3 new tests FAIL (current filter drops candidates without `.url`, so `result` is `null`/`undefined` where a `.url`/`.infoHash` assertion is expected).

- [ ] **Step 3: Implement the minimal change**

In `src/streamSelect.js`, update `selectStream`:

```js
export function selectStream(streams, { minQuality, language }) {
  const minRank = qualityRank(minQuality);
  const parsed = streams
    .filter((s) => !!s.url || !!s.infoHash)
    .map((s) => {
      const text = `${s.title || ''} ${s.name || ''}`;
      return {
        url: s.url,
        infoHash: s.infoHash,
        quality: parseQuality(text),
        peers: parsePeers(text),
        languageOk: matchesLanguage(text, language)
      };
    });

  const strict = parsed.filter((c) => c.languageOk && c.quality !== null && qualityRank(c.quality) >= minRank);
  if (strict.length) return maxByPeers(strict);

  const relaxed = parsed.filter((c) => c.languageOk);
  if (relaxed.length) return maxByPeers(relaxed);

  return null;
}
```

(Only the filter predicate and the added `infoHash: s.infoHash` line change; everything else is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/streamSelect.test.js`
Expected: all tests PASS (existing ones still pass since `.url`-only candidates behave identically — `infoHash` is just `undefined` for them).

- [ ] **Step 5: Commit**

```bash
git add src/streamSelect.js test/streamSelect.test.js
git commit -m "Let selectStream rank magnet-only (infoHash) candidates alongside direct-url ones"
```

---

### Task 2: `src/realDebrid.js` — Real-Debrid API client

**Files:**
- Create: `src/realDebrid.js`
- Test: `test/realDebrid.test.js`

**Interfaces:**
- Consumes: native `fetch` (injectable as `fetchImpl` in an options bag, matching `addonClient.js`'s pattern).
- Produces:
  - `parseSeasonEpisode(id: string): {season?: number, episode?: number}`
  - `pickTorrentFile(files: Array<{id, path, bytes}>, {season?, episode?}): {id, path, bytes} | null`
  - `checkInstantAvailability(apiKey: string, infoHashes: string[], {fetchImpl?}): Promise<Set<string>>`
  - `resolveStream(apiKey: string, infoHash: string, {season?, episode?}, {fetchImpl?}): Promise<string>` — returns the direct download URL, throws on any failure.

- [ ] **Step 1: Write the failing tests**

Create `test/realDebrid.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/realDebrid.test.js`
Expected: FAIL with "Cannot find module '../src/realDebrid.js'" (file doesn't exist yet).

- [ ] **Step 3: Implement `src/realDebrid.js`**

```js
const API_BASE = 'https://api.real-debrid.com/rest/1.0';

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function formHeaders(apiKey) {
  return { ...authHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' };
}

export function parseSeasonEpisode(id) {
  const match = String(id).match(/:(\d+):(\d+)$/);
  if (!match) return {};
  return { season: Number(match[1]), episode: Number(match[2]) };
}

const EPISODE_RE = /s(\d{1,2})e(\d{1,2})|(\d{1,2})x(\d{1,2})/i;

export function pickTorrentFile(files, { season, episode } = {}) {
  if (season != null && episode != null) {
    const found = files.find((f) => {
      const m = f.path.match(EPISODE_RE);
      if (!m) return false;
      const s = Number(m[1] ?? m[3]);
      const e = Number(m[2] ?? m[4]);
      return s === season && e === episode;
    });
    if (found) return found;
  }
  if (!files.length) return null;
  return files.reduce((largest, f) => (f.bytes > largest.bytes ? f : largest));
}

export async function checkInstantAvailability(apiKey, infoHashes, { fetchImpl = fetch } = {}) {
  if (!infoHashes.length) return new Set();
  const path = infoHashes.map((h) => h.toLowerCase()).join('/');
  const res = await fetchImpl(`${API_BASE}/torrents/instantAvailability/${path}`, {
    headers: authHeaders(apiKey)
  });
  if (!res.ok) throw new Error(`instantAvailability failed (${res.status})`);
  const data = await res.json();
  const cached = new Set();
  for (const hash of infoHashes) {
    const entry = data[hash.toLowerCase()];
    if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) cached.add(hash);
  }
  return cached;
}

async function findExistingTorrent(apiKey, infoHash, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`list torrents failed (${res.status})`);
  const list = await res.json();
  return list.find((t) => t.hash?.toLowerCase() === infoHash.toLowerCase() && t.links?.length > 0) || null;
}

async function addMagnet(apiKey, infoHash, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents/addMagnet`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${infoHash}` })
  });
  if (!res.ok) throw new Error(`addMagnet failed (${res.status})`);
  return res.json();
}

async function getTorrentInfo(apiKey, id, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents/info/${id}`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`torrent info failed (${res.status})`);
  return res.json();
}

async function selectFiles(apiKey, id, fileId, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents/selectFiles/${id}`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ files: String(fileId) })
  });
  if (!res.ok) throw new Error(`selectFiles failed (${res.status})`);
}

async function unrestrictLink(apiKey, link, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ link })
  });
  if (!res.ok) throw new Error(`unrestrict/link failed (${res.status})`);
  const data = await res.json();
  return data.download;
}

export async function resolveStream(apiKey, infoHash, { season, episode } = {}, { fetchImpl = fetch } = {}) {
  const existing = await findExistingTorrent(apiKey, infoHash, fetchImpl);
  if (existing) {
    return unrestrictLink(apiKey, existing.links[0], fetchImpl);
  }

  const { id } = await addMagnet(apiKey, infoHash, fetchImpl);
  const info = await getTorrentInfo(apiKey, id, fetchImpl);
  const file = pickTorrentFile(info.files || [], { season, episode });
  if (!file) throw new Error(`No file found in torrent ${id} for ${infoHash}`);

  await selectFiles(apiKey, id, file.id, fetchImpl);
  const updatedInfo = await getTorrentInfo(apiKey, id, fetchImpl);
  const link = updatedInfo.links?.[0];
  if (!link) throw new Error(`No link produced for torrent ${id}`);

  return unrestrictLink(apiKey, link, fetchImpl);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/realDebrid.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/realDebrid.js test/realDebrid.test.js
git commit -m "Add Real-Debrid API client: instant availability, reuse-by-hash resolution, episode file matching"
```

---

### Task 3: Optional per-channel `streamAddon` resolved in `bootstrap.js`

**Files:**
- Modify: `src/bootstrap.js:69-149`
- Test: `test/bootstrap.test.js`

**Interfaces:**
- Consumes: `findAddonById(installedAddons, addonId)` (existing, from `stremioAccount.js`).
- Produces: each live channel object gains `streamSource: {transportUrl} | null` — `null` when `channel.streamAddon` is unset or unresolvable (mirrors `source`'s existing null-on-failure pattern). `resolveStreamSource(channel, installedAddons)` is passed into `createChannelActionsImpl` as `resolveStreamSourceImpl` for Task 4 to use.

- [ ] **Step 1: Write the failing test**

Add to `test/bootstrap.test.js` (the `channel()` helper and `fakeApp()` already exist at the top):

```js
test('bootstrap resolves an optional streamAddon into streamSource, independent of the catalog source', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'with-stream', name: 'WithStream', addon: 'org.a', catalog: 'cat-a', streamAddon: 'org.torrentio' }),
      channel({ id: 'no-stream', name: 'NoStream', addon: 'org.a', catalog: 'cat-a' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://torrentio/manifest.json', manifest: { id: 'org.torrentio', catalogs: [] } }
    ],
    findAddonByIdImpl: (addons, id) => {
      const found = addons.find((a) => a.manifest.id === id);
      if (!found) throw new Error(`addon not found: ${id}`);
      return found;
    },
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'with-stream').streamSource.transportUrl, 'https://torrentio/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'no-stream').streamSource, null);
});

test('bootstrap sets streamSource: null (not a crash) when streamAddon does not resolve', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', streamAddon: 'org.missing' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => {
      const found = addons.find((a) => a.manifest.id === id);
      if (!found) throw new Error(`addon not found: ${id}`);
      return found;
    },
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].streamSource, null);
  assert.equal(createdAppArgs[0].channels[0].source.transportUrl, 'https://a/manifest.json');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bootstrap.test.js`
Expected: FAIL — `streamSource` is `undefined` (property doesn't exist yet), so `.transportUrl`/`equal(..., null)` assertions fail.

- [ ] **Step 3: Implement the change**

In `src/bootstrap.js`, add a `resolveStreamSource` function right after `resolveSource` (line 81):

```js
  function resolveStreamSource(channel, installedAddons) {
    if (!channel.streamAddon) return null;
    if (!installedAddons) return null;
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, channel.streamAddon);
      return { transportUrl: addonEntry.transportUrl };
    } catch (err) {
      console.error(`Could not resolve stream addon for channel "${channel.name}": ${err.message}`);
      return null;
    }
  }
```

Update the channel-loading map (was lines 102-107):

```js
  const persistedChannels = await readChannelsImpl(dataDir);
  const channels = persistedChannels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      ...channel,
      source: resolveSource(channel, installedAddonsAtStartup),
      streamSource: resolveStreamSource(channel, installedAddonsAtStartup)
    }));
```

Update `runDailyRegeneration`'s re-resolution block (was lines 118-132) to also re-resolve a missing `streamSource`:

```js
  async function runDailyRegeneration() {
    const channelsNeedingSource = channels.filter((channel) => !channel.source || (channel.streamAddon && !channel.streamSource));
    if (channelsNeedingSource.length > 0) {
      const installedAddons = await discoverInstalledAddons();
      if (installedAddons) {
        for (const channel of channelsNeedingSource) {
          if (!channel.source) {
            const source = resolveSource(channel, installedAddons);
            if (source) channel.source = source;
          }
          if (channel.streamAddon && !channel.streamSource) {
            const streamSource = resolveStreamSource(channel, installedAddons);
            if (streamSource) channel.streamSource = streamSource;
          }
        }
      }
    }

    for (const channel of channels) {
      await regenerate(channel);
    }
  }
```

Pass `resolveStreamSourceImpl` into `createChannelActionsImpl` (was lines 141-149):

```js
  const channelActions = createChannelActionsImpl({
    dataDir,
    channels,
    discoverInstalledAddons,
    resolveSourceImpl: resolveSource,
    resolveStreamSourceImpl: resolveStreamSource,
    regenerateImpl: regenerate,
    readChannelsImpl,
    writeChannelsImpl
  });
```

Also add the RD API key startup warning and pass it through to `createAppImpl`. Near the top of `bootstrap()` (after line 44's `baseUrl` computation):

```js
  const realDebridApiKey = env.REALDEBRID_API_KEY || null;
  if (!realDebridApiKey) {
    console.warn('REALDEBRID_API_KEY not set — magnet-only stream candidates will be ignored.');
  }
```

And update the `createAppImpl` call (was line 151):

```js
  const app = createAppImpl({ channels, dataDir, baseUrl, channelActions, realDebridApiKey });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/bootstrap.test.js`
Expected: all tests PASS, including the pre-existing ones (they never set `streamAddon`, so `resolveStreamSource` returns `null` for them, which the pre-existing assertions never check — no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.js test/bootstrap.test.js
git commit -m "Resolve an optional per-channel streamAddon into streamSource; wire REALDEBRID_API_KEY through"
```

---

### Task 4: `channelActions.js` — accept and resolve `streamAddon` on add/update

**Files:**
- Modify: `src/channelActions.js`
- Test: `test/channelActions.test.js`

**Interfaces:**
- Consumes: `resolveStreamSourceImpl(channel, installedAddons)` from Task 3, injected the same way `resolveSourceImpl` is.
- Produces: `addChannel`/`updateChannel` records may include a `streamAddon` field; the live channel objects they push/mutate include a `streamSource` field alongside `source`.

- [ ] **Step 1: Write the failing test**

Add to `test/channelActions.test.js` (check the existing file first for its `createChannelActions(...)` test-setup helper and mirror its mocking style for `resolveSourceImpl`/`discoverInstalledAddons`/`regenerateImpl`):

```js
test('addChannel resolves an optional streamAddon into streamSource on the live channel', async () => {
  const channels = [];
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([{ manifest: { id: 'org.torrentio' }, transportUrl: 'https://torrentio/manifest.json' }]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel, installedAddons) => {
      const found = installedAddons.find((a) => a.manifest.id === channel.streamAddon);
      return found ? { transportUrl: found.transportUrl } : null;
    },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {}
  });

  const record = await actions.addChannel({
    addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', streamAddon: 'org.torrentio'
  });

  assert.equal(record.streamAddon, 'org.torrentio');
  assert.equal(channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
});

test('addChannel sets streamSource: null when streamAddon is omitted', async () => {
  const channels = [];
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: () => { throw new Error('should not be called'); },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {}
  });

  const record = await actions.addChannel({
    addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en'
  });

  assert.equal(record.streamAddon, undefined);
  assert.equal(channels[0].streamSource, null);
});

test('updateChannel re-resolves streamSource when streamAddon is patched on an already-enabled channel', async () => {
  const channels = [{ id: 'x', addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', enabled: true, source: { transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }, streamSource: null }];
  let regeneratedId = null;
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([{ manifest: { id: 'org.torrentio' }, transportUrl: 'https://torrentio/manifest.json' }]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel, installedAddons) => {
      const found = installedAddons.find((a) => a.manifest.id === channel.streamAddon);
      return found ? { transportUrl: found.transportUrl } : null;
    },
    regenerateImpl: async (ch) => { regeneratedId = ch.id; },
    readChannelsImpl: async () => ([{ id: 'x', addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en', enabled: true }]),
    writeChannelsImpl: async () => {}
  });

  await actions.updateChannel('x', { streamAddon: 'org.torrentio' });

  assert.equal(channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
  assert.equal(regeneratedId, 'x');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/channelActions.test.js`
Expected: FAIL — `resolveStreamSourceImpl` is never called (no such wiring yet), so `channels[0].streamSource` is `undefined`, not the expected value.

- [ ] **Step 3: Implement the change**

In `src/channelActions.js`, update `createChannelActions`'s params (line 6-14):

```js
export function createChannelActions({
  dataDir,
  channels,
  discoverInstalledAddons,
  resolveSourceImpl,
  resolveStreamSourceImpl,
  regenerateImpl,
  readChannelsImpl = readChannels,
  writeChannelsImpl = writeChannels
}) {
```

Update `addChannel` (was lines 38-65):

```js
  async function addChannel({ addon, catalog, name, mode, minQuality, language, streamAddon }) {
    try {
      validateNewChannelFields({ mode, minQuality, language });
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const persisted = await readChannelsImpl(dataDir);
    const id = channelId(addon, catalog);
    if (persisted.some((ch) => ch.id === id)) {
      throw new ValidationError(`Channel for addon "${addon}" / catalog "${catalog}" already exists`);
    }

    const installedAddons = await discoverInstalledAddons();
    const source = resolveSourceImpl({ addon, catalog, name }, installedAddons);
    if (!source) {
      throw new ValidationError(`Could not resolve addon "${addon}" / catalog "${catalog}" from your installed Stremio addons`);
    }
    const streamSource = streamAddon ? resolveStreamSourceImpl({ streamAddon, name }, installedAddons) : null;

    const record = { id, addon, catalog, name, mode, minQuality, language, enabled: true, ...(streamAddon ? { streamAddon } : {}) };
    await writeChannelsImpl(dataDir, [...persisted, record]);

    const liveChannel = { ...record, source, streamSource };
    channels.push(liveChannel);
    await regenerateImpl(liveChannel);

    return record;
  }
```

Update `updateChannel` (was lines 67-112) — add `'streamAddon'` to the allowed-patch keys, and re-resolve `streamSource` whenever `streamAddon` is part of the patch (both the re-add and in-place-edit branches):

```js
  async function updateChannel(id, patch) {
    const allowedPatch = {};
    for (const key of ['mode', 'minQuality', 'language', 'enabled', 'streamAddon']) {
      if (key in patch) allowedPatch[key] = patch[key];
    }

    try {
      validatePatchFields(allowedPatch);
      if (allowedPatch.enabled !== undefined && typeof allowedPatch.enabled !== 'boolean') {
        throw new Error(`Invalid enabled "${allowedPatch.enabled}" (must be a boolean)`);
      }
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const persisted = await readChannelsImpl(dataDir);
    const index = persisted.findIndex((ch) => ch.id === id);
    if (index === -1) {
      throw new NotFoundError(`No channel with id "${id}"`);
    }

    const updated = { ...persisted[index], ...allowedPatch };
    const nextPersisted = [...persisted];
    nextPersisted[index] = updated;
    await writeChannelsImpl(dataDir, nextPersisted);

    const liveIndex = channels.findIndex((ch) => ch.id === id);

    if (updated.enabled === false) {
      if (liveIndex !== -1) channels.splice(liveIndex, 1);
      return updated;
    }

    if (liveIndex === -1) {
      const installedAddons = await discoverInstalledAddons();
      const source = resolveSourceImpl(updated, installedAddons);
      const streamSource = updated.streamAddon ? resolveStreamSourceImpl(updated, installedAddons) : null;
      const liveChannel = { ...updated, source, streamSource };
      channels.push(liveChannel);
      await regenerateImpl(liveChannel);
    } else {
      Object.assign(channels[liveIndex], updated);
      if ('streamAddon' in allowedPatch) {
        const installedAddons = await discoverInstalledAddons();
        channels[liveIndex].streamSource = updated.streamAddon ? resolveStreamSourceImpl(updated, installedAddons) : null;
      }
      await regenerateImpl(channels[liveIndex]);
    }

    return updated;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/channelActions.test.js`
Expected: all tests PASS, including pre-existing ones (they never pass `streamAddon`, so `resolveStreamSourceImpl` is only invoked when a test actually sets it — the "should not be called" test in Step 1 catches any regression there).

- [ ] **Step 5: Commit**

```bash
git add src/channelActions.js test/channelActions.test.js
git commit -m "Accept and resolve an optional streamAddon on channel add/update"
```

---

### Task 5: `app.js` — Real-Debrid resolution in the `/stream/:channelId` handler

**Files:**
- Modify: `src/server/app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `checkInstantAvailability`, `resolveStream`, `parseSeasonEpisode` from `src/realDebrid.js` (Task 2); `selectStream` from `src/streamSelect.js` (Task 1, already returns `infoHash`-carrying candidates).
- Produces: `createApp({..., realDebridApiKey, checkInstantAvailabilityImpl?, resolveStreamImpl?})` — new optional params, injectable for tests exactly like `fetchStreamsImpl`/`streamViaFfmpegImpl` already are.

- [ ] **Step 1: Write the failing tests**

Add to `test/app.test.js` (the `withApp` helper already forwards arbitrary options to `createApp`, so it needs one small extension first — see Step 1a):

**Step 1a** — extend `withApp` in `test/app.test.js` to also forward `realDebridApiKey`, `checkInstantAvailabilityImpl`, `resolveStreamImpl`:

```js
async function withApp(t, { channels, schedules = {}, corruptSchedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl, channelActions, realDebridApiKey, checkInstantAvailabilityImpl, resolveStreamImpl } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  for (const [channelId, schedule] of Object.entries(schedules)) {
    await writeSchedule(dataDir, channelId, schedule);
  }
  for (const [channelId, rawContent] of Object.entries(corruptSchedules)) {
    const filePath = schedulePath(dataDir, channelId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, rawContent);
  }
  const app = createApp({
    channels,
    dataDir,
    baseUrl: 'http://localhost:0',
    fetchStreamsImpl,
    streamViaFfmpegImpl,
    nowImpl,
    channelActions,
    realDebridApiKey,
    checkInstantAvailabilityImpl,
    resolveStreamImpl
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return `http://localhost:${port}`;
}
```

**Step 1b** — add new tests after the existing `GET /stream/:channelId resolves the current item...` test:

```js
test('GET /stream/:channelId resolves an RD-cached magnet candidate and proxies the resolved link', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  let capturedArgs = null;
  let checkedHashes = null;
  let resolvedArgs = null;
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://torrentio/manifest.json' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', infoHash: 'abc123' }],
    checkInstantAvailabilityImpl: async (apiKey, hashes) => { checkedHashes = hashes; return new Set(['abc123']); },
    resolveStreamImpl: async (apiKey, infoHash, opts) => { resolvedArgs = { apiKey, infoHash, opts }; return 'https://direct/play.mkv'; },
    streamViaFfmpegImpl: async (args) => { capturedArgs = args; args.res.end(); },
    nowImpl: () => now,
    realDebridApiKey: 'rd-key'
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 200);
  assert.deepEqual(checkedHashes, ['abc123']);
  assert.deepEqual(resolvedArgs, { apiKey: 'rd-key', infoHash: 'abc123', opts: { season: undefined, episode: undefined } });
  assert.equal(capturedArgs.sourceUrl, 'https://direct/play.mkv');
});

test('GET /stream/:channelId falls back to channel.source for stream fetch when streamSource is absent', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  let requestedUrl = null;
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async (transportUrl) => { requestedUrl = transportUrl; return [{ title: '1080p 👤 20', url: 'http://good' }]; },
    streamViaFfmpegImpl: async (args) => { args.res.end(); },
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 200);
  assert.equal(requestedUrl, 'https://addon/manifest.json');
});

test('GET /stream/:channelId 502s a magnet-only candidate that is not RD-cached, ignoring it entirely', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://torrentio/manifest.json' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', infoHash: 'not-cached' }],
    checkInstantAvailabilityImpl: async () => new Set(),
    nowImpl: () => now,
    realDebridApiKey: 'rd-key'
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
});

test('GET /stream/:channelId ignores magnet candidates entirely when no REALDEBRID_API_KEY is configured', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  let checkCalled = false;
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://torrentio/manifest.json' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', infoHash: 'abc123' }],
    checkInstantAvailabilityImpl: async () => { checkCalled = true; return new Set(['abc123']); },
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
  assert.equal(checkCalled, false);
});

test('GET /stream/:channelId 502s (not 500) when Real-Debrid resolution fails on the selected candidate', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://torrentio/manifest.json' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', infoHash: 'abc123' }],
    checkInstantAvailabilityImpl: async () => new Set(['abc123']),
    resolveStreamImpl: async () => { throw new Error('RD outage'); },
    nowImpl: () => now,
    realDebridApiKey: 'rd-key'
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/app.test.js`
Expected: FAIL — `createApp` doesn't yet accept/use `realDebridApiKey`/`checkInstantAvailabilityImpl`/`resolveStreamImpl`, magnet candidates are silently dropped by the current `selectStream` filter path (before Task 1's fix they'd already be dropped; after Task 1 they survive selection but `app.js` has no resolution step yet), so all the new assertions fail or the request never reaches 200/502 as expected.

- [ ] **Step 3: Implement the change**

In `src/server/app.js`, add the import (after line 8):

```js
import { checkInstantAvailability, resolveStream, parseSeasonEpisode } from '../realDebrid.js';
```

Update `createApp`'s params (lines 15-23):

```js
export function createApp({
  channels,
  dataDir,
  baseUrl,
  channelActions,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  realDebridApiKey = null,
  nowImpl = () => new Date()
}) {
```

Replace the body of the `/stream/:channelId` handler from the offset calculation onward (was lines 72-80):

```js
      const offsetSeconds = (now - new Date(item.start).getTime()) / 1000;
      const streamSource = channel.streamSource || channel.source;
      const streams = await fetchStreamsImpl(streamSource.transportUrl, channel.source.type, item.id);

      const direct = streams.filter((s) => !!s.url);
      let magnetCandidates = streams.filter((s) => !!s.infoHash && !s.url);

      if (magnetCandidates.length && realDebridApiKey) {
        const cached = await checkInstantAvailabilityImpl(realDebridApiKey, magnetCandidates.map((s) => s.infoHash));
        magnetCandidates = magnetCandidates.filter((s) => cached.has(s.infoHash));
      } else {
        magnetCandidates = [];
      }

      const selected = selectStream([...direct, ...magnetCandidates], { minQuality: channel.minQuality, language: channel.language });
      if (!selected) {
        res.status(502).end('No playable stream found');
        return;
      }

      let finalUrl = selected.url;
      if (!finalUrl && selected.infoHash) {
        const { season, episode } = parseSeasonEpisode(item.id);
        try {
          finalUrl = await resolveStreamImpl(realDebridApiKey, selected.infoHash, { season, episode });
        } catch (err) {
          console.error(`Real-Debrid resolution failed: ${err.message}`);
          res.status(502).end('No playable stream found');
          return;
        }
      }

      await streamViaFfmpegImpl({ sourceUrl: finalUrl, offsetSeconds, res });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/app.test.js`
Expected: all tests PASS, including every pre-existing test (they never set `streamSource`, so `channel.streamSource || channel.source` falls back exactly as before; they never produce `infoHash`-only candidates, so `magnetCandidates` is always empty and behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/server/app.js test/app.test.js
git commit -m "Resolve RD-cached magnet candidates to direct URLs in /stream/:channelId"
```

---

### Task 6: Admin UI — enter a channel's stream addon

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `POST /admin/channels` / `PATCH /admin/channels/:id` (existing, now accepting the `streamAddon` field per Task 4 — no route code changes needed since `adminRoutes.js` forwards `req.body` as-is).
- Produces: nothing consumed by later tasks — this is the UI leaf.

- [ ] **Step 1: Add a "Stream addon" column to the channels table**

In `public/index.html`, update the table header (line 47):

```html
<tr><th>Name</th><th>Mode</th><th>Min quality</th><th>Language</th><th>Stream addon</th><th>Enabled</th></tr>
```

- [ ] **Step 2: Render and wire the stream-addon field in the channels table**

In `public/admin.js`, update `loadChannels`'s row template (lines 59-67):

```js
  body.innerHTML = channels.map((ch) => `
    <tr data-id="${ch.id}">
      <td>${escapeHtml(ch.name)}</td>
      <td>${selectHtml('mode', MODES, ch.mode)}</td>
      <td>${selectHtml('minQuality', QUALITIES, ch.minQuality)}</td>
      <td>${selectHtml('language', LANGUAGES, ch.language)}</td>
      <td><input type="text" data-field="streamAddon" value="${escapeHtml(ch.streamAddon || '')}" placeholder="org.stremio.torrentio.addon"></td>
      <td><input type="checkbox" data-field="enabled" ${ch.enabled ? 'checked' : ''}></td>
    </tr>
  `).join('');
```

And extend the change-listener selector (line 69) to also cover text inputs:

```js
  body.querySelectorAll('select, input[type=checkbox], input[type=text]').forEach((el) => {
```

(The existing handler body already reads `e.target.dataset.field`/`e.target.value` generically — no further change needed there.)

- [ ] **Step 3: Add the stream-addon input to the "add channel" form**

In `public/admin.js`, update `catalogRowHtml`'s form template (lines 100-110):

```js
    <tr class="add-form-row">
      <td colspan="3">
        <div class="add-form" id="form-${key}">
          <input type="text" data-field="name" placeholder="Channel name" value="${escapeHtml(cat.catalogName)}">
          ${selectHtml('mode', MODES, 'random-start')}
          ${selectHtml('minQuality', QUALITIES, '720p')}
          ${selectHtml('language', LANGUAGES, 'en')}
          <input type="text" data-field="streamAddon" placeholder="Stream addon ID (optional, e.g. org.stremio.torrentio.addon)">
          <button data-action="submit">Save</button>
        </div>
      </td>
    </tr>
```

Update the submit handler (lines 144-166) to read and send it:

```js
  container.querySelectorAll('button[data-action="submit"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const formDiv = e.target.closest('.add-form');
      const row = formDiv.closest('tr').previousElementSibling;
      const addon = row.dataset.addon;
      const catalog = row.dataset.catalog;
      const name = formDiv.querySelector('[data-field="name"]').value;
      const mode = formDiv.querySelector('[data-field="mode"]').value;
      const minQuality = formDiv.querySelector('[data-field="minQuality"]').value;
      const language = formDiv.querySelector('[data-field="language"]').value;
      const streamAddon = formDiv.querySelector('[data-field="streamAddon"]').value.trim() || undefined;
      try {
        await fetchJson('/admin/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addon, catalog, name, mode, minQuality, language, streamAddon })
        });
        hideBanner();
        await loadAll();
      } catch (err) {
        showBanner(err.message);
      }
    });
  });
```

- [ ] **Step 4: Manual verification**

Per this project's existing testing approach (the admin UI is manually verified, not covered by browser tests): run `npm start` with `DATA_DIR` pointed at a scratch directory and valid `STREMIO_EMAIL`/`STREMIO_PASSWORD`/`REALDEBRID_API_KEY` env vars, open `http://localhost:8080/`, add a channel while entering a stream addon id (e.g. `org.stremio.torrentio.addon`), confirm the "My channels" table shows it in the new column, and edit it inline to confirm the `PATCH` round-trips (check `/admin/channels` response reflects the change).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/admin.js
git commit -m "Add stream-addon field to the admin UI's add-channel form and channels table"
```

---

### Task 7: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions in `bootstrap.test.js`, `channelActions.test.js`, `app.test.js`, or `streamSelect.test.js` from the changes in Tasks 1-5.

- [ ] **Step 2: Confirm `REALDEBRID_API_KEY` documentation**

Check whether this project has a README or `docker-compose`/`.env.example` documenting required env vars (`STREMIO_EMAIL`, `STREMIO_PASSWORD`, etc. — search for them via `grep -rl STREMIO_EMAIL .` outside `node_modules`). If such a file exists, add `REALDEBRID_API_KEY` to it with a one-line description, matching the existing entries' format exactly. If no such file exists, skip this step (nothing to update).

- [ ] **Step 3: Commit (only if Step 2 found and updated a file)**

```bash
git add <the file(s) updated in Step 2>
git commit -m "Document REALDEBRID_API_KEY alongside the other required env vars"
```
