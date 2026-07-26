# Global Default Stream Addon — Design Spec

## Summary

Currently each channel must have its own `streamAddon` set (per-channel text
field in the admin UI) to get magnet/Real-Debrid stream resolution — every
channel otherwise falls back to its catalog addon, which usually has no
stream resource (e.g. Cinemeta). In practice, the same stream addon (e.g.
"TorrentioRD") is wanted for nearly every channel. This spec adds a single
global default stream addon, configured once in the admin UI, that every
channel uses unless it sets its own override.

## Problem

Requiring every channel to repeat the same `streamAddon` value is repetitive
and error-prone (typo the addon id once, get it wrong for every channel).
There's no single place to set "this is what I always want."

## Goals

- A single global default stream addon, configured once via the admin UI.
- Per-channel `streamAddon` still works and takes priority when set — an
  explicit override, not a replacement for the global default.
- Changing the global default takes effect immediately for every channel
  that relies on it (no restart, no per-channel re-save).

## Non-goals

- No ordered/prioritized list of fallback stream addons — a single default
  only (per decision; can revisit later if needed).
- No env-var configuration path for the default — admin UI only, consistent
  with how channels themselves are managed (persisted to `/data`, editable
  live).
- No change to the RD API key, quality/language selection, or any other
  part of the existing Real-Debrid resolution flow — this only changes how
  a channel's `streamSource` addon id is chosen.

## Resolution order

For a given channel, the addon queried for streams is chosen in this order:

1. `channel.streamAddon` (per-channel override), if set.
2. The global default stream addon (`settings.defaultStreamAddon`), if set.
3. Neither set → `streamSource` is `null`, and the existing fallback to
   `channel.source` (the catalog addon) applies, exactly as today.

## Configuration changes

- **New `/data/settings.json`**, written by a new admin API, read at
  startup:
  ```json
  { "defaultStreamAddon": "org.stremio.torrentiorexpanded.addon" }
  ```
- **`src/settingsStore.js`** (new, mirrors `channelStore.js`'s
  `readChannels`/`writeChannels` pattern): `readSettings(dataDir)` (returns
  `{}` on a missing file, same ENOENT-tolerant pattern as `readChannels`
  returning `[]`) and `writeSettings(dataDir, settings)`.

## Architecture

```
bootstrap.js
  const settings = await readSettingsImpl(dataDir);   // {} if no file yet — mutated in place, never reassigned

  function resolveStreamSource(channel, installedAddons) {
    const streamAddon = channel.streamAddon || settings.defaultStreamAddon;
    if (!streamAddon) return null;
    ...unchanged lookup/error-handling...
  }

  const settingsActions = createSettingsActionsImpl({
    dataDir, settings, channels, discoverInstalledAddons,
    resolveStreamSourceImpl: resolveStreamSource,
    readSettingsImpl, writeSettingsImpl
  });
```

`settings` is held as one mutable object and captured by the
`resolveStreamSource` closure — the same "shared object flows so changes
apply immediately" pattern the existing `channels` live array already uses
(see the channel-admin-ui design spec's "Key mechanism" section). Nothing
ever reassigns `settings`; `updateSettings` mutates its fields via
`Object.assign`.

### `src/settingsActions.js` (new)

- **`getSettings()`** → `readSettingsImpl(dataDir)`.
- **`updateSettings(patch)`**:
  1. Validate `patch.defaultStreamAddon` is a string or `null` (empty
     string normalizes to `null` — "no default set").
  2. Persist the merged settings to `/data/settings.json`.
  3. `Object.assign(settings, updated)` — mutate the shared live object.
  4. Re-resolve `streamSource` for every live channel with no per-channel
     `streamAddon` override (`!channel.streamAddon`), using a fresh
     `discoverInstalledAddons()` call, so the new default takes effect on
     every channel that relies on it without any further action.
  5. Return the updated settings.

No schedule regeneration is needed here — `streamSource` only affects
play-time stream fetch, not catalog-based schedule generation.

## `channelActions.js` changes

`addChannel`/`updateChannel` already call `resolveStreamSourceImpl`
(bootstrap's closure) for stream-source resolution. Both currently guard
that call behind `streamAddon ? resolveStreamSourceImpl(...) : null` —
skipping resolution entirely when the channel has no per-channel override.
That guard is removed: `resolveStreamSourceImpl` is now called
unconditionally (it internally decides whether the global default applies
and returns `null` if neither is set), so a channel added with no
`streamAddon` still picks up whatever the global default currently is.

## `bootstrap.js` daily-cron re-resolution

The existing re-resolution condition:
```js
channel.streamAddon && !channel.streamSource
```
becomes:
```js
(channel.streamAddon || settings.defaultStreamAddon) && !channel.streamSource
```
so a channel relying solely on the global default still gets retried on the
daily cron if resolution failed at startup (e.g. addon discovery was down).

## Admin API

- **`GET /admin/settings`** → `{ defaultStreamAddon: string | null }`.
- **`PATCH /admin/settings`** → body `{ defaultStreamAddon }`. Returns the
  updated settings object. `400` on an invalid type (not a string/null).

`createAdminRouter` takes a second argument: `createAdminRouter(channelActions, settingsActions)`.

## Admin UI

A small "Global settings" section, placed above "My channels": a single
text input ("Default stream addon") pre-filled from `GET /admin/settings`,
with a Save button that `PATCH`es `/admin/settings`.

The existing per-channel stream-addon input's placeholder text changes from
`"Stream addon ID (optional, e.g. org.stremio.torrentio.addon)"` to
`"Stream addon ID (optional — overrides the global default)"`, in both the
add-channel form and the per-channel table row, to make the relationship
clear.

## Error handling

- `PATCH /admin/settings` with a non-string/non-null `defaultStreamAddon` →
  `400`, nothing persisted (mirrors `channelActions`'s existing
  `ValidationError` → `400` pattern).
- An unresolvable `defaultStreamAddon` (addon id not currently installed)
  behaves exactly like an unresolvable per-channel `streamAddon` does
  today: `resolveStreamSource` catches the lookup failure, logs it, returns
  `null` — the channel falls back to its catalog addon, no crash.

## Testing

- `settingsStore.js`: unit tests mirroring `channelStore.js`'s
  read/write tests (including the ENOENT-returns-`{}` case).
- `settingsActions.js`: unit tests covering `getSettings`, `updateSettings`
  validation, persistence, live-object mutation, and re-resolution of
  `streamSource` on every affected live channel (and confirming a channel
  with its own `streamAddon` override is left untouched by a default
  change).
- `bootstrap.js`: extend existing tests to cover a channel resolving
  `streamSource` from the global default when it has no per-channel
  override, and per-channel override still winning when both are set.
- `channelActions.js`: extend existing tests to confirm `addChannel`/
  `updateChannel` now call `resolveStreamSourceImpl` unconditionally (a
  channel added with no `streamAddon` still gets a resolved `streamSource`
  when a default is configured).
- `adminRoutes.js`/`app.test.js`: cover the two new routes.
