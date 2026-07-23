# stremioTuner — Design Spec

## Summary

stremioTuner is a Docker container that turns a user's Stremio addon catalogs into
linear "TV channels" — each with a continuous, always-in-progress program lineup —
exposed as an M3U playlist and XMLTV EPG for consumption by any IPTV player. It
mimics real broadcast TV: tuning into a channel joins whatever program is
"currently airing" mid-stream, rather than starting from the beginning.

## Goals

- Pull the user's installed Stremio addons via their Stremio account login.
- Let the user allowlist specific addon catalogs to become channels.
- Generate a continuous daily program schedule per channel, in one of two modes.
- Serve an M3U playlist and XMLTV EPG describing those channels/schedules.
- At play-time, resolve a real stream URL from the source addon, pick the best
  candidate by language/quality/peers, and serve it seeked to the correct
  "live" offset with a normalized, compatible codec/container.
- Persist schedule state so restarts don't disrupt "what's currently playing."

## Non-goals

- No built-in torrent/magnet-to-HTTP resolution — stream addons are assumed to
  already resolve via a debrid service (Real-Debrid/AllDebrid/etc.), returning
  direct HTTP-playable links.
- No multi-user support, web UI, or channel-editing UI — configuration is a
  single mounted YAML file.
- No catalog auto-discovery/auto-inclusion — channels are explicitly allowlisted.

## Architecture

Single Node.js (Express) process in one Docker container:

```
┌─────────────────────────────────────────────────────────┐
│                    stremioTuner container                 │
│                                                           │
│  ┌────────────────┐        ┌─────────────────────────┐  │
│  │ Daily Scheduler │──────▶│ /data/schedules/*.json  │  │
│  │ (cron @         │       │ (persisted state)       │  │
│  │  refreshTime)   │       └────────────┬────────────┘  │
│  └───────┬────────┘                     │               │
│          │ fetch catalogs/meta          │ read          │
│          ▼                              ▼               │
│  Stremio addon catalog/meta    ┌──────────────────────┐ │
│  endpoints (via account        │     HTTP Server      │ │
│  login)                        │  GET /playlist.m3u   │◀┼── IPTV player
│                                 │  GET /epg.xml        │◀┼── IPTV player
│                                 │  GET /stream/:chId   │◀┼── IPTV player (play)
│                                 └──────────┬───────────┘ │
│                                            │ live query  │
│                                            ▼             │
│                                 Stremio addon stream API │
│                                 (filter by lang/quality, │
│                                  pick highest peers)     │
│                                            │             │
│                                            ▼             │
│                                 ffmpeg -ss <offset>      │
│                                 -c copy (fallback:       │
│                                 transcode) -f mpegts     │
└─────────────────────────────────────────────────────────┘
```

## Configuration

Mounted `config.yml`:

```yaml
refreshTime: "00:00"        # daily schedule regeneration time (local tz, via TZ env var)
channels:
  - name: "Marvel Movies"
    addon: "https://.../manifest.json"
    catalog: "marvel-movies"       # catalog id from that addon's manifest
    mode: "random-start"           # "random-start" | "random"
    minQuality: "720p"
    language: "en"
  - name: "90s Sitcoms"
    addon: "https://.../manifest.json"
    catalog: "sitcoms-90s"
    mode: "random"
    minQuality: "480p"
    language: "en"
```

- Only catalogs explicitly listed become channels (allowlist — everything else
  from the account's addons is ignored).
- `mode`, `minQuality`, and `language` are configured per-channel.
- Stremio account credentials are supplied via env vars (`STREMIO_EMAIL`,
  `STREMIO_PASSWORD`), not the config file, since they're secrets. The
  resulting session token is cached to `/data/auth.json` to avoid re-login on
  every restart.

## Addon & catalog discovery

- On startup (and re-login on auth expiry), authenticate with the Stremio
  account API to retrieve the list of installed addons and their manifests.
- Cross-reference `config.yml`'s `addon`/`catalog` entries against that list to
  resolve each channel to a concrete catalog endpoint.

## Scheduling modes

Each channel operates in one of two modes:

- **`random-start`**: the catalog's natural item order is preserved. Each day,
  a random starting index is chosen; the lineup plays sequentially from there,
  wrapping around to the start of the catalog when it reaches the end.
- **`random`**: each lineup slot is filled by independently picking a random
  item from the catalog (repeats allowed, no fixed order).

Both modes produce a concrete, ordered list of items with resolved runtimes —
this list is what backs both the EPG and playback; nothing is decided
on-the-fly during playback itself.

## Daily schedule generation

Runs once at container start (if no valid schedule exists for "today", per
`refreshTime`) and again daily at `refreshTime`. For each channel:

1. **Fetch catalog items** from the addon's catalog endpoint.
2. **Fetch runtime metadata** for each item (addon meta endpoint, or Cinemeta
   fallback). Items with no discoverable runtime get a configurable default
   (e.g. 90 minutes).
3. **Build the day's lineup** per the channel's mode (see above).
4. **Compute absolute start/end timestamps**, chaining lineup entries
   back-to-back starting from `refreshTime`, continuing past midnight until
   the schedule covers a rolling ~24-48h window (enough for a useful EPG).
5. **Persist** to `/data/schedules/<channel-id>.json`:
   ```json
   {
     "generatedAt": "2026-07-22T00:00:00Z",
     "items": [
       { "id": "tt1234567", "title": "...", "start": "...", "end": "...", "catalogRef": {} }
     ]
   }
   ```

On restart mid-day, the server reloads this file if `generatedAt` is still
"today" (per `refreshTime`), so the current program and EPG stay consistent
rather than re-rolling on every restart.

## Serving

**`GET /playlist.m3u`** — one entry per configured channel:

```
#EXTM3U
#EXTINF:-1 tvg-id="marvel-movies" tvg-name="Marvel Movies" group-title="stremioTuner",Marvel Movies
http://<host>:<port>/stream/marvel-movies
```

**`GET /epg.xml`** — XMLTV built from each channel's persisted schedule
(`items[].start/end/title`), covering the same rolling window as the schedule.
Regenerated whenever the schedule regenerates.

**`GET /stream/:channelId`** — the live playback path:

1. Load the channel's persisted schedule; find the item whose `[start, end)`
   window contains "now"; compute `offset = now - start`.
2. Call the source addon's stream endpoint for that item to get stream
   candidates (each carrying language/quality/peers info in its
   title/description, Torrentio-style).
3. Filter to candidates matching the channel's language preference and
   minimum quality; if none qualify, relax the quality floor but keep the
   language filter; from the remaining set, pick the one with the most peers.
4. Spawn `ffmpeg -ss <offset> -i <resolved_url> -c copy -f mpegts pipe:1`,
   streaming stdout as the HTTP response (`video/MP2T`).
5. If `-c copy` fails to produce output (incompatible codec/container for
   remux), retry once with a full transcode
   (`-c:v libx264 -c:a aac -f mpegts pipe:1`).
6. When the current item ends, the connecting IPTV player is expected to
   re-request the stream (typical player behavior at stream end); the
   endpoint re-resolves "now" fresh on every new connection — no long-lived
   session state.

## Stream selection rules

Per channel config (`minQuality`, `language`):

1. Filter candidates by language match AND minimum quality.
2. If empty, relax the quality floor but keep the language filter.
3. From the surviving candidates, pick the one with the highest peer count.
4. If still empty (no candidates match language at all), skip this item and
   advance to the next item in the schedule.

## Persistence layout (`/data`, mounted volume)

- `/data/config.yml` — channel definitions (can be read-only mounted)
- `/data/schedules/<channel-id>.json` — daily generated lineups
- `/data/auth.json` — cached Stremio session token

## Docker packaging

- Node.js base image with `ffmpeg` installed (required for the stream proxy).
- Exposes one HTTP port (`PORT` env var, default e.g. 8080).
- Env vars: `STREMIO_EMAIL`, `STREMIO_PASSWORD`, `PORT`, `TZ` (so
  `refreshTime` means something consistent).
- Single entrypoint process: HTTP server + in-process daily cron
  (e.g. `node-cron`) for schedule regeneration.

## Error handling

- **Catalog/addon fetch fails during schedule generation:** keep serving the
  previous day's persisted schedule for that channel rather than going empty;
  log the failure.
- **Stremio login fails at startup:** retry with backoff; server still starts
  and serves any previously-persisted schedules/EPG; logs a clear error since
  new schedules can't be generated until login succeeds.
- **No stream candidates satisfy even the relaxed rule at play-time:** skip to
  the next scheduled item's stream; if truly nothing is playable, return an
  HTTP error so the player shows "unavailable" instead of hanging.
- **ffmpeg crashes mid-stream:** log and end the response; the player is
  expected to retry the request, which re-resolves fresh.

## Testing approach

- Unit tests for: schedule generation (both modes, timestamp chaining,
  wraparound), stream candidate filtering/selection logic, XMLTV/M3U
  generation from a schedule fixture.
- Integration-style tests against a mocked Stremio addon (fixture
  manifest/catalog/meta/stream responses) to validate the end-to-end
  schedule-generation → EPG/M3U → stream-selection pipeline without hitting
  real addons.
- Manual verification: point a real IPTV player (e.g. VLC or an IPTV client)
  at `/playlist.m3u` and confirm mid-program join and channel switching feel
  right against a real Stremio account/addon.
