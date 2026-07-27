# Global Default Stream Addon Dropdown — Design Spec

## Summary

The "Default stream addon" field in the admin UI's Global settings section is
currently a free-text input (the user must know and correctly type an addon
id, e.g. `org.stremio.torrentiorexpanded.addon`). This spec replaces it with
a dropdown populated from the user's actual installed Stremio addons.

## Problem

Typing an addon id by hand is error-prone (typos silently produce a
never-resolving default) and requires the user to already know the exact id
string. The existing `/admin/catalogs` endpoint can't back this dropdown
directly — it only lists addons that have catalogs, and a pure stream addon
like Torrentio typically declares none.

## Goals

- A dropdown for the "Default stream addon" field, populated with every
  installed Stremio addon (not just catalog-bearing ones).
- Graceful behavior when Stremio addon discovery is degraded (same pattern
  the catalogs list already uses).
- Never silently discard a saved default that refers to an addon no longer
  installed.

## Non-goals

- The per-channel "Stream addon" override field (table row + add-channel
  form) stays a free-text input — not in scope for this change.
- No change to how the default is resolved/applied server-side (that's
  already built) — this is purely about how it's selected in the UI.

## New admin API

**`GET /admin/addons`** — new route, backed by a new `listAddons()` action
in `settingsActions.js` (which already has `discoverInstalledAddons`
injected). Mirrors `channelActions.listCatalogs()`'s degraded-state shape:

```json
{ "degraded": false, "addons": [{ "id": "org.stremio.torrentiorexpanded.addon", "name": "Torrentio" }] }
```

`degraded: true` (with `addons: []`) when Stremio login/addon discovery is
currently unavailable — same condition `listCatalogs()` already checks.

## Admin UI changes

- `public/index.html`: the `<input type="text" id="default-stream-addon">`
  becomes a `<select id="default-stream-addon">`.
- `public/admin.js`:
  - `loadSettings()` now also fetches `/admin/addons` and populates the
    `<select>`: a first "None" option (value `""`), then one `<option>` per
    installed addon (`value=id`, label=`name`), then selects whichever
    value matches the current `defaultStreamAddon`.
  - If `/admin/addons` reports `degraded: true`: show the existing banner
    ("Could not reach your Stremio account right now — catalog list
    unavailable." — reuse this banner, since it's the same underlying
    condition) and disable the `<select>` (`disabled = true`) so the user
    can't save a blind guess.
  - **Stale-selection safety**: if the currently-saved `defaultStreamAddon`
    is non-empty but doesn't match any returned addon's `id`, add one extra
    `<option>` for it before selecting, labeled
    `"<id> (not currently installed)"`, and select that instead of falling
    through to "None". This prevents the dropdown from silently displaying
    "None" (and a subsequent Save silently clearing a real saved value)
    just because that addon happens to be temporarily uninstalled or
    discovery is briefly out of sync.
  - `wireSettingsForm()`'s save handler is unchanged in spirit (`PATCH
    /admin/settings` with `{defaultStreamAddon: value || null}`) — it just
    reads `.value` off a `<select>` instead of a text `<input>` now, which
    is the same property access, so no logic change there.

## Error handling

- `GET /admin/addons` failing/erroring server-side → `500`, same pattern as
  every other admin route.
- `degraded: true` → banner + disabled dropdown (not an error status; same
  as `listCatalogs()`'s existing degraded contract).

## Testing

- `settingsActions.js`: unit tests for `listAddons()` — degraded case
  (`discoverInstalledAddons` returns `null` → `{degraded: true, addons:
  []}`), and the normal case flattening `installedAddons` into
  `{id, name}` pairs.
- `adminRoutes.js`: a test proxying `GET /admin/addons` to
  `settingsActions.listAddons()`.
- `app.js`: one test confirming `/admin/addons` is reachable through
  `createApp` when `settingsActions` is provided (mirroring the existing
  `/admin/settings` reachability test).
- Admin UI: manual verification only, per this project's existing
  convention for the static admin page.
