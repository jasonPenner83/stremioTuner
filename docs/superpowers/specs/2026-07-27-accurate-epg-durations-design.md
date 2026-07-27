# Accurate EPG Durations — Design Spec

## Summary

Some catalog items never have a usable duration: their addon's `meta`
response omits `runtime`, so `generateChannelSchedule` falls back to a flat
`defaultRuntimeMs` (90 minutes) for every one of them, producing wrong EPG
timings. This is worst for content with no metadata provider at all (e.g.
adult catalogs), where no addon-side fix is possible. This spec adds a
fallback chain — addon metadata → Cinemeta lookup → probing the actual
resolved stream file with `ffprobe` — with results cached to disk so the
expensive steps only ever run once per item.

## Problem

`getRuntimeMs` in `src/generateSchedule.js` only ever looks at
`meta.runtime` from the channel's catalog addon. When that's missing or
unparseable, every occurrence of that item in the lineup gets the same
90-minute default, regardless of its real length. This affects mainstream
movies/series whose catalog addon simply doesn't populate `runtime`, and
affects adult content categorically, since it has no IMDb ID / Cinemeta
entry to fall back on.

## Goals

- Resolve accurate durations for items lacking `meta.runtime`, using
  whatever signal is available: a public metadata provider for
  IMDb-identified content, and the actual stream file for anything else.
- Make this work for content with no metadata provider (e.g. adult
  catalogs) by reading duration directly from the resolved stream's
  container, via `ffprobe` (already present in the Docker image and used
  by `src/server/ffmpegProxy.js`).
- Pay the expensive resolution+probe cost at most once per catalog item,
  ever, via a persistent on-disk cache — not once per daily regeneration.
- Reuse the existing playback stream-resolution logic (candidate ranking,
  Real-Debrid availability/resolution, direct-URL size-check) rather than
  duplicating it, since duration-probing needs the same "get a playable
  URL for this item" behavior the `/stream/:channelId` route already has.

## Non-goals

- No change to playback behavior or the `/stream/:channelId` route's
  externally observable behavior — the resolution logic it uses is
  extracted, not altered.
- No parallel/concurrent probing. Probing runs sequentially within the
  existing per-item loop in `generateChannelSchedule`, matching its
  current `await`-in-a-loop style.
- No negative caching. An item that falls through the entire chain to the
  flat default is not cached, so it's naturally retried on the next
  regeneration.
- No UI changes.

## Architecture

Four-step fallback chain, evaluated per catalog item inside
`generateChannelSchedule`:

1. **`meta.runtime`** from the catalog addon (existing behavior, unchanged).
2. **Cinemeta lookup** — if step 1 is empty and the item ID matches
   `/^tt\d+/` (IMDb-style), fetch
   `https://v3-cinemeta.strem.io/meta/<type>/<id>.json` and use its
   `runtime` if present.
3. **File probe** — if still unknown, resolve a playable stream URL for the
   item (via the extracted `resolvePlayableUrl` helper, see below) and run
   `ffprobe` against it to read the real duration from the container.
4. **Flat default** (`defaultRuntimeMs`, unchanged) — only if all three
   above fail. Not cached.

Each item's resolved duration from steps 1–3 is cached to disk by item ID,
so subsequent regenerations skip straight to a cache hit.

## Shared stream-resolution helper

`src/server/app.js`'s `/stream/:channelId` handler currently inlines the
full "get a playable URL for this item" flow: fetch streams, split
direct-URL vs magnet candidates, check Real-Debrid instant availability,
rank candidates, then walk the ranked list — size-checking direct URLs
(`isLikelyPlayableSize`) or resolving magnets via Real-Debrid
(`resolveStream`) — returning the first URL that works.

This is extracted into a new module, `src/resolvePlayableUrl.js`:

```js
export async function resolvePlayableUrl({
  item,
  channel,
  streamSource,
  realDebridApiKey,
  fetchStreamsImpl = fetchStreams,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  isLikelyPlayableSizeImpl = isLikelyPlayableSize
}) {
  // ...existing candidate-resolution logic, moved verbatim from app.js...
  return finalUrl; // or null if nothing resolved
}
```

`app.js`'s `/stream/:channelId` route calls this helper and keeps its
existing 502 behavior when it returns `null`. No behavioral change to the
route — this is a pure extraction so `generateChannelSchedule` can call the
same logic for probing.

## Duration probe module

New `src/durationProbe.js`:

```js
export async function probeDurationMs(url, {
  spawnImpl = spawn,
  ffprobePath = 'ffprobe',
  timeoutMs = 8000
} = {}) {
  // spawn: ffprobe -v error -show_entries format=duration -of csv=p=0 <url>
  // parse stdout as seconds -> ms; return null on timeout, non-zero exit,
  // or unparseable output. Never throws.
}
```

Mirrors the bounded-timeout pattern already used in
`streamSizeCheck.js`'s `isLikelyPlayableSize` (`AbortSignal`-style timeout,
fail to `null` rather than hang or throw).

## Duration cache

New `src/durationCacheStore.js`, following the same
read/write-JSON-file convention as `channelStore.js` / `scheduleStore.js`:

```js
export function durationCachePath(dataDir) // data/runtimeCache.json
export async function readDurationCache(dataDir, { fs } = {})
export async function writeDurationCache(dataDir, cache, { fs } = {})
```

Shape: `{ "<itemId>": { "ms": 5400000, "source": "probe", "resolvedAt": "<ISO>" } }`.
`source` is one of `"meta"`, `"cinemeta"`, `"probe"` — never written for
items that fell through to the flat default.

## `generateChannelSchedule` changes

Signature gains: `streamSource`, `minQuality`, `language`,
`realDebridApiKey`, and injectable cache/read/write/probe/resolve
functions (matching the existing DI convention in this file and
`bootstrap.js`).

`getRuntimeMs(item)` becomes:

1. In-memory `runtimeCache` hit (existing, unchanged — avoids redundant
   work within a single generation run) → return.
2. Persistent disk-cache hit → populate in-memory cache, return.
3. `meta.runtime` parse succeeds → cache (both memory + disk), return.
4. IMDb-style ID + Cinemeta lookup succeeds → cache, return.
5. `resolvePlayableUrl` + `probeDurationMs` succeeds → cache, return.
6. None of the above → return `defaultRuntimeMs`, cache only in-memory
   (not disk), so the next regeneration retries steps 3–5.

Disk-cache writes happen incrementally (read once at the start of
generation, write once at the end covering all newly-resolved items in
that run) rather than one file write per item.

## `bootstrap.js` changes

`regenerate(channel)` passes `channel.streamSource`, `channel.minQuality`,
`channel.language`, and the module-level `realDebridApiKey` through to
`generateChannelScheduleImpl`, all of which are already in scope there.

## Error handling

- Cinemeta and probe failures are per-item and non-fatal: logged via
  `console.error` and treated as "fall through to the next step," exactly
  like the existing Real-Debrid-resolution-failure logging in `app.js`.
- These never surface as `channel.lastError` — that field stays reserved
  for whole-schedule-generation failures (e.g. catalog fetch failure), not
  a single item falling back to a default duration.
- `probeDurationMs` and the Cinemeta fetch both use bounded timeouts so a
  slow/unresponsive stream or metadata endpoint can't hang schedule
  regeneration for an entire channel.

## Testing

- `durationProbe.js`: unit tests with a fake `spawnImpl` — successful
  duration parse, non-zero exit, timeout, and unparseable stdout all
  produce the expected result (`ms` or `null`).
- `durationCacheStore.js`: read/write round-trip, missing-file returns
  empty cache (matching `readChannels`/`readSchedule` ENOENT handling).
- `resolvePlayableUrl.js`: tests migrated/adapted from `app.js`'s existing
  `/stream/:channelId` coverage, run directly against the extracted
  function.
- `app.js`: confirm `/stream/:channelId` behavior is unchanged after the
  extraction (existing tests should pass with minimal adaptation).
- `generateSchedule.js`: extend with cases for each rung of the fallback
  chain (meta hit, Cinemeta hit for a `tt`-id with empty meta, probe hit
  for a non-`tt`-id, full fallthrough to default), and a disk-cache-hit
  case that asserts no network/probe calls happen.
