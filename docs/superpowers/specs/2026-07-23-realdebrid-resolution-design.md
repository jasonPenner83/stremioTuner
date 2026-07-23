# Real-Debrid Stream Resolution — Design Spec

## Summary

Play-time stream resolution currently assumes the addon supplying a
channel's streams already returns direct HTTP-playable URLs (the original
design's non-goal: "no built-in torrent/magnet-to-HTTP resolution"). In
practice, the catalog addon (e.g. Cinemeta) has no `stream` resource at
all, and a real stream-providing addon (e.g. Torrentio) without a
debrid key configured returns magnet-style candidates (`infoHash`, no
`url`). This spec adds a separate per-channel stream addon plus direct
Real-Debrid (RD) API integration so those candidates can be resolved to
playable links ourselves. **This supersedes that non-goal.**

## Problem

- A channel's catalog addon (e.g. Cinemeta) only serves `catalog`/`meta`
  resources — calling its `stream/:type/:id.json` endpoint fails or
  returns nothing.
- `fetchStreams` in `addonClient.js` currently queries the *same* addon
  as the catalog (`channel.source.transportUrl`), so Cinemeta-sourced
  channels can never produce a stream.
- Even once a real stream-providing addon is queried, its candidates may
  be magnet-only (`infoHash`) rather than direct `url`s, which
  `streamSelect.js` and the ffmpeg proxy can't consume.

## Goals

- Let a channel use a different addon for streams than for its catalog.
- Resolve magnet-style stream candidates (`infoHash`) to a direct,
  RD-unrestricted HTTP URL at play-time.
- Only ever select a candidate RD can serve *instantly* (already cached)
  — never wait on RD to download an uncached torrent, since playback
  must start immediately.
- Support both movies (single video file) and series (season-pack
  torrents, matched to the specific episode by filename).

## Non-goals

- No UI for entering the RD API key (env var only, like
  `STREMIO_EMAIL`/`STREMIO_PASSWORD`).
- No fallback to a second-ranked candidate if the top-ranked one fails
  to resolve after being reported cached (treated as a hard failure for
  that play request, same granularity as other "no playable stream"
  cases).
- No RD account cleanup/torrent deletion — resolved torrents are left
  in the account and reused by hash on subsequent requests.
- No changes to how episodes are scheduled/enumerated — season/episode
  numbers are parsed from the existing item id (`tt1234567:1:2` Stremio
  convention) if present; this spec does not add new machinery for
  turning show-level catalog entries into per-episode schedule items.

## Configuration changes

- **`streamAddonId`** (new, required going forward) added to each
  channel record in `/data/channels.json`, alongside the existing
  `addonId`/`catalogId`. Resolved the same way `addonId` is today (via
  the cross-reference against installed Stremio addons), producing
  `channel.streamSource = { transportUrl, type }` distinct from
  `channel.source` (the catalog source).
- **`REALDEBRID_API_KEY`** (new env var) — the user's RD API token. If
  unset, magnet-only candidates are simply never usable (logged once as
  a startup warning); channels whose stream addon already returns direct
  `url`s are unaffected.

## Architecture

```
GET /stream/:channelId
   │
   ├─ load schedule, find "now" item (unchanged)
   │
   ├─ fetchStreams(channel.streamSource.transportUrl, type, item.id)
   │     → streams: mix of {url} and {infoHash, title, ...}
   │
   ├─ direct   = streams with .url            (used as-is)
   ├─ magnetCandidates = streams with .infoHash, no .url
   │
   ├─ if magnetCandidates.length && REALDEBRID_API_KEY:
   │     cached = checkInstantAvailability(apiKey, hashes)
   │     magnetCandidates = magnetCandidates.filter(cached)
   │   else:
   │     magnetCandidates = []
   │
   ├─ selected = selectStream([...direct, ...magnetCandidates], {minQuality, language})
   │     (existing language/quality/peers ranking, unchanged logic)
   │
   ├─ if !selected → 502 "No playable stream found"        (unchanged)
   │
   ├─ if selected.infoHash:
   │     {season, episode} = parseSeasonEpisode(item.id)
   │     finalUrl = resolveStream(apiKey, selected.infoHash, {season, episode})
   │   else:
   │     finalUrl = selected.url
   │
   └─ streamViaFfmpeg({ sourceUrl: finalUrl, offsetSeconds, res })   (unchanged)
```

## `src/realDebrid.js` (new module)

- **`checkInstantAvailability(apiKey, infoHashes)`** — `GET
  /torrents/instantAvailability/{hash1}/{hash2}/...`. Returns the subset
  of hashes RD reports as cached. Network/API failure → treated as
  "nothing cached" (fail closed), caller falls back to direct-url
  candidates only.
- **`resolveStream(apiKey, infoHash, { season, episode })`**:
  1. `GET /torrents` — if an entry with this `hash` already exists and
     has `links`, reuse it (skip to step 5) rather than re-adding.
  2. Otherwise `POST /torrents/addMagnet` with
     `magnet:?xt=urn:btih:{infoHash}`.
  3. `GET /torrents/info/{id}` to read the file list. Pick the target
     file: if `season`/`episode` are known, match `path` against an
     `SxxEyy`/`1x02`-style regex; otherwise (movie) pick the largest
     file by `bytes`.
  4. `POST /torrents/selectFiles/{id}` with only that file's id.
  5. `GET /torrents/info/{id}` again for the resulting `links[0]`.
  6. `POST /unrestrict/link` with that link → return `download`.
  - Any step failing (network, RD error response, cache eviction race)
    throws; the caller treats this the same as "no playable stream"
    (502), no retry/fallback within this pass.

## `streamSelect.js` change

- The initial filter (`!!s.url`) becomes `!!s.url || !!s.infoHash` so
  magnet candidates survive into quality/language/peer ranking (which
  already works off `title`/`name` text, unchanged).

## `addonClient.js` / `bootstrap.js` changes

- No change to `fetchStreams` signature — callers now pass
  `channel.streamSource.transportUrl` instead of
  `channel.source.transportUrl`.
- The per-channel source-resolution helper in `bootstrap.js` resolves
  both `addonId`→`source` (catalog) and `streamAddonId`→`streamSource`
  (streams) independently, reusing the existing null-source
  retry/graceful-degradation behavior for each.

## Error handling

- No `REALDEBRID_API_KEY` configured: magnet candidates never selected;
  behaves as if the stream addon returned only its direct-url streams.
  One startup warning log, not per-request.
- `checkInstantAvailability` failure: fail closed (nothing cached),
  falls through to direct-url candidates / existing 502 path.
- `resolveStream` failure on the selected candidate: log and 502, same
  as any other "no playable stream" case today.

## Testing

- `realDebrid.js`: unit tests with injectable `fetchImpl`, covering
  instant-availability filtering, reuse-by-hash short-circuit, episode
  file matching (season-pack fixture with multiple `SxxEyy` files),
  movie file selection (largest file), and unrestrict-link happy path.
- `streamSelect.js`: extend existing tests to cover `infoHash`-only
  candidates surviving the filter and being ranked correctly alongside
  `url` candidates.
- `app.test.js`: extend `/stream/:channelId` tests with a mocked
  stream addon returning magnet candidates + a mocked
  `checkInstantAvailability`/`resolveStream`, asserting the ffmpeg proxy
  receives the RD-resolved URL; and a case with no `REALDEBRID_API_KEY`
  where magnet candidates are correctly ignored.
