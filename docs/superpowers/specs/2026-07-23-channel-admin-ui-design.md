# Channel Admin UI — Design Spec

## Summary

Replace stremioTuner's hand-edited `config.yml` channel list with a small
web UI (served by the same Express app, same port) that lets the user
browse their live Stremio catalogs, add channels by picking from that
list, and enable/disable/edit channels — all taking effect immediately,
without a container restart.

## Goals

- Browse every catalog from every addon actually installed on the user's
  Stremio account, live, without typing addon/catalog ids by hand.
- Add a catalog as a channel from the UI, with per-channel mode/minimum
  quality/language, defaulting to sensible values but editable before
  and after creation.
- Enable/disable a channel from the UI; the change applies immediately —
  a newly-enabled channel's schedule is generated and it appears in
  `/playlist.m3u`/`/epg.xml` within moments; a disabled one disappears
  immediately from both, and `/stream/:channelId` stops serving it.
- Persist the channel list (including disabled entries, so re-enabling
  doesn't lose settings) across restarts.
- No authentication on the admin UI/API — same trust model as the rest
  of the app (personal use on a home LAN).

## Non-goals

- No full channel deletion (only enable/disable) in this pass.
- No automated UI/browser tests — the static HTML/JS page is verified
  manually; only the backend admin API gets automated tests.
- No multi-user support or per-user channel lists.

## Migration away from YAML

`config.yml`, `config.example.yml`, `src/config.js`, `test/config.test.js`,
and the `js-yaml` dependency are all removed. They are replaced by:

- **`REFRESH_TIME` env var** (default `"00:00"`) — the one global setting
  `config.yml` used to hold.
- **`/data/channels.json`** — the full channel list (enabled and disabled),
  written by the admin API, read by the scheduler/bootstrap at startup.

Example `channels.json` entry:

```json
{
  "id": "org-stremio-torrentio-addon-marvel-movies",
  "addonId": "org.stremio.torrentio.addon",
  "catalogId": "marvel-movies",
  "name": "Marvel Movies",
  "mode": "random-start",
  "minQuality": "720p",
  "language": "en",
  "enabled": true
}
```

`id` is derived from `slugify(addonId + ':' + catalogId)` — stable across
channel renames, unlike the old name-derived id.

## Architecture

Same single Express process, extended with an admin API and a static UI
page, all on the same port:

```
┌─────────────────────────────────────────────────────────┐
│                    stremioTuner container                 │
│                                                           │
│  ┌────────────────┐     ┌──────────────────────────┐    │
│  │ Daily Scheduler │────▶│ /data/schedules/*.json   │    │
│  └───────┬────────┘     └──────────────┬───────────┘    │
│          │                              │                │
│          ▼                              ▼                │
│  ┌────────────────────────────────────────────────────┐ │
│  │         In-memory channel registry (array)          │ │
│  │  [{id, name, addonId, catalogId, mode, minQuality,  │ │
│  │    language, source}, ...]  ← only ENABLED channels │ │
│  └───────┬───────────────────────────────┬─────────────┘ │
│          │ read/write                     │ read only     │
│          ▼                                ▼                │
│  /data/channels.json              GET /playlist.m3u        │
│  (all channels, incl.             GET /epg.xml              │
│   disabled ones, persisted)       GET /stream/:channelId    │
│          ▲                                                  │
│          │                                                  │
│  ┌───────┴────────────────────────────────┐                │
│  │  Admin API (same Express app)           │◀── browser UI │
│  │  GET  /admin/catalogs  (live Stremio)   │                │
│  │  GET  /admin/channels                   │                │
│  │  POST /admin/channels                   │                │
│  │  PATCH /admin/channels/:id              │                │
│  └──────────────────────────────────────────┘               │
│                                                              │
│  GET /  → static admin UI (single HTML+JS page)             │
└─────────────────────────────────────────────────────────────┘
```

**Key mechanism for "applies immediately":** the same JS array object
flows from `bootstrap.js` into `createApp`. Admin routes mutate that
array in place (push/splice/field-update) rather than replacing it, so
`/playlist.m3u`, `/epg.xml`, and `/stream/:channelId` see changes on
their very next request — no restart, no polling, no extra plumbing.

## Admin API

- **`GET /admin/catalogs`** — fetches installed addons live (reusing the
  cached Stremio `authKey`), flattens every addon's `manifest.catalogs[]`,
  and cross-references `channels.json` to mark which are already added.
  Returns:
  ```json
  [{ "addonId": "org.stremio.torrentio.addon", "addonName": "Torrentio", "catalogId": "marvel-movies", "catalogName": "Marvel Movies", "type": "movie", "channelId": "org-stremio-torrentio-addon-marvel-movies" }]
  ```
  `channelId` is `null` if this catalog hasn't been added yet.
  If Stremio login/addon-discovery is currently degraded (per the existing
  retry/graceful-degradation behavior), this returns `{ degraded: true, catalogs: [] }`
  instead of erroring, so the UI can show a banner rather than a hard failure.
- **`GET /admin/channels`** — returns the full contents of `channels.json`
  (enabled and disabled), for rendering the toggle list.
- **`POST /admin/channels`** — body `{addonId, catalogId, name, mode,
  minQuality, language}`. Resolves the addon source (using the same
  addon-source-resolution helper `bootstrap.js` uses internally — extracted
  so it's shared, not duplicated), generates the first schedule, persists
  to `channels.json` with `enabled: true`, pushes into the live in-memory
  array, returns the new record. Returns `400` if the addon/catalog can't
  be resolved (addon not installed, or catalog not in that addon's
  manifest) — nothing is persisted in that case.
- **`PATCH /admin/channels/:id`** — body is a partial update:
  `{enabled?, mode?, minQuality?, language?}`. Returns `404` for an
  unknown `id`.
  - `enabled: true→false`: remove from the live in-memory array (channel
    disappears from playlist/EPG/stream immediately); the record (with
    all its settings) stays in `channels.json`.
  - `enabled: false→true`: re-resolve source, generate a fresh schedule,
    re-add to the live array.
  - Changing `mode`/`minQuality`/`language` on an already-enabled channel:
    update the in-memory object's fields in place, regenerate its
    schedule immediately (a mode change affects the lineup).

No `DELETE` endpoint — disabling is the only removal action in this pass.

## UI

A single static page (plain HTML + vanilla JS, no framework, no build
step) served at `GET /` — the root path becomes the admin UI's home,
since `/playlist.m3u`/`/epg.xml`/`/stream/:id` are for IPTV players, not
browsers.

Two sections on one page:
- **"Available catalogs"** — the live list from `/admin/catalogs`, each
  with an "Add channel" button (opens a small inline form: name, mode
  dropdown, quality dropdown, language dropdown, pre-filled with defaults
  `mode: "random-start"`, `minQuality: "720p"`, `language: "en"`) for
  catalogs not yet added; already-added ones show their current toggle
  state instead of an "Add" button.
- **"My channels"** — the list from `/admin/channels`, each row showing
  name/mode/quality/language with an enable/disable toggle switch and
  inline-editable mode/quality/language dropdowns (calling `PATCH` on
  change).

No authentication — same trust model as the rest of the app.

## bootstrap.js changes

- Reads `REFRESH_TIME` from env instead of `config.yml`'s `refreshTime`.
- Loads the initial channel list from `channelStore` (only `enabled: true`
  entries go into the live in-memory array) instead of `loadConfig`.
- Resolves each enabled channel's source and generates stale schedules
  exactly as today — unchanged.
- The daily cron's existing null-source re-resolution logic is reused
  as-is. The "resolve one channel's source" helper `bootstrap.js` already
  has internally is extracted so both the cron path and the new admin
  routes call the same function rather than duplicating it.

## Error handling

- `POST /admin/channels` with an unresolvable `addonId`/`catalogId` →
  `400`, clear message, nothing persisted.
- `PATCH /admin/channels/:id` for an unknown `id` → `404`.
- `GET /admin/catalogs` during a Stremio login/discovery outage → returns
  `{ degraded: true, catalogs: [] }` instead of a hard error.
- Schedule generation failure for a channel being enabled/edited via the
  admin API → same per-channel try/catch/log pattern already used
  elsewhere; the API call still succeeds (the channel is added/updated),
  but a clear error is logged and the channel simply has no schedule yet
  until the next successful generation attempt (same as any other
  generation failure in the existing system).

## Testing

- `channelStore.js`: unit tests mirroring `scheduleStore.js`'s patterns
  (read/write/CRUD with injectable `fs`).
- Admin routes: real-HTTP tests in the same style as `app.test.js` (spin
  up the app, hit `/admin/*` endpoints, assert the live in-memory array
  actually changes — e.g. after `PATCH .../enabled:false`, a subsequent
  `/playlist.m3u` request no longer lists that channel).
- The static HTML/JS UI itself: **manual verification only** (open it in
  a browser, click through add/toggle/edit) — no browser-test framework
  is introduced, consistent with keeping the dependency list minimal.
