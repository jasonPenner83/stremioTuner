# Per-Channel Stream Addon Dropdown & Channel Delete — Design Spec

## Summary

Two related improvements to the "My channels" admin UI:

1. The per-channel "Stream addon" override field (currently free-text, in
   both the channels table and the add-channel form) becomes the same kind
   of dropdown already built for the global default stream addon, populated
   from the user's installed addons. The add-channel form additionally
   defaults that dropdown to the catalog's own addon when that addon also
   supports streams, instead of defaulting to "None".
2. Channels gain a real delete action (distinct from the existing
   enable/disable toggle, which keeps the record).

## Problem

- Typing a per-channel stream-addon id by hand has the same error-prone
  drawback the global default field had before it became a dropdown.
- When adding a channel from a catalog whose own addon *also* provides
  streams (e.g. an addon offering both catalog and stream resources), the
  user has to know to type that same addon's id again into the stream-addon
  field, even though the obvious choice is already known.
- There is currently no way to remove a channel — only enable/disable
  (which keeps the record in `channels.json` forever).

## Goals

- Per-channel stream-addon override becomes a dropdown, in both the
  channels table and the add-channel form, reusing the existing
  `GET /admin/addons` endpoint and the same stale-value safety net the
  global default dropdown already has.
- The add-channel form's dropdown defaults to the catalog's own addon when
  that addon's manifest declares support for the `stream` resource.
- A "Delete" action per channel that permanently removes the record, with a
  confirmation prompt before it happens.

## Non-goals

- No change to the global default dropdown's own behavior (already built).
- No schedule-file cleanup on delete — an orphaned
  `/data/schedules/<id>.json` for a deleted channel is harmless and never
  read again (consistent with how disabling already leaves it in place).
- No "undo delete" — the confirmation prompt is the only safeguard.

## `GET /admin/addons` — extended response shape

`settingsActions.listAddons()` gains a per-addon `supportsStreams: boolean`,
computed from the addon's manifest `resources` field. Stremio manifests
declare `resources` as either an array of resource-name strings
(`["catalog", "stream"]`) or an array of resource descriptor objects
(`[{name: "stream", types: [...], idPrefixes: [...]}, ...]`) — a new helper
handles both forms:

```js
function manifestSupportsStreamResource(manifest) {
  return (manifest.resources || []).some((r) => (typeof r === 'string' ? r : r.name) === 'stream');
}
```

Response shape:

```json
{
  "degraded": false,
  "addons": [
    { "id": "org.torrentio", "name": "Torrentio", "supportsStreams": true },
    { "id": "org.cinemeta", "name": "Cinemeta", "supportsStreams": false }
  ]
}
```

This is purely additive to the existing shape — nothing currently consuming
`/admin/addons` breaks.

## Admin UI: shared dropdown helper

A new `addonOptionsHtml(addons, current)` function in `public/admin.js`
factors out the option-building logic the global default dropdown's
`loadSettings()` already has (None + one option per addon + the
stale-value safety net: if `current` doesn't match any `addons[].id`, add a
synthetic `"<current> (not currently installed)"` option and select it
rather than falling back to "None"). `loadSettings()` is updated to call
this shared helper instead of its inline version.

`loadSettings()` also caches the fetched `/admin/addons` result in a
module-level variable (e.g. `let addonsCache = {degraded: false, addons: []}`)
so `loadChannels()` and `loadCatalogs()`/`catalogRowHtml()` (both called
after `loadSettings()` in `loadAll()`) can read it without a second fetch.

## "My channels" table — dropdown

In `loadChannels()`'s row template, the per-channel stream-addon
`<input type="text" data-field="streamAddon">` becomes:

```html
<td><select data-field="streamAddon"${addonsCache.degraded ? ' disabled' : ''}>${addonOptionsHtml(addonsCache.addons, ch.streamAddon || '')}</select></td>
```

No change is needed to the row's generic change-listener wiring — the
existing selector (`'select, input[type=checkbox], input[type=text]'`)
already matches `select` elements, so this PATCHes exactly as the text
input did.

## Add-channel form — dropdown with smart default

In `catalogRowHtml()`'s form template, the stream-addon
`<input type="text" data-field="streamAddon">` becomes a `<select>` built
from the same `addonOptionsHtml` helper. The default (`current`) value is:

- `cat.addon` — if the catalog's own addon is found in `addonsCache.addons`
  with `supportsStreams: true`.
- `''` (None) — otherwise (addon not found, or `supportsStreams: false`).

The submit handler reads `.value` off the `<select>` exactly as it read
`.value` off the text input before — no other change needed there.

## Channel delete

**Backend:**
- `channelActions.js` gains `deleteChannel(id)`:
  1. Read persisted channels; if no record matches `id`, throw the existing
     `NotFoundError`.
  2. Write the persisted list with that record filtered out.
  3. If the channel is currently in the live `channels` array, splice it
     out.
  4. Return nothing meaningful (the route responds with a bare success
     status).
- `createChannelActions(...)`'s returned object gains `deleteChannel`
  alongside the existing four functions.
- `adminRoutes.js` gains `router.delete('/channels/:id', ...)`: calls
  `channelActions.deleteChannel(id)`, responds `204 No Content` on success,
  `404` (existing `NotFoundError` → 404 pattern) if the id doesn't exist,
  `500` on any other error — same conventions as the existing `/channels`
  routes.

**Admin UI:**
- `loadChannels()`'s row template gains a "Delete" button:
  `<button data-action="delete-channel">Delete</button>` in a new table
  cell.
- A new click handler (wired once per `loadChannels()` render, alongside
  the existing generic change-listener wiring): on click, reads the row's
  name from the row's own first `<td>` (`row.children[0].textContent`,
  already the rendered, escaped channel name), shows
  `confirm('Delete channel "<name>"? This cannot be undone.')`, and if
  confirmed, sends `DELETE /admin/channels/<id>` then calls `loadAll()` to
  refresh.

## Error handling

- `DELETE /admin/channels/:id` for an unknown id → `404`, same
  `NotFoundError` pattern as `PATCH /admin/channels/:id`.
- Declining the `confirm()` prompt performs no request at all.
- A degraded `/admin/addons` response disables every stream-addon dropdown
  on the page (global setting, channels table, and add-channel forms) and
  shows the existing banner — consistent with the global dropdown's
  existing degraded handling.

## Testing

- `settingsActions.js`: extend `listAddons()` tests to cover
  `manifestSupportsStreamResource` against both the string-array and
  object-array manifest `resources` forms, and an addon with no
  `resources` field at all (must not throw, `supportsStreams: false`).
- `channelActions.js`: unit tests for `deleteChannel` — removes from
  persisted list, removes from the live array when present, is a no-op on
  the live array when the channel was already disabled/not live, and
  throws `NotFoundError` for an unknown id.
- `adminRoutes.js`: tests for `DELETE /admin/channels/:id` — 204 on
  success, 404 on `NotFoundError`, 500 on an unexpected error.
- Admin UI: manual verification only, per this project's existing
  convention for the static admin page.
