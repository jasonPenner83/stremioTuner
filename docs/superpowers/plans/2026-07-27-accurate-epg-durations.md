# Accurate EPG Durations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve accurate EPG durations for catalog items whose addon `meta` lacks `runtime`, via a fallback chain (meta → Cinemeta → ffprobe file probe → flat default), with successful resolutions cached to disk so the expensive steps run at most once per item.

**Architecture:** Three small new modules (`cinemetaClient.js`, `durationProbe.js`, `durationCacheStore.js`) plus one extraction (`resolvePlayableUrl.js`, pulled out of `src/server/app.js`'s inline stream-resolution logic so `generateChannelSchedule` can reuse it). `generateChannelSchedule` gains the fallback chain and an injectable `durationCache` object it reads from and mutates; `bootstrap.js` reads/writes that cache to `data/runtimeCache.json` around each channel's regeneration.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`, `node:child_process`), no new npm dependencies. `ffprobe` ships alongside the `ffmpeg` apt package already installed in the Docker image (used today by `src/server/ffmpegProxy.js`).

## Global Constraints

- No change to the Real-Debrid-specific size/placeholder checks — only additive reuse of existing resolution logic.
- No parallel/concurrent probing — probing stays sequential within `generateChannelSchedule`'s existing per-item loop.
- No negative caching — an item that falls through to the flat default is never written to the duration cache, so it's retried on the next regeneration.
- No change to `/stream/:channelId`'s externally observable behavior (status codes, response body, headers) — the resolution logic it uses is extracted, not altered.
- No UI changes.
- Bounded timeouts on every new network/subprocess call (Cinemeta fetch, `ffprobe` spawn) so a slow endpoint or stream can't hang schedule regeneration.

---

### Task 1: Extract `parseRuntimeMs` into its own module

**Files:**
- Create: `src/runtimeParse.js`
- Modify: `src/generateSchedule.js:1-9`
- Test: `test/runtimeParse.test.js`

**Interfaces:**
- Produces: `parseRuntimeMs(runtime: string | null | undefined): number | null` — parses a Stremio-style runtime string (e.g. `"148 min"`) into milliseconds, or `null` if unparseable/empty.

This is a pure extraction (no behavior change) so both `generateSchedule.js` and the new `cinemetaClient.js` (Task 2) can reuse the same parser without a circular import between them.

- [ ] **Step 1: Write the failing test**

Create `test/runtimeParse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeMs } from '../src/runtimeParse.js';

test('parseRuntimeMs converts a "N min" string to milliseconds', () => {
  assert.equal(parseRuntimeMs('148 min'), 148 * 60 * 1000);
});

test('parseRuntimeMs extracts the leading number from other formats', () => {
  assert.equal(parseRuntimeMs('90'), 90 * 60 * 1000);
});

test('parseRuntimeMs returns null for empty/nullish input', () => {
  assert.equal(parseRuntimeMs(null), null);
  assert.equal(parseRuntimeMs(undefined), null);
  assert.equal(parseRuntimeMs(''), null);
});

test('parseRuntimeMs returns null when no digits are present', () => {
  assert.equal(parseRuntimeMs('unknown'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtimeParse.test.js`
Expected: FAIL — `Cannot find module '../src/runtimeParse.js'`

- [ ] **Step 3: Create `src/runtimeParse.js`**

```js
export function parseRuntimeMs(runtime) {
  if (!runtime) return null;
  const match = String(runtime).match(/(\d+)/);
  if (!match) return null;
  return Number(match[1]) * 60 * 1000;
}
```

- [ ] **Step 4: Update `src/generateSchedule.js` to import instead of define**

Replace lines 1-9 (the local `parseRuntimeMs` definition) with an import:

```js
import * as addonClient from './addonClient.js';
import { buildRandomStartLineup, buildRandomLineup } from './lineup.js';
import { parseRuntimeMs } from './runtimeParse.js';
```

(Delete the old `function parseRuntimeMs(runtime) { ... }` block entirely — it now lives in `src/runtimeParse.js`.)

- [ ] **Step 5: Run both test files to verify everything passes**

Run: `node --test test/runtimeParse.test.js test/generateSchedule.test.js`
Expected: PASS (all tests, including the existing `generateSchedule.test.js` suite, which exercises `parseRuntimeMs` indirectly)

- [ ] **Step 6: Commit**

```bash
git add src/runtimeParse.js src/generateSchedule.js test/runtimeParse.test.js
git commit -m "Extract parseRuntimeMs into its own module to avoid a future circular import"
```

---

### Task 2: Add Cinemeta duration lookup

**Files:**
- Create: `src/cinemetaClient.js`
- Test: `test/cinemetaClient.test.js`

**Interfaces:**
- Consumes: `parseRuntimeMs` from `src/runtimeParse.js` (Task 1).
- Produces: `fetchCinemetaRuntimeMs(type: string, id: string, opts?: { fetchImpl?, timeoutMs? }): Promise<number | null>` — returns milliseconds or `null` on any failure (never throws). `isImdbId(id: string): boolean` — exported for reuse/testability.

- [ ] **Step 1: Write the failing tests**

Create `test/cinemetaClient.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImdbId, fetchCinemetaRuntimeMs } from '../src/cinemetaClient.js';

test('isImdbId matches tt-prefixed ids', () => {
  assert.equal(isImdbId('tt1234567'), true);
  assert.equal(isImdbId('tt1234567:1:2'), true);
});

test('isImdbId rejects non-tt ids', () => {
  assert.equal(isImdbId('some-addon-id-42'), false);
});

test('fetchCinemetaRuntimeMs returns null without fetching for a non-IMDb id', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const result = await fetchCinemetaRuntimeMs('movie', 'custom-id', { fetchImpl });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('fetchCinemetaRuntimeMs parses runtime from a successful response', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://v3-cinemeta.strem.io/meta/movie/tt1234567.json');
    return { ok: true, json: async () => ({ meta: { runtime: '120 min' } }) };
  };
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, 120 * 60 * 1000);
});

test('fetchCinemetaRuntimeMs returns null on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false });
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, null);
});

test('fetchCinemetaRuntimeMs returns null when meta has no runtime', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ meta: {} }) });
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, null);
});

test('fetchCinemetaRuntimeMs returns null on a network error', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cinemetaClient.test.js`
Expected: FAIL — `Cannot find module '../src/cinemetaClient.js'`

- [ ] **Step 3: Create `src/cinemetaClient.js`**

```js
import { parseRuntimeMs } from './runtimeParse.js';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

export function isImdbId(id) {
  return /^tt\d+/.test(String(id));
}

export async function fetchCinemetaRuntimeMs(type, id, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!isImdbId(id)) return null;
  try {
    const res = await fetchImpl(`${CINEMETA_BASE}/meta/${type}/${id}.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return parseRuntimeMs(data?.meta?.runtime);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cinemetaClient.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cinemetaClient.js test/cinemetaClient.test.js
git commit -m "Add fetchCinemetaRuntimeMs: fallback duration lookup for IMDb-identified items"
```

---

### Task 3: Add ffprobe-based duration probe

**Files:**
- Create: `src/durationProbe.js`
- Test: `test/durationProbe.test.js`

**Interfaces:**
- Produces: `probeDurationMs(url: string, opts?: { spawnImpl?, ffprobePath?, timeoutMs? }): Promise<number | null>` — returns milliseconds parsed from `ffprobe`'s output, or `null` on any failure/timeout (never throws).

- [ ] **Step 1: Write the failing tests**

Create `test/durationProbe.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { probeDurationMs } from '../src/durationProbe.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = function kill(signal) {
    child.killed = true;
    child.killSignal = signal;
  };
  return child;
}

test('probeDurationMs parses seconds from ffprobe stdout into milliseconds', async () => {
  const child = fakeChild();
  let capturedArgs = null;
  const spawnImpl = (cmd, args) => { capturedArgs = args; return child; };

  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.stdout.write('5410.123000\n');
  child.emit('exit', 0);

  const result = await promise;
  assert.equal(result, 5410123);
  assert.deepEqual(capturedArgs, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'http://example/video.mkv']);
});

test('probeDurationMs returns null on a non-zero exit code', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.emit('exit', 1);
  assert.equal(await promise, null);
});

test('probeDurationMs returns null on unparseable stdout', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.stdout.write('N/A\n');
  child.emit('exit', 0);
  assert.equal(await promise, null);
});

test('probeDurationMs returns null and kills the child on a spawn error', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.emit('error', new Error('ENOENT'));
  assert.equal(await promise, null);
});

test('probeDurationMs times out, kills the child, and resolves null', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl, timeoutMs: 20 });
  const result = await promise;
  assert.equal(result, null);
  assert.equal(child.killed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/durationProbe.test.js`
Expected: FAIL — `Cannot find module '../src/durationProbe.js'`

- [ ] **Step 3: Create `src/durationProbe.js`**

```js
import { spawn } from 'node:child_process';

export function probeDurationMs(url, { spawnImpl = spawn, ffprobePath = 'ffprobe', timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url]);
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        resolve(null);
        return;
      }
      resolve(Math.round(seconds * 1000));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/durationProbe.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/durationProbe.js test/durationProbe.test.js
git commit -m "Add probeDurationMs: read real duration from a stream via ffprobe"
```

---

### Task 4: Add persistent duration cache store

**Files:**
- Create: `src/durationCacheStore.js`
- Test: `test/durationCacheStore.test.js`

**Interfaces:**
- Produces: `durationCachePath(dataDir: string): string`, `readDurationCache(dataDir: string, opts?: { fs? }): Promise<object>` (returns `{}` if the file doesn't exist), `writeDurationCache(dataDir: string, cache: object, opts?: { fs? }): Promise<void>`.

This follows the exact same shape as `src/scheduleStore.js` and `src/channelStore.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/durationCacheStore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { durationCachePath, readDurationCache, writeDurationCache } from '../src/durationCacheStore.js';

test('durationCachePath builds a path under dataDir', () => {
  assert.equal(durationCachePath('/data'), path.join('/data', 'runtimeCache.json'));
});

test('readDurationCache returns an empty object when no file exists', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cache = await readDurationCache(dataDir);
  assert.deepEqual(cache, {});
});

test('writeDurationCache then readDurationCache round-trips the data', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cache = { tt1: { ms: 5400000, source: 'meta', resolvedAt: '2026-07-27T00:00:00.000Z' } };
  await writeDurationCache(dataDir, cache);
  const readBack = await readDurationCache(dataDir);
  assert.deepEqual(readBack, cache);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/durationCacheStore.test.js`
Expected: FAIL — `Cannot find module '../src/durationCacheStore.js'`

- [ ] **Step 3: Create `src/durationCacheStore.js`**

```js
import path from 'node:path';
import fsPromises from 'node:fs/promises';

export function durationCachePath(dataDir) {
  return path.join(dataDir, 'runtimeCache.json');
}

export async function readDurationCache(dataDir, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(durationCachePath(dataDir), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeDurationCache(dataDir, cache, { fs = fsPromises } = {}) {
  const filePath = durationCachePath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/durationCacheStore.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/durationCacheStore.js test/durationCacheStore.test.js
git commit -m "Add durationCacheStore: persist resolved item durations to data/runtimeCache.json"
```

---

### Task 5: Extract `resolvePlayableUrl` out of `app.js`

**Files:**
- Create: `src/resolvePlayableUrl.js`
- Test: `test/resolvePlayableUrl.test.js`
- Modify: `src/server/app.js:1-12` (imports), `src/server/app.js:17-30` (`createApp` params), `src/server/app.js:80-125` (route body)

**Interfaces:**
- Produces: `resolvePlayableUrl(opts: { item, type, channel, streamSource, realDebridApiKey, fetchStreamsImpl?, checkInstantAvailabilityImpl?, resolveStreamImpl?, isLikelyPlayableSizeImpl? }): Promise<string | null>` — returns the first playable URL from ranked candidates, or `null` if none work. Never throws for "no candidate worked"; may still throw if `fetchStreamsImpl` itself throws (matches today's behavior, where the whole route handler is wrapped in try/catch).
- Consumes (unchanged, just re-imported into the new module): `rankStreams` from `src/streamSelect.js`, `fetchStreams` from `src/addonClient.js`, `checkInstantAvailability`/`resolveStream`/`parseSeasonEpisode` from `src/realDebrid.js`, `isLikelyPlayableSize` from `src/streamSizeCheck.js`.

This is a pure extraction — the exact same logic currently inlined in `/stream/:channelId`, moved into its own testable function. `app.js`'s route behavior (status codes, response bodies, injectable params in `createApp`) does not change, so the existing `test/app.test.js` suite must pass unmodified after this task.

- [ ] **Step 1: Write the failing tests for the extracted function**

Create `test/resolvePlayableUrl.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolvePlayableUrl.test.js`
Expected: FAIL — `Cannot find module '../src/resolvePlayableUrl.js'`

- [ ] **Step 3: Create `src/resolvePlayableUrl.js`**

```js
import { rankStreams } from './streamSelect.js';
import { fetchStreams } from './addonClient.js';
import { checkInstantAvailability, resolveStream, parseSeasonEpisode } from './realDebrid.js';
import { isLikelyPlayableSize } from './streamSizeCheck.js';

export async function resolvePlayableUrl({
  item,
  type,
  channel,
  streamSource,
  realDebridApiKey,
  fetchStreamsImpl = fetchStreams,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  isLikelyPlayableSizeImpl = isLikelyPlayableSize
}) {
  const streams = await fetchStreamsImpl(streamSource.transportUrl, type, item.id);

  const direct = streams.filter((s) => !!s.url);
  let magnetCandidates = streams.filter((s) => !!s.infoHash && !s.url);

  if (magnetCandidates.length && realDebridApiKey) {
    try {
      const cached = await checkInstantAvailabilityImpl(realDebridApiKey, magnetCandidates.map((s) => s.infoHash));
      magnetCandidates = magnetCandidates.filter((s) => cached.has(s.infoHash));
    } catch (err) {
      console.error(`Real-Debrid availability check failed: ${err.message}`);
      magnetCandidates = [];
    }
  } else {
    magnetCandidates = [];
  }

  const candidates = rankStreams([...direct, ...magnetCandidates], { minQuality: channel.minQuality, language: channel.language });

  for (const candidate of candidates) {
    if (candidate.url) {
      const playable = await isLikelyPlayableSizeImpl(candidate.url);
      if (playable) return candidate.url;
      console.error(`Direct URL failed size check (likely a takedown placeholder), trying next candidate: ${candidate.url}`);
      continue;
    }
    const { season, episode } = parseSeasonEpisode(item.id);
    try {
      return await resolveStreamImpl(realDebridApiKey, candidate.infoHash, { season, episode });
    } catch (err) {
      console.error(`Real-Debrid resolution failed for a candidate, trying next: ${err.message}`);
    }
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolvePlayableUrl.test.js`
Expected: PASS

- [ ] **Step 5: Update `src/server/app.js` to use the extracted function**

Replace the import block at the top (lines 1-12):

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildM3u } from '../m3u.js';
import { buildXmltv } from '../xmltv.js';
import { readSchedule } from '../scheduleStore.js';
import { fetchStreams } from '../addonClient.js';
import { streamViaFfmpeg } from './ffmpegProxy.js';
import { createAdminRouter } from './adminRoutes.js';
import { checkInstantAvailability, resolveStream } from '../realDebrid.js';
import { isLikelyPlayableSize } from '../streamSizeCheck.js';
import { resolvePlayableUrl } from '../resolvePlayableUrl.js';
```

Replace the `createApp` parameter list (lines 17-30) — keep every existing injectable param (so `test/app.test.js` keeps working unmodified) and add `resolvePlayableUrlImpl`:

```js
export function createApp({
  channels,
  dataDir,
  baseUrl,
  channelActions,
  settingsActions,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  isLikelyPlayableSizeImpl = isLikelyPlayableSize,
  resolvePlayableUrlImpl = resolvePlayableUrl,
  realDebridApiKey = null,
  nowImpl = () => new Date()
}) {
```

Replace the body of the `/stream/:channelId` handler from the `offsetSeconds` line through the `streamViaFfmpegImpl` call (originally lines 79-125) with:

```js
      const offsetSeconds = (now - new Date(item.start).getTime()) / 1000;
      const streamSource = channel.streamSource || channel.source;
      const finalUrl = await resolvePlayableUrlImpl({
        item,
        type: channel.source.type,
        channel,
        streamSource,
        realDebridApiKey,
        fetchStreamsImpl,
        checkInstantAvailabilityImpl,
        resolveStreamImpl,
        isLikelyPlayableSizeImpl
      });

      if (!finalUrl) {
        res.status(502).end('No playable stream found');
        return;
      }

      await streamViaFfmpegImpl({ sourceUrl: finalUrl, offsetSeconds, res });
```

- [ ] **Step 6: Run the full existing app test suite to confirm no regression**

Run: `node --test test/app.test.js`
Expected: PASS — every existing test in this file (candidate ranking, RD resolution, size-check fallback, 502/500 handling) passes unmodified, since `app.js`'s externally observable behavior hasn't changed.

- [ ] **Step 7: Run the full test suite as a final sanity check**

Run: `npm test`
Expected: PASS (all files, including Tasks 1-4's new tests and the pre-existing suite)

- [ ] **Step 8: Commit**

```bash
git add src/resolvePlayableUrl.js src/server/app.js test/resolvePlayableUrl.test.js
git commit -m "Extract resolvePlayableUrl from app.js so schedule generation can reuse it"
```

---

### Task 6: Wire the fallback chain into `generateChannelSchedule`

**Files:**
- Modify: `src/generateSchedule.js` (imports, `getRuntimeMs`, `generateChannelSchedule` signature)
- Test: `test/generateSchedule.test.js` (extend)

**Interfaces:**
- Consumes: `resolvePlayableUrl` (Task 5), `probeDurationMs` (Task 3), `fetchCinemetaRuntimeMs` (Task 2), `parseRuntimeMs` (Task 1).
- Produces: `generateChannelSchedule` gains three new options: `realDebridApiKey` (default `null`), `durationCache` (default `{}`, a plain object the function reads from and mutates in place — keyed by item id, values `{ ms, source, resolvedAt }`), and injectable overrides `resolvePlayableUrlImpl`, `probeDurationMsImpl`, `fetchCinemetaRuntimeImpl` (each defaulting to the real implementation). The `channel` object passed in is expected to carry `streamSource`, `minQuality`, and `language` when present — same shape `bootstrap.js` already builds and already passes to this function today, so no new top-level `streamSource` param is needed.

The full fallback chain per item: in-memory cache (existing, this-run-only) → `durationCache` (disk-backed, cross-run) → `meta.runtime` → Cinemeta → ffprobe file probe → flat default (not cached).

- [ ] **Step 1: Write the failing tests**

Add to `test/generateSchedule.test.js` (append after the existing tests):

```js
test('falls back to Cinemeta when meta has no runtime and the id looks like an IMDb id', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  let cinemetaCalledWith = null;
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x', minQuality: '480p', language: 'en' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 60 * 60 * 1000,
    rng: () => 0, // starts at tt1
    fetchCinemetaRuntimeImpl: async (type, id) => { cinemetaCalledWith = { type, id }; return 60 * 60 * 1000; }
  });
  assert.deepEqual(cinemetaCalledWith, { type: 'movie', id: 'tt1' });
  assert.equal(schedule.items[0].end, '2026-07-22T01:00:00.000Z');
});

test('probes the resolved stream via ffprobe when meta and Cinemeta both fail', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  let probedUrl = null;
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x', minQuality: '480p', language: 'en', streamSource: { transportUrl: 'https://stream-addon/manifest.json' } },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 45 * 60 * 1000,
    rng: () => 0,
    realDebridApiKey: 'rd-key',
    fetchCinemetaRuntimeImpl: async () => null,
    resolvePlayableUrlImpl: async () => 'https://direct/file.mkv',
    probeDurationMsImpl: async (url) => { probedUrl = url; return 45 * 60 * 1000; }
  });
  assert.equal(probedUrl, 'https://direct/file.mkv');
  assert.equal(schedule.items[0].end, '2026-07-22T00:45:00.000Z');
});

test('falls back to defaultRuntimeMs without caching when every rung of the chain fails', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  const durationCache = {};
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x', minQuality: '480p', language: 'en' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 90 * 60 * 1000,
    defaultRuntimeMs: 90 * 60 * 1000,
    rng: () => 0,
    durationCache,
    fetchCinemetaRuntimeImpl: async () => null,
    resolvePlayableUrlImpl: async () => null
  });
  assert.equal(schedule.items[0].end, '2026-07-22T01:30:00.000Z');
  assert.deepEqual(durationCache, {});
});

test('a disk-cache hit skips meta, Cinemeta, and probe entirely', async () => {
  let metaCalled = false;
  const addonClientImpl = {
    fetchCatalog: async () => ITEMS,
    fetchMeta: async () => { metaCalled = true; return null; }
  };
  let cinemetaCalled = false;
  let probeCalled = false;
  const durationCache = { tt1: { ms: 30 * 60 * 1000, source: 'probe', resolvedAt: '2026-07-01T00:00:00.000Z' } };
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x', minQuality: '480p', language: 'en' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 30 * 60 * 1000,
    rng: () => 0,
    durationCache,
    fetchCinemetaRuntimeImpl: async () => { cinemetaCalled = true; return null; },
    resolvePlayableUrlImpl: async () => { probeCalled = true; return null; }
  });
  assert.equal(metaCalled, false);
  assert.equal(cinemetaCalled, false);
  assert.equal(probeCalled, false);
  assert.equal(schedule.items[0].end, '2026-07-22T00:30:00.000Z');
});

test('caches a successfully-probed duration to the durationCache object', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  const durationCache = {};
  await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x', minQuality: '480p', language: 'en' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 20 * 60 * 1000,
    rng: () => 0,
    durationCache,
    fetchCinemetaRuntimeImpl: async () => null,
    resolvePlayableUrlImpl: async () => 'https://direct/file.mkv',
    probeDurationMsImpl: async () => 20 * 60 * 1000
  });
  assert.equal(durationCache.tt1.ms, 20 * 60 * 1000);
  assert.equal(durationCache.tt1.source, 'probe');
});

test('a thrown error from probe resolution is caught and falls through to the default', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x', minQuality: '480p', language: 'en' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 90 * 60 * 1000,
    defaultRuntimeMs: 90 * 60 * 1000,
    rng: () => 0,
    fetchCinemetaRuntimeImpl: async () => null,
    resolvePlayableUrlImpl: async () => { throw new Error('addon unreachable'); }
  });
  assert.equal(schedule.items[0].end, '2026-07-22T01:30:00.000Z');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/generateSchedule.test.js`
Expected: FAIL — the new tests fail because `generateChannelSchedule` doesn't yet accept `durationCache`/`fetchCinemetaRuntimeImpl`/`resolvePlayableUrlImpl`/`probeDurationMsImpl`, or perform the fallback chain (assertions on `schedule.items[0].end`, `durationCache`, and the `*Called` flags will fail).

- [ ] **Step 3: Update `src/generateSchedule.js`**

Replace the full file contents with:

```js
import * as addonClient from './addonClient.js';
import { buildRandomStartLineup, buildRandomLineup } from './lineup.js';
import { parseRuntimeMs } from './runtimeParse.js';
import { resolvePlayableUrl } from './resolvePlayableUrl.js';
import { probeDurationMs } from './durationProbe.js';
import { fetchCinemetaRuntimeMs } from './cinemetaClient.js';

function makeEntry(item, startMs, runtimeMs) {
  return {
    id: item.id,
    title: item.name,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + runtimeMs).toISOString(),
    catalogRef: { type: item.type, id: item.id }
  };
}

export async function generateChannelSchedule({
  channel,
  source,
  addonClientImpl = addonClient,
  now = () => new Date(),
  targetWindowMs = 48 * 60 * 60 * 1000,
  defaultRuntimeMs = 90 * 60 * 1000,
  rng = Math.random,
  realDebridApiKey = null,
  durationCache = {},
  resolvePlayableUrlImpl = resolvePlayableUrl,
  probeDurationMsImpl = probeDurationMs,
  fetchCinemetaRuntimeImpl = fetchCinemetaRuntimeMs
}) {
  const items = await addonClientImpl.fetchCatalog(source.transportUrl, source.type, channel.catalog);
  if (!items.length) {
    throw new Error(`Catalog "${channel.catalog}" returned no items`);
  }

  const runtimeCache = new Map();

  async function resolveDurationMs(item) {
    const cached = durationCache[item.id];
    if (cached && cached.ms) return cached.ms;

    const meta = await addonClientImpl.fetchMeta(source.transportUrl, source.type, item.id);
    const metaMs = parseRuntimeMs(meta?.runtime);
    if (metaMs && metaMs > 0) {
      durationCache[item.id] = { ms: metaMs, source: 'meta', resolvedAt: new Date().toISOString() };
      return metaMs;
    }

    const cinemetaMs = await fetchCinemetaRuntimeImpl(source.type, item.id);
    if (cinemetaMs && cinemetaMs > 0) {
      durationCache[item.id] = { ms: cinemetaMs, source: 'cinemeta', resolvedAt: new Date().toISOString() };
      return cinemetaMs;
    }

    const streamSource = channel.streamSource || source;
    try {
      const url = await resolvePlayableUrlImpl({
        item,
        type: source.type,
        channel,
        streamSource,
        realDebridApiKey
      });
      if (url) {
        const probedMs = await probeDurationMsImpl(url);
        if (probedMs && probedMs > 0) {
          durationCache[item.id] = { ms: probedMs, source: 'probe', resolvedAt: new Date().toISOString() };
          return probedMs;
        }
      }
    } catch (err) {
      console.error(`Duration probe failed for item "${item.id}": ${err.message}`);
    }

    return null;
  }

  async function getRuntimeMs(item) {
    if (runtimeCache.has(item.id)) return runtimeCache.get(item.id);
    const resolved = await resolveDurationMs(item);
    const ms = resolved && resolved > 0 ? resolved : defaultRuntimeMs;
    runtimeCache.set(item.id, ms);
    return ms;
  }

  const startTime = now().getTime();
  let cursorTime = startTime;
  const lineupItems = [];

  if (channel.mode === 'random-start') {
    const ordered = buildRandomStartLineup(items, rng);
    let i = 0;
    while (cursorTime - startTime < targetWindowMs) {
      const item = ordered[i % ordered.length];
      const runtimeMs = await getRuntimeMs(item);
      lineupItems.push(makeEntry(item, cursorTime, runtimeMs));
      cursorTime += runtimeMs;
      i += 1;
    }
  } else {
    while (cursorTime - startTime < targetWindowMs) {
      const [item] = buildRandomLineup(items, 1, rng);
      const runtimeMs = await getRuntimeMs(item);
      lineupItems.push(makeEntry(item, cursorTime, runtimeMs));
      cursorTime += runtimeMs;
    }
  }

  return {
    generatedAt: new Date(startTime).toISOString(),
    items: lineupItems
  };
}
```

Note: the in-memory `runtimeCache` (this-run-only, keyed by item id → resolved `ms`, including defaults) is kept exactly as it worked before, so the existing "caches meta lookups so a repeated item is not fetched twice" test keeps passing unmodified. The new `durationCache` (disk-backed, passed in by the caller) is a separate, second layer consulted first and only ever written with non-default resolutions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/generateSchedule.test.js`
Expected: PASS — all pre-existing tests plus the six new ones from Step 1.

- [ ] **Step 5: Commit**

```bash
git add src/generateSchedule.js test/generateSchedule.test.js
git commit -m "Add Cinemeta and ffprobe fallback chain to generateChannelSchedule, with a disk-backed duration cache"
```

---

### Task 7: Wire the duration cache and Real-Debrid key through `bootstrap.js`

**Files:**
- Modify: `src/bootstrap.js` (imports, `regenerate`)
- Test: `test/bootstrap.test.js` (extend)

**Interfaces:**
- Consumes: `readDurationCache`/`writeDurationCache` (Task 4).
- No new exported interfaces — this task only changes what `bootstrap()` passes into `generateChannelScheduleImpl` and adds injectable `readDurationCacheImpl`/`writeDurationCacheImpl` params (defaulting to the real functions), matching the existing convention for every other I/O call in this file.

- [ ] **Step 1: Write the failing test**

Add to `test/bootstrap.test.js` (find the existing `makeChannel` helper and `regenerate`-focused tests near the "regenerate sets channel.lastError" tests, and add near them):

```js
test('regenerate reads the duration cache, passes it and realDebridApiKey to generateChannelScheduleImpl, and writes it back', async () => {
  let capturedArgs = null;
  let readCalledWith = null;
  let writeCalledWith = null;
  const fakeCache = { tt1: { ms: 1234, source: 'meta', resolvedAt: 'x' } };

  const { channelActions } = await bootstrap({
    env: { DATA_DIR: '/tmp/unused', REALDEBRID_API_KEY: 'rd-key' },
    readChannelsImpl: async () => [makeChannel({ id: 'x', addon: 'a', catalog: 'c', enabled: true })],
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth',
    getInstalledAddonsImpl: async () => [{ id: 'a', transportUrl: 'https://a/manifest.json', manifest: { id: 'a', catalogs: [{ id: 'c', type: 'movie' }] } }],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.id === id),
    resolveChannelSourceImpl: () => ({ type: 'movie', catalogId: 'c' }),
    generateChannelScheduleImpl: async (args) => { capturedArgs = args; return { generatedAt: 'new', items: [] }; },
    readScheduleImpl: async () => null,
    writeScheduleImpl: async () => {},
    isScheduleFreshImpl: () => false,
    scheduleDailyAtImpl: () => {},
    createAppImpl: () => ({ listen: () => ({ address: () => ({ port: 0 }) }) }),
    readDurationCacheImpl: async (dataDir) => { readCalledWith = dataDir; return fakeCache; },
    writeDurationCacheImpl: async (dataDir, cache) => { writeCalledWith = { dataDir, cache }; }
  });

  assert.equal(readCalledWith, '/tmp/unused');
  assert.equal(capturedArgs.realDebridApiKey, 'rd-key');
  assert.equal(capturedArgs.durationCache, fakeCache);
  assert.deepEqual(writeCalledWith, { dataDir: '/tmp/unused', cache: fakeCache });
});
```

(If `makeChannel`/`bootstrap` aren't already imported at the top of `test/bootstrap.test.js`, check the existing imports at the top of the file and reuse them — don't re-declare.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bootstrap.test.js`
Expected: FAIL — `capturedArgs.realDebridApiKey`/`capturedArgs.durationCache` are `undefined`, and `readCalledWith`/`writeCalledWith` are `null` since `bootstrap.js` doesn't call the injected duration-cache functions yet.

- [ ] **Step 3: Update `src/bootstrap.js`**

Add the import near the top, alongside the other store imports:

```js
import { readDurationCache, writeDurationCache } from './durationCacheStore.js';
```

Add `readDurationCacheImpl`/`writeDurationCacheImpl` to the `bootstrap()` destructured parameters (alongside `readScheduleImpl`/`writeScheduleImpl`):

```js
  readScheduleImpl = readSchedule,
  writeScheduleImpl = writeSchedule,
  readDurationCacheImpl = readDurationCache,
  writeDurationCacheImpl = writeDurationCache,
```

Update the `regenerate` function:

```js
  async function regenerate(channel) {
    if (!channel.source) {
      channel.lastError = 'No resolved addon source';
      console.error(`Skipping schedule regeneration for "${channel.name}": no resolved addon source`);
      return;
    }
    try {
      const durationCache = await readDurationCacheImpl(dataDir);
      const schedule = await generateChannelScheduleImpl({ channel, source: channel.source, realDebridApiKey, durationCache });
      await writeDurationCacheImpl(dataDir, durationCache);
      await writeScheduleImpl(dataDir, channel.id, schedule);
      channel.lastError = null;
    } catch (err) {
      channel.lastError = err.message;
      console.error(`Schedule generation failed for "${channel.name}": ${err.message}`);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bootstrap.test.js`
Expected: PASS — the new test, plus every pre-existing `bootstrap.test.js` test (they all pass `generateChannelScheduleImpl` fakes that ignore extra fields, so they're unaffected by the additions).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — every test file in `test/`, confirming no regressions across the whole feature.

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap.js test/bootstrap.test.js
git commit -m "Wire the persistent duration cache and Real-Debrid key into schedule regeneration"
```

---

## Post-implementation notes for the reviewer

- `ffprobe` requires no Dockerfile change: the `ffmpeg` apt package already installed in `Dockerfile` bundles the `ffprobe` binary alongside `ffmpeg`.
- First-ever regeneration for a channel with many previously-unresolved items will be slower than subsequent ones (sequential Cinemeta/probe calls per unique uncached item), but this is a background daily job per `Global Constraints`, and the persistent cache means the cost is paid once per item, not once per regeneration.
- `data/runtimeCache.json` is a new file under `DATA_DIR`; nothing needs to migrate it or seed it — a missing file is treated as an empty cache (Task 4, Step 3).
