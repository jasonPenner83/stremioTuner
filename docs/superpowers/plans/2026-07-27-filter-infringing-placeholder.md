# Filter Out Real-Debrid Infringement Placeholders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Real-Debrid's silent DMCA-takedown placeholder (a valid-looking but tiny download it serves instead of erroring) by file size, and automatically fall back to the next-best stream candidate instead of playing the placeholder or failing outright.

**Architecture:** `streamSelect.js` gains `rankStreams(...)`, returning ALL matching candidates in ranked order (`selectStream` becomes a thin `rankStreams(...)[0] ?? null` wrapper, unchanged behavior). `realDebrid.js`'s private `unrestrictLink` helper (called from both of `resolveStream`'s existing code paths) now rejects a resolved file under 50MB. `app.js`'s `/stream/:channelId` handler walks the ranked candidate list, using the first direct-`url` candidate immediately or trying Real-Debrid resolution for magnet candidates and moving to the next one on any failure (network error or the new too-small rejection), only returning the existing 502 once every candidate has been tried.

**Tech Stack:** Node.js (no new dependencies), `node:test`/`node:assert`.

## Global Constraints

- No new npm dependencies.
- `MIN_PLAYABLE_FILE_BYTES` is a single hardcoded constant (50MB = `50 * 1024 * 1024`), not configurable in this pass.
- `resolveStream`'s public return type is unchanged (still resolves to a download URL string, or throws) — the filesize check lives inside the private `unrestrictLink` helper so both of `resolveStream`'s existing call paths (reuse-by-hash, and fresh add/select/unrestrict) get it automatically without duplicating the check.
- The filesize check must only reject when Real-Debrid actually reports a numeric `filesize` below the threshold — a response with no `filesize` field at all must NOT be rejected (treat as "unknown, assume fine" rather than fail-closed), since this is also what keeps every pre-existing `realDebrid.test.js` fixture (none of which include `filesize`) passing unmodified.
- Every pre-existing test in `test/streamSelect.test.js`, `test/realDebrid.test.js`, and `test/app.test.js` must keep passing unmodified — this whole feature is additive; no existing behavior for the "first candidate is fine" case should change.
- Follow existing code style: named exports, injectable `fetchImpl`, `node:test` + `node:assert/strict`.

---

### Task 1: `streamSelect.js` — `rankStreams`

**Files:**
- Modify: `src/streamSelect.js`
- Test: `test/streamSelect.test.js`

**Interfaces:**
- Produces: `rankStreams(streams, {minQuality, language}): Array<{url?, infoHash?, quality, peers, languageOk}>` — every candidate passing the language filter, in the same shape `selectStream` already produced for its single winner, ordered: all "strict" matches (language AND minQuality met) sorted by `peers` descending, then all remaining language-only ("relaxed") matches sorted by `peers` descending, with no candidate appearing twice even though a strict match also satisfies the relaxed criterion. `selectStream(streams, opts)` becomes `rankStreams(streams, opts)[0] ?? null`.

`src/streamSelect.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Write the failing tests**

Add to `test/streamSelect.test.js` (import `rankStreams` alongside the existing imports at the top: `import { parseQuality, qualityRank, parsePeers, matchesLanguage, selectStream, rankStreams } from '../src/streamSelect.js';`):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/streamSelect.test.js`
Expected: FAIL with "rankStreams is not a function" (doesn't exist yet).

- [ ] **Step 3: Implement the change**

In `src/streamSelect.js`, replace `selectStream` (keep `maxByPeers` removed since it's superseded — nothing else uses it) with:

```js
function sortByPeersDesc(candidates) {
  return [...candidates].sort((a, b) => b.peers - a.peers);
}

export function rankStreams(streams, { minQuality, language }) {
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
  const strictSet = new Set(strict);
  const relaxedOnly = parsed.filter((c) => c.languageOk && !strictSet.has(c));

  return [...sortByPeersDesc(strict), ...sortByPeersDesc(relaxedOnly)];
}

export function selectStream(streams, opts) {
  const ranked = rankStreams(streams, opts);
  return ranked[0] ?? null;
}
```

(This removes the old `maxByPeers` function and the old `selectStream` body — everything else in the file, including `parseQuality`/`qualityRank`/`parsePeers`/`matchesLanguage`/`QUALITY_ORDER`/`SUPPORTED_LANGUAGES`, is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/streamSelect.test.js`
Expected: all tests PASS, including every pre-existing `selectStream` test (verifying the refactor didn't change `selectStream`'s observable behavior).

- [ ] **Step 5: Commit**

```bash
git add src/streamSelect.js test/streamSelect.test.js
git commit -m "Add rankStreams: return all matching candidates in order, not just the winner"
```

---

### Task 2: `realDebrid.js` — reject implausibly small resolved files

**Files:**
- Modify: `src/realDebrid.js`
- Test: `test/realDebrid.test.js`

**Interfaces:**
- Produces: `MIN_PLAYABLE_FILE_BYTES` (new exported constant, `50 * 1024 * 1024`). `resolveStream`'s existing public contract is unchanged (resolves to a URL string, or rejects) — it now also rejects when Real-Debrid's `/unrestrict/link` response reports a `filesize` under `MIN_PLAYABLE_FILE_BYTES`, with the message `` `Resolved file too small (likely a takedown placeholder): ${filesize} bytes` ``.

`src/realDebrid.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Write the failing tests**

Add to `test/realDebrid.test.js` (after the existing `resolveStream` tests):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/realDebrid.test.js`
Expected: FAIL — the two "too small" tests fail because nothing currently rejects (resolveStream resolves successfully instead of throwing); the "at or above threshold" test should already pass (no change needed for it, but running it now establishes the baseline).

- [ ] **Step 3: Implement the change**

In `src/realDebrid.js`, add the constant near the top (after `API_BASE`):

```js
export const MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024;
```

Update `unrestrictLink`:

```js
async function unrestrictLink(apiKey, link, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ link })
  });
  if (!res.ok) throw new Error(`unrestrict/link failed (${res.status})`);
  const data = await res.json();
  if (typeof data.filesize === 'number' && data.filesize < MIN_PLAYABLE_FILE_BYTES) {
    throw new Error(`Resolved file too small (likely a takedown placeholder): ${data.filesize} bytes`);
  }
  return data.download;
}
```

(No changes needed to `resolveStream` itself — both of its call sites already go through this `unrestrictLink` helper, so the check applies to both automatically.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/realDebrid.test.js`
Expected: all tests PASS, including every pre-existing test (none of their fixtures set `filesize`, so `typeof data.filesize === 'number'` is `false` for them and the new check never fires).

- [ ] **Step 5: Commit**

```bash
git add src/realDebrid.js test/realDebrid.test.js
git commit -m "Reject Real-Debrid-resolved files under 50MB as likely takedown placeholders"
```

---

### Task 3: `app.js` — try candidates in order until one works

**Files:**
- Modify: `src/server/app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `rankStreams` (Task 1) instead of `selectStream`.
- Produces: `/stream/:channelId` now tries every ranked candidate in order (direct-`url` candidates used immediately, magnet candidates resolved via Real-Debrid with a move-to-next-candidate on any failure) before returning the existing `502 "No playable stream found"`.

`src/server/app.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state and line numbers.

- [ ] **Step 1: Write the failing tests**

Add to `test/app.test.js` (after the existing "502s (not 500) when Real-Debrid instant availability check fails" test):

```js
test('GET /stream/:channelId falls back to the next-ranked candidate when the top one fails Real-Debrid resolution', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const resolvedInfoHashes = [];
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://torrentio/manifest.json' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [
      { title: '1080p 👤 50', infoHash: 'best-but-bad' },
      { title: '1080p 👤 10', infoHash: 'second-good' }
    ],
    checkInstantAvailabilityImpl: async () => new Set(['best-but-bad', 'second-good']),
    resolveStreamImpl: async (apiKey, infoHash) => {
      resolvedInfoHashes.push(infoHash);
      if (infoHash === 'best-but-bad') throw new Error('Resolved file too small (likely a takedown placeholder): 2097152 bytes');
      return 'https://direct/good.mkv';
    },
    streamViaFfmpegImpl: async (args) => { args.res.end(); },
    nowImpl: () => now,
    realDebridApiKey: 'rd-key'
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 200);
  assert.deepEqual(resolvedInfoHashes, ['best-but-bad', 'second-good']);
});

test('GET /stream/:channelId 502s when every ranked candidate fails Real-Debrid resolution', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  let resolveAttempts = 0;
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' }, streamSource: { transportUrl: 'https://torrentio/manifest.json' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [
      { title: '1080p 👤 50', infoHash: 'bad-one' },
      { title: '1080p 👤 10', infoHash: 'also-bad' }
    ],
    checkInstantAvailabilityImpl: async () => new Set(['bad-one', 'also-bad']),
    resolveStreamImpl: async () => { resolveAttempts += 1; throw new Error('always fails'); },
    nowImpl: () => now,
    realDebridApiKey: 'rd-key'
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
  assert.equal(resolveAttempts, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/app.test.js`
Expected: FAIL — the current handler only ever tries a single candidate (`selectStream`'s winner) and returns 502 immediately on that one candidate's resolution failure, so it never reaches the second `infoHash` in either new test (the fallback test gets a 502 instead of 200; the exhaustion test's `resolveAttempts` stays at 1, not 2).

- [ ] **Step 3: Implement the change**

In `src/server/app.js`, change the import (was `import { selectStream } from '../streamSelect.js';`):

```js
import { rankStreams } from '../streamSelect.js';
```

Replace the selection/resolution block (from the `const selected = selectStream(...)` line through the `streamViaFfmpegImpl` call) with:

```js
      const candidates = rankStreams([...direct, ...magnetCandidates], { minQuality: channel.minQuality, language: channel.language });

      let finalUrl = null;
      for (const candidate of candidates) {
        if (candidate.url) {
          finalUrl = candidate.url;
          break;
        }
        const { season, episode } = parseSeasonEpisode(item.id);
        try {
          finalUrl = await resolveStreamImpl(realDebridApiKey, candidate.infoHash, { season, episode });
          break;
        } catch (err) {
          console.error(`Real-Debrid resolution failed for a candidate, trying next: ${err.message}`);
        }
      }

      if (!finalUrl) {
        res.status(502).end('No playable stream found');
        return;
      }

      await streamViaFfmpegImpl({ sourceUrl: finalUrl, offsetSeconds, res });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/app.test.js`
Expected: all tests PASS, including every pre-existing test in this file (each of them only ever supplies a single stream candidate, so the loop's first iteration behaves identically to the old single-shot logic — same 200/502 outcomes as before).

- [ ] **Step 5: Commit**

```bash
git add src/server/app.js test/app.test.js
git commit -m "Try ranked stream candidates in order until one resolves, instead of failing on the first"
```

---

### Task 4: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions in any pre-existing test.

- [ ] **Step 2: Manual verification**

This can't be fully verified without a real Real-Debrid account and a real DMCA-flagged cached file, so full confirmation is deferred to real-world use. At minimum: confirm the app still starts and serves a normal channel correctly (`npm start` with valid env vars, tune into a channel in VLC as before) — this is a behavior-preserving refactor for the common case, so the golden path should be unaffected. Watch the container logs the next time an infringement placeholder would have played — you should now see a `Real-Debrid resolution failed for a candidate, trying next: Resolved file too small...` line instead of the placeholder silently playing.
