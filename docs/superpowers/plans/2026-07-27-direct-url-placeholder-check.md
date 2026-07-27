# Extend Placeholder Detection to Direct-URL Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Real-Debrid's DMCA-takedown placeholder even when a stream addon pre-resolves via its own debrid config (handing stremioTuner a direct `url` rather than a magnet stremioTuner resolves itself), by checking `Content-Length` via a `HEAD` request before proxying any direct-URL candidate.

**Architecture:** A new shared module `src/streamSizeCheck.js` holds the size threshold (moved from `src/realDebrid.js`, which re-exports it) and `isLikelyPlayableSize(url, {fetchImpl})` — fails open (returns `true`, meaning "use it") on any ambiguity: non-2xx response, missing header, or thrown error. `app.js`'s existing per-candidate fallback loop calls it for every `candidate.url` before using it, falling through to the next ranked candidate on rejection — the exact same fallback shape the prior fix already added for Real-Debrid failures.

**Tech Stack:** Node.js (native `fetch`, no new dependencies), `node:test`/`node:assert`.

## Global Constraints

- No new npm dependencies.
- `MIN_PLAYABLE_FILE_BYTES` must have exactly one definition (in `src/streamSizeCheck.js`); `src/realDebrid.js` re-exports it rather than defining its own copy, so both checks always agree on the threshold.
- `isLikelyPlayableSize` must fail OPEN (return `true`) on every ambiguous case: non-2xx `HEAD` response, missing `Content-Length` header, non-numeric `Content-Length`, or a thrown/rejected fetch — it may only return `false` when it has positive evidence (a real, parseable, too-small `Content-Length`).
- `test/app.test.js`'s shared `withApp` helper must default `isLikelyPlayableSizeImpl` to a stub (`async () => true`) when a test doesn't supply one — this is what keeps every pre-existing test passing unmodified AND prevents the test suite from making real network `HEAD` requests to fake URLs like `http://good`. This default lives in the helper, not in individual test bodies.
- Every pre-existing test in `test/realDebrid.test.js` and `test/app.test.js` must keep passing unmodified.
- Follow existing code style: named exports, injectable `fetchImpl`/`*Impl` params, `node:test` + `node:assert/strict`.

---

### Task 1: `src/streamSizeCheck.js` — `isLikelyPlayableSize`

**Files:**
- Create: `src/streamSizeCheck.js`
- Test: `test/streamSizeCheck.test.js`

**Interfaces:**
- Produces: `MIN_PLAYABLE_FILE_BYTES` (`50 * 1024 * 1024`), `isLikelyPlayableSize(url, {fetchImpl?}): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Create `test/streamSizeCheck.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyPlayableSize, MIN_PLAYABLE_FILE_BYTES } from '../src/streamSizeCheck.js';

test('isLikelyPlayableSize returns false for a Content-Length below the threshold', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://example.com/video.mkv');
    assert.equal(opts.method, 'HEAD');
    return { ok: true, headers: { get: (name) => (name === 'content-length' ? '2097152' : null) } };
  };
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, false);
});

test('isLikelyPlayableSize returns true for a Content-Length at or above the threshold', async () => {
  const fetchImpl = async () => ({ ok: true, headers: { get: (name) => (name === 'content-length' ? String(MIN_PLAYABLE_FILE_BYTES) : null) } });
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) on a non-ok HEAD response', async () => {
  const fetchImpl = async () => ({ ok: false, headers: { get: () => null } });
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) when Content-Length is missing', async () => {
  const fetchImpl = async () => ({ ok: true, headers: { get: () => null } });
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) when the HEAD request throws', async () => {
  const fetchImpl = async () => { throw new Error('network error'); };
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/streamSizeCheck.test.js`
Expected: FAIL with "Cannot find module '../src/streamSizeCheck.js'" (file doesn't exist yet).

- [ ] **Step 3: Implement `src/streamSizeCheck.js`**

```js
export const MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024;

export async function isLikelyPlayableSize(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD' });
    if (!res.ok) return true;
    const contentLength = res.headers.get('content-length');
    if (contentLength === null) return true;
    const size = Number(contentLength);
    if (!Number.isFinite(size)) return true;
    return size >= MIN_PLAYABLE_FILE_BYTES;
  } catch {
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/streamSizeCheck.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/streamSizeCheck.js test/streamSizeCheck.test.js
git commit -m "Add isLikelyPlayableSize: fail-open Content-Length check for direct-URL candidates"
```

---

### Task 2: `realDebrid.js` — single source of truth for the threshold

**Files:**
- Modify: `src/realDebrid.js`
- Test: `test/realDebrid.test.js`

**Interfaces:**
- Produces: `MIN_PLAYABLE_FILE_BYTES` remains importable from `src/realDebrid.js` (re-exported), with the identical value as `src/streamSizeCheck.js`'s.

`src/realDebrid.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Write the failing test**

Add to `test/realDebrid.test.js`. First, update its import line (was `import { parseSeasonEpisode, pickTorrentFile, checkInstantAvailability, resolveStream } from '../src/realDebrid.js';`) to also import the constant:

```js
import { parseSeasonEpisode, pickTorrentFile, checkInstantAvailability, resolveStream, MIN_PLAYABLE_FILE_BYTES } from '../src/realDebrid.js';
```

Then add a new test (anywhere in the file, e.g. near the top after the imports):

```js
test('MIN_PLAYABLE_FILE_BYTES is re-exported from the shared streamSizeCheck module with the same value', () => {
  assert.equal(MIN_PLAYABLE_FILE_BYTES, 50 * 1024 * 1024);
});
```

- [ ] **Step 2: Run tests to verify the setup is correct**

Run: `node --test test/realDebrid.test.js`
Expected: this particular new test PASSES even before Task 2's Step 3 change (since `MIN_PLAYABLE_FILE_BYTES` already exists as a local constant in `realDebrid.js` with this exact value) — that's fine, its purpose is to keep passing identically after the re-export change in Step 3, proving the refactor is behavior-preserving. Confirm no other test in this file is affected.

- [ ] **Step 3: Implement the change**

In `src/realDebrid.js`, replace:

```js
export const MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024;
```

with:

```js
import { MIN_PLAYABLE_FILE_BYTES } from './streamSizeCheck.js';

export { MIN_PLAYABLE_FILE_BYTES };
```

(Place the `import` line alongside the file's other top-of-file statements, before `const API_BASE = ...`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/realDebrid.test.js`
Expected: all tests PASS, including every pre-existing test (the value and behavior of `MIN_PLAYABLE_FILE_BYTES` and the `unrestrictLink` size check are unchanged — only where the constant is defined changed).

- [ ] **Step 5: Commit**

```bash
git add src/realDebrid.js test/realDebrid.test.js
git commit -m "Re-export MIN_PLAYABLE_FILE_BYTES from the shared streamSizeCheck module"
```

---

### Task 3: `app.js` — size-check direct-URL candidates before use

**Files:**
- Modify: `src/server/app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `isLikelyPlayableSize` (Task 1).
- Produces: `createApp({..., isLikelyPlayableSizeImpl?})` — new optional param, defaulting to the real `isLikelyPlayableSize`.

`src/server/app.js` already exists and has NOT changed since the plan was written — read it in full before editing to confirm exact current state and line numbers.

- [ ] **Step 1: Write the failing tests**

In `test/app.test.js`, update the `withApp` helper to accept and default `isLikelyPlayableSizeImpl` (this is what keeps every pre-existing test passing without making real network calls):

```js
async function withApp(t, { channels, schedules = {}, corruptSchedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl, channelActions, settingsActions, realDebridApiKey, checkInstantAvailabilityImpl, resolveStreamImpl, isLikelyPlayableSizeImpl = async () => true } = {}) {
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
    settingsActions,
    realDebridApiKey,
    checkInstantAvailabilityImpl,
    resolveStreamImpl,
    isLikelyPlayableSizeImpl
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

(Only the parameter list and the `isLikelyPlayableSizeImpl` line inside the `createApp({...})` call are new — everything else in this helper is unchanged.)

Add two new tests, after the existing "502s when every ranked candidate fails Real-Debrid resolution" test:

```js
test('GET /stream/:channelId falls back to the next-ranked candidate when a direct-URL candidate fails the size check', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const checkedUrls = [];
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [
      { title: '1080p 👤 50', url: 'http://placeholder' },
      { title: '1080p 👤 10', url: 'http://good' }
    ],
    isLikelyPlayableSizeImpl: async (url) => { checkedUrls.push(url); return url !== 'http://placeholder'; },
    streamViaFfmpegImpl: async (args) => { args.res.end(); },
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 200);
  assert.deepEqual(checkedUrls, ['http://placeholder', 'http://good']);
});

test('GET /stream/:channelId 502s when every direct-URL candidate fails the size check', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '1080p 👤 50', url: 'http://placeholder' }],
    isLikelyPlayableSizeImpl: async () => false,
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/app.test.js`
Expected: FAIL — `createApp` doesn't accept/use `isLikelyPlayableSizeImpl` yet, so every direct-`url` candidate is used immediately regardless of the mock's return value (the fallback test never reaches `http://good`; the exhaustion test gets 200, not 502).

- [ ] **Step 3: Implement the change**

In `src/server/app.js`, add the import (alongside the existing `realDebrid.js` import):

```js
import { isLikelyPlayableSize } from '../streamSizeCheck.js';
```

Add `isLikelyPlayableSizeImpl` to `createApp`'s destructured params:

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
  realDebridApiKey = null,
  nowImpl = () => new Date()
}) {
```

Update the candidate loop's `candidate.url` branch:

```js
      for (const candidate of candidates) {
        if (candidate.url) {
          const playable = await isLikelyPlayableSizeImpl(candidate.url);
          if (playable) {
            finalUrl = candidate.url;
            break;
          }
          console.error(`Direct URL failed size check (likely a takedown placeholder), trying next candidate: ${candidate.url}`);
          continue;
        }
        const { season, episode } = parseSeasonEpisode(item.id);
        try {
          finalUrl = await resolveStreamImpl(realDebridApiKey, candidate.infoHash, { season, episode });
          break;
        } catch (err) {
          console.error(`Real-Debrid resolution failed for a candidate, trying next: ${err.message}`);
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/app.test.js`
Expected: all tests PASS, including every pre-existing test in this file — they all rely on `withApp`'s new `isLikelyPlayableSizeImpl = async () => true` default (never making a real network call), so every direct-`url` candidate in those tests is used exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.js test/app.test.js
git commit -m "Size-check direct-URL stream candidates before use, falling back on rejection"
```

---

### Task 4: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions.

- [ ] **Step 2: Manual verification**

Confirm the app still starts and serves a normal channel correctly (this is a behavior-preserving addition for the common/healthy case — every existing direct-URL stream should play exactly as before, just with one extra `HEAD` request added in front of it). Watch the container logs the next time a pre-resolved direct-URL placeholder would have played — you should now see a `Direct URL failed size check (likely a takedown placeholder), trying next candidate: <url>` line instead of the placeholder silently playing.
