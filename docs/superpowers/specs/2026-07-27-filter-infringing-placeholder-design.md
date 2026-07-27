# Filter Out Real-Debrid Infringement Placeholders — Design Spec

## Summary

Real-Debrid silently replaces a DMCA-flagged cached file with a small
placeholder video (red background, white text) instead of erroring —
`unrestrict/link` succeeds normally, so stremioTuner has no signal today
that anything went wrong; the placeholder just plays as if it were the real
content. This spec detects that case by file size and automatically falls
back to the next-best stream candidate instead of serving the placeholder.

## Problem

- `resolveStream`'s Real-Debrid calls never fail for a takedown-blocked
  file — `unrestrict/link` returns a normal, valid download URL, just for
  a few-MB placeholder clip rather than the actual movie/episode.
- `app.js`'s `/stream/:channelId` handler only ever resolves the single
  best-ranked candidate (`selectStream`); there's no mechanism to try a
  second candidate even if one were known to be bad.

## Goals

- Detect a Real-Debrid-resolved file that's implausibly small to be real
  content (a placeholder), by checking Real-Debrid's own reported
  `filesize`.
- When detected, automatically try the next-best stream candidate (by the
  existing peers/quality/language ranking) instead of serving the
  placeholder or failing outright.
- Preserve all existing selection/resolution behavior for the common case
  where the first candidate is fine (no behavior change, same 502 on total
  failure).

## Non-goals

- No caching/remembering "known bad" info-hashes across requests — each
  request re-derives candidates and re-checks; Real-Debrid's existing
  reuse-by-hash keeps repeat checks cheap (no re-adding the magnet).
- No configurability for the size threshold in this pass — a single
  constant (50MB) is used, chosen to be safely above any known Real-Debrid
  placeholder size and comfortably below any realistic low-quality
  episode/movie file.
- No changes to quality/language ranking logic itself — only how many
  candidates get *tried*, not how they're *ordered*.

## `streamSelect.js` changes

New `rankStreams(streams, {minQuality, language})`: same parsing/filtering
logic `selectStream` already has, but returns the full ordered list instead
of just the top pick — the existing two-tier behavior (strict
quality+language matches, ranked by peers, falling back to a
language-only-relaxed tier only if the strict tier is empty) becomes "sort
each tier by peers descending, concatenate strict-tier then relaxed-tier"
rather than "reduce to the single highest-peer entry in whichever tier is
non-empty."

`selectStream` becomes:

```js
export function selectStream(streams, opts) {
  const ranked = rankStreams(streams, opts);
  return ranked[0] ?? null;
}
```

This keeps `selectStream`'s existing behavior and all its existing tests
passing unmodified — `rankStreams(...)[0]` is exactly what `selectStream`
already returned via `maxByPeers`.

## `realDebrid.js` changes

- `unrestrictLink` returns `{ download, filesize }` (Real-Debrid's
  `/unrestrict/link` response already includes `filesize`) instead of just
  the download URL string.
- A new constant `MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024` (50MB).
- `resolveStream` checks the returned `filesize` against
  `MIN_PLAYABLE_FILE_BYTES` after unrestricting (on both of its two
  existing return paths — the reuse-by-hash path and the
  add/select/unrestrict path) and throws
  `` `Resolved file too small (likely a takedown placeholder): ${filesize} bytes` ``
  instead of returning it, so the caller can treat it exactly like any
  other resolution failure and move on to the next candidate.

## `app.js` changes

Replace the current "pick one candidate via `selectStream`, resolve it,
502 on any failure" flow with a loop over `rankStreams(...)`:

```
candidates = rankStreams([...direct, ...magnetCandidates], {minQuality, language})
for each candidate in candidates (in order):
  if candidate.url: use it, done
  else (candidate.infoHash):
    try: finalUrl = resolveStreamImpl(apiKey, candidate.infoHash, {season, episode})
         done
    catch: log "Real-Debrid resolution failed for a candidate, trying next: <message>"
           continue to next candidate
if no candidate produced a playable URL: 502 "No playable stream found" (unchanged)
```

Direct-`url` candidates are never sent through Real-Debrid and therefore
can't be a Real-Debrid placeholder — they're used as-is the moment they're
reached in the ranked list, exactly as `selectStream` already treated them
as immediately usable.

## Error handling

- Every per-candidate Real-Debrid failure (network error, non-2xx
  response, or the new too-small check) is logged and treated identically
  — move to the next candidate. There's no special-cased retry or backoff
  for the "too small" case specifically; it's just another reason a
  candidate didn't pan out.
- If every ranked candidate fails (or none exist), the response is the
  same `502 "No playable stream found"` as today — no change to the
  external contract for total failure.

## Testing

- `streamSelect.js`: add tests for `rankStreams` returning candidates in
  descending-peers order within a tier, and strict-tier candidates all
  ranked ahead of relaxed-tier ones. Existing `selectStream` tests continue
  to pass unmodified (verifying the thin-wrapper refactor didn't change
  behavior).
- `realDebrid.js`: extend `resolveStream` tests to cover a `filesize` under
  the threshold throwing the too-small error (via both the reuse-by-hash
  path and the fresh add/select/unrestrict path), and a `filesize` at or
  above the threshold resolving normally.
- `app.js`: extend `/stream/:channelId` tests to cover: the top candidate
  failing Real-Debrid resolution (network-style error) and the next
  candidate succeeding; the top candidate resolving to a too-small file and
  the next candidate succeeding; and all candidates failing still producing
  the existing 502.
