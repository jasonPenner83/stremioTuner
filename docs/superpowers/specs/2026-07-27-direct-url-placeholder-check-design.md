# Extend Placeholder Detection to Direct-URL Candidates — Design Spec

## Summary

The previous fix only detects Real-Debrid's DMCA-takedown placeholder video
when stremioTuner itself resolves a magnet via Real-Debrid
(`REALDEBRID_API_KEY` set, candidate has `infoHash`). It does nothing for a
candidate that already arrives as a direct `url` — which happens whenever
the stream addon has its own embedded Real-Debrid (or other debrid)
configuration and resolves the link on its own server before handing it to
stremioTuner. This spec closes that gap with a `Content-Length`-based check
before proxying any direct-`url` candidate.

## Problem

A user's stream addon "not always" pre-resolves via its own debrid config —
some candidates arrive as direct `url`s, bypassing the Real-Debrid-specific
placeholder check entirely, so a takedown placeholder from those still
plays through untouched.

## Goals

- Detect an implausibly small direct-URL candidate (same 50MB threshold as
  the existing Real-Debrid check) via an HTTP `HEAD` request's
  `Content-Length` header, before proxying it.
- Reuse the SAME threshold constant as the Real-Debrid check (single source
  of truth), not a second hardcoded number.
- Fail open on any ambiguity — a non-2xx `HEAD` response, a missing
  `Content-Length` header, or a network error must all be treated as "can't
  tell, assume it's fine" rather than blocking a potentially valid stream.
- Fall back to the next-ranked candidate on rejection, exactly like the
  existing Real-Debrid-resolution fallback already does.

## Non-goals

- No change to the Real-Debrid-specific check (still lives in
  `unrestrictLink`, still fires for magnet candidates stremioTuner resolves
  itself) — this is purely additive coverage for the direct-`url` case.
- No configurability of the threshold in this pass (matches the existing
  non-goal from the prior fix).
- No caching of "known bad" URLs across requests.

## Architecture

A new shared module, `src/streamSizeCheck.js`, holds the threshold constant
(moved here from `src/realDebrid.js`, which re-exports it for backward
compatibility) and the new check function:

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

`src/realDebrid.js` changes its `MIN_PLAYABLE_FILE_BYTES` declaration to a
re-export from the new module instead of defining its own copy, so both
checks always agree on the threshold.

## `app.js` changes

Inside the existing per-candidate loop (added by the prior fix), the
`candidate.url` branch gains the size check before using it:

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
  // ...existing infoHash/Real-Debrid branch, unchanged...
}
```

`createApp` gains an injectable `isLikelyPlayableSizeImpl` parameter
(defaulting to the real `isLikelyPlayableSize`), following the same
dependency-injection convention every other external call in this file
already uses.

## Error handling

- Fail-open is the entire error-handling strategy here: any inability to
  determine the real size (HEAD not supported, no `Content-Length`, network
  failure) results in the candidate being treated as fine and used — this
  check can only ever reject a candidate it has positive evidence against,
  never reject one it's merely unsure about.
- A rejected direct-URL candidate is logged and the loop moves to the next
  ranked candidate, identical in shape to the existing Real-Debrid-failure
  log line and fallback behavior.

## Testing

- `streamSizeCheck.js`: unit tests for `isLikelyPlayableSize` — a small
  `Content-Length` returns `false`; a large one returns `true`; a
  non-2xx response, a missing `Content-Length` header, and a thrown
  network error each fail open (`true`).
- `realDebrid.js`: confirm `MIN_PLAYABLE_FILE_BYTES` is still importable
  from this module with the same value (re-export works), and that its
  existing filesize-rejection tests still pass unmodified.
- `app.js`: extend `/stream/:channelId` tests to cover a direct-URL
  candidate rejected by the size check falling back to the next-ranked
  candidate, and a HEAD failure/timeout still allowing the URL through
  (fail-open).
