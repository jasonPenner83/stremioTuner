# Per-Channel Stream Addon Dropdown & Channel Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the per-channel "Stream addon" override into a dropdown (in both the "My channels" table and the "Add channel" form), reusing the global default's dropdown pattern and adding a smart default when the catalog's own addon also supports streams. Add a real channel delete action, distinct from the existing enable/disable toggle.

**Architecture:** `settingsActions.listAddons()` gains a `supportsStreams` flag per addon (computed from the addon's manifest `resources`). The admin UI factors its option-building logic into one shared `addonOptionsHtml(addons, current)` helper, used by the existing global-default dropdown and the two new per-channel dropdowns. `channelActions.js` gains `deleteChannel(id)`, exposed via a new `DELETE /admin/channels/:id` route, wired to a "Delete" button + `confirm()` prompt in the UI.

**Tech Stack:** Node.js/Express (no new dependencies), `node:test`/`node:assert`, vanilla JS admin UI.

## Global Constraints

- No new npm dependencies.
- `listAddons()`'s `supportsStreams` must correctly handle both Stremio manifest `resources` shapes: an array of strings (`["catalog", "stream"]`) and an array of descriptor objects (`[{name: "stream", ...}]`), and must not throw when `resources` is absent entirely.
- One pre-existing test in `test/settingsActions.test.js` needs its expected fixture UPDATED (not just left alone) to include the new `supportsStreams` field — this is a plan-mandated, additive fixture update (the addons in that test's fixture have no `resources` field, so `supportsStreams: false` for both), not a behavior contradiction like a prior plan's test replacement.
- `deleteChannel` must remove the record from BOTH the persisted list and the live `channels` array (when present) — same dual-state pattern `updateChannel`'s `enabled: false` path already uses.
- No schedule-file cleanup on delete (explicitly out of scope per the design).
- The per-channel dropdowns and the global dropdown must share one option-building helper (`addonOptionsHtml`) — do not duplicate the "None" + stale-value-safety-net logic a second or third time.
- Follow existing code style: named exports, injectable `*Impl` params, `node:test` + `node:assert/strict`, existing `escapeHtml`/`fetchJson`/banner conventions in `admin.js`.

---

### Task 1: `settingsActions.listAddons()` — `supportsStreams`

**Files:**
- Modify: `src/settingsActions.js`
- Test: `test/settingsActions.test.js`

**Interfaces:**
- Produces: `listAddons()`'s `addons` entries gain a `supportsStreams: boolean` field, alongside the existing `id`/`name`.

`src/settingsActions.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Update the existing test's fixture, then write the new failing tests**

In `test/settingsActions.test.js`, find the test `'listAddons flattens every installed addon into id/name pairs, regardless of catalogs'`. Update its expected `result` to include the new field (the fixture's manifests have no `resources` field, so both entries are `false`):

```js
test('listAddons flattens every installed addon into id/name pairs, regardless of catalogs', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.torrentio', name: 'Torrentio', catalogs: [] }, transportUrl: 'https://torrentio/manifest.json' },
      { manifest: { id: 'org.cinemeta', name: 'Cinemeta', catalogs: [{ id: 'top', type: 'movie' }] }, transportUrl: 'https://cinemeta/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.deepEqual(result, {
    degraded: false,
    addons: [
      { id: 'org.torrentio', name: 'Torrentio', supportsStreams: false },
      { id: 'org.cinemeta', name: 'Cinemeta', supportsStreams: false }
    ]
  });
});
```

Then add three new tests after it:

```js
test('listAddons reports supportsStreams: true when manifest.resources is an array of strings including "stream"', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.torrentio', name: 'Torrentio', resources: ['catalog', 'stream'] }, transportUrl: 'https://torrentio/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.equal(result.addons[0].supportsStreams, true);
});

test('listAddons reports supportsStreams: true when manifest.resources is an array of descriptor objects', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.torrentio', name: 'Torrentio', resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }] }, transportUrl: 'https://torrentio/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.equal(result.addons[0].supportsStreams, true);
});

test('listAddons reports supportsStreams: false when manifest.resources is absent entirely (no crash)', async () => {
  const actions = createSettingsActions(baseDeps({
    discoverInstalledAddons: async () => [
      { manifest: { id: 'org.cinemeta', name: 'Cinemeta' }, transportUrl: 'https://cinemeta/manifest.json' }
    ]
  }));
  const result = await actions.listAddons();
  assert.equal(result.addons[0].supportsStreams, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/settingsActions.test.js`
Expected: FAIL — the updated fixture test fails because `supportsStreams` is missing from the actual result, and the three new tests fail with `undefined !== true`/`undefined !== false`.

- [ ] **Step 3: Implement the change**

In `src/settingsActions.js`, add a helper function near the top (after the imports):

```js
function manifestSupportsStreamResource(manifest) {
  return (manifest.resources || []).some((r) => (typeof r === 'string' ? r : r.name) === 'stream');
}
```

Update `listAddons`:

```js
  async function listAddons() {
    const installedAddons = await discoverInstalledAddons();
    if (!installedAddons) return { degraded: true, addons: [] };
    return {
      degraded: false,
      addons: installedAddons.map((entry) => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        supportsStreams: manifestSupportsStreamResource(entry.manifest)
      }))
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/settingsActions.test.js`
Expected: all tests PASS, including every other pre-existing test in this file (unaffected — only the one fixture noted above needed updating).

- [ ] **Step 5: Commit**

```bash
git add src/settingsActions.js test/settingsActions.test.js
git commit -m "Add supportsStreams flag to settingsActions.listAddons"
```

---

### Task 2: `channelActions.deleteChannel(id)`

**Files:**
- Modify: `src/channelActions.js`
- Test: `test/channelActions.test.js`

**Interfaces:**
- Produces: `deleteChannel(id): Promise<void>`, added to the object returned by `createChannelActions(...)` alongside `listCatalogs`/`listChannels`/`addChannel`/`updateChannel`. Throws the existing `NotFoundError` for an unknown id (same class already used by `updateChannel`).

`src/channelActions.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Write the failing tests**

Add to `test/channelActions.test.js` (the `baseDeps()` helper already exists at the top):

```js
test('deleteChannel removes the channel from the persisted list', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  let written = null;
  const actions = createChannelActions(baseDeps({
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async (dataDir, list) => { written = list; }
  }));

  await actions.deleteChannel('x');

  assert.deepEqual(written, []);
});

test('deleteChannel removes the channel from the live array when it is currently live', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const channels = [{ ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } }];
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async () => {}
  }));

  await actions.deleteChannel('x');

  assert.equal(channels.length, 0);
});

test('deleteChannel is a no-op on the live array when the channel is not currently live', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: false }];
  const channels = [];
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async () => {}
  }));

  await actions.deleteChannel('x');

  assert.equal(channels.length, 0);
});

test('deleteChannel throws NotFoundError for an unknown id', async () => {
  const actions = createChannelActions(baseDeps({ readChannelsImpl: async () => [] }));
  await assert.rejects(() => actions.deleteChannel('unknown'), NotFoundError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/channelActions.test.js`
Expected: FAIL — `actions.deleteChannel` is not a function (doesn't exist yet).

- [ ] **Step 3: Implement the change**

In `src/channelActions.js`, add `deleteChannel` inside `createChannelActions` (after `updateChannel`):

```js
  async function deleteChannel(id) {
    const persisted = await readChannelsImpl(dataDir);
    const index = persisted.findIndex((ch) => ch.id === id);
    if (index === -1) {
      throw new NotFoundError(`No channel with id "${id}"`);
    }

    const nextPersisted = persisted.filter((ch) => ch.id !== id);
    await writeChannelsImpl(dataDir, nextPersisted);

    const liveIndex = channels.findIndex((ch) => ch.id === id);
    if (liveIndex !== -1) channels.splice(liveIndex, 1);
  }
```

Update the return statement:

```js
  return { listCatalogs, listChannels, addChannel, updateChannel, deleteChannel };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/channelActions.test.js`
Expected: all tests PASS, including every pre-existing test (unaffected — pure addition).

- [ ] **Step 5: Commit**

```bash
git add src/channelActions.js test/channelActions.test.js
git commit -m "Add channelActions.deleteChannel: permanently remove a channel record"
```

---

### Task 3: `DELETE /admin/channels/:id` route

**Files:**
- Modify: `src/server/adminRoutes.js`
- Test: `test/adminRoutes.test.js`

**Interfaces:**
- Consumes: `channelActions.deleteChannel(id)` (Task 2).
- Produces: `DELETE /admin/channels/:id` — `204` (no body) on success, `404` on `NotFoundError`, `500` on any other error.

`src/server/adminRoutes.js` already exists and has NOT changed since this plan was written — read it in full first to confirm exact current state and line numbers before editing.

- [ ] **Step 1: Write the failing tests**

Add to `test/adminRoutes.test.js` (the `withRouter(t, channelActions, settingsActions)` helper already exists):

```js
test('DELETE /admin/channels/:id returns 204 on success', async (t) => {
  const baseUrl = await withRouter(t, {
    deleteChannel: async () => {}
  });
  const res = await fetch(`${baseUrl}/channels/x`, { method: 'DELETE' });
  assert.equal(res.status, 204);
});

test('DELETE /admin/channels/:id returns 404 when channelActions throws NotFoundError', async (t) => {
  const baseUrl = await withRouter(t, {
    deleteChannel: async () => { throw new NotFoundError('no such channel'); }
  });
  const res = await fetch(`${baseUrl}/channels/unknown`, { method: 'DELETE' });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error, 'no such channel');
});

test('DELETE /admin/channels/:id returns 500 on an unexpected error', async (t) => {
  const baseUrl = await withRouter(t, {
    deleteChannel: async () => { throw new Error('disk exploded'); }
  });
  const res = await fetch(`${baseUrl}/channels/x`, { method: 'DELETE' });
  assert.equal(res.status, 500);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adminRoutes.test.js`
Expected: FAIL — `DELETE /admin/channels/:id` doesn't exist yet (Express's default 404 for the unmatched method/route, not the specific 204/404/500 the tests expect).

- [ ] **Step 3: Implement the change**

In `src/server/adminRoutes.js`, add a new route right after the existing `router.patch('/channels/:id', ...)` route:

```js
  router.delete('/channels/:id', async (req, res) => {
    try {
      await channelActions.deleteChannel(req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      console.error('Failed to delete channel:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adminRoutes.test.js`
Expected: all tests PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add src/server/adminRoutes.js test/adminRoutes.test.js
git commit -m "Add DELETE /admin/channels/:id route"
```

---

### Task 4: Admin UI — per-channel dropdowns and delete button

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `GET /admin/addons` (existing, now returning `supportsStreams` per Task 1), `DELETE /admin/channels/:id` (Task 3).
- Produces: nothing consumed by later tasks — this is the UI leaf.

- [ ] **Step 1: Add a "Delete" column header in `public/index.html`**

Change:

```html
        <tr><th>Name</th><th>Mode</th><th>Min quality</th><th>Language</th><th>Stream addon</th><th>Enabled</th></tr>
```

to:

```html
        <tr><th>Name</th><th>Mode</th><th>Min quality</th><th>Language</th><th>Stream addon</th><th>Enabled</th><th>Delete</th></tr>
```

- [ ] **Step 2: Add the shared `addonOptionsHtml` helper and an `addonsCache` module variable in `public/admin.js`**

Add near the top, after `escapeHtml`:

```js
let addonsCache = { degraded: false, addons: [] };

function addonOptionsHtml(addons, current) {
  const options = [{ id: '', name: 'None' }, ...addons];
  if (current && !addons.some((a) => a.id === current)) {
    options.push({ id: current, name: `${current} (not currently installed)` });
  }
  return options
    .map((a) => `<option value="${escapeHtml(a.id)}"${a.id === current ? ' selected' : ''}>${escapeHtml(a.name)}</option>`)
    .join('');
}
```

- [ ] **Step 3: Update `loadSettings()` to populate `addonsCache` and use the shared helper**

Replace the existing `loadSettings`:

```js
async function loadSettings() {
  const [settings, addonsResult] = await Promise.all([
    fetchJson('/admin/settings'),
    fetchJson('/admin/addons')
  ]);

  const select = document.getElementById('default-stream-addon');
  const current = settings.defaultStreamAddon || '';

  if (addonsResult.degraded) {
    showBanner('Could not reach your Stremio account right now — catalog list unavailable.');
  }
  select.disabled = addonsResult.degraded;

  const options = [{ id: '', name: 'None' }, ...addonsResult.addons];
  if (current && !addonsResult.addons.some((a) => a.id === current)) {
    options.push({ id: current, name: `${current} (not currently installed)` });
  }

  select.innerHTML = options
    .map((a) => `<option value="${escapeHtml(a.id)}"${a.id === current ? ' selected' : ''}>${escapeHtml(a.name)}</option>`)
    .join('');
}
```

with:

```js
async function loadSettings() {
  const [settings, addonsResult] = await Promise.all([
    fetchJson('/admin/settings'),
    fetchJson('/admin/addons')
  ]);

  addonsCache = addonsResult;

  const select = document.getElementById('default-stream-addon');
  const current = settings.defaultStreamAddon || '';

  if (addonsResult.degraded) {
    showBanner('Could not reach your Stremio account right now — catalog list unavailable.');
  }
  select.disabled = addonsResult.degraded;
  select.innerHTML = addonOptionsHtml(addonsResult.addons, current);
}
```

- [ ] **Step 4: Update `loadChannels()`'s row template — dropdown + delete button**

Replace the existing row template and add a delete-button click handler:

```js
async function loadChannels() {
  const channels = await fetchJson('/admin/channels');
  const body = document.getElementById('channels-body');
  body.innerHTML = channels.map((ch) => `
    <tr data-id="${ch.id}">
      <td>${escapeHtml(ch.name)}</td>
      <td>${selectHtml('mode', MODES, ch.mode)}</td>
      <td>${selectHtml('minQuality', QUALITIES, ch.minQuality)}</td>
      <td>${selectHtml('language', LANGUAGES, ch.language)}</td>
      <td><select data-field="streamAddon"${addonsCache.degraded ? ' disabled' : ''}>${addonOptionsHtml(addonsCache.addons, ch.streamAddon || '')}</select></td>
      <td><input type="checkbox" data-field="enabled" ${ch.enabled ? 'checked' : ''}></td>
      <td><button data-action="delete-channel">Delete</button></td>
    </tr>
  `).join('');

  body.querySelectorAll('select, input[type=checkbox], input[type=text]').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const row = e.target.closest('tr');
      const id = row.dataset.id;
      const field = e.target.dataset.field;
      const value = field === 'enabled' ? e.target.checked : e.target.value;
      try {
        await fetchJson(`/admin/channels/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value })
        });
        hideBanner();
        await loadAll();
      } catch (err) {
        showBanner(err.message);
      }
    });
  });

  body.querySelectorAll('button[data-action="delete-channel"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('tr');
      const id = row.dataset.id;
      const name = row.children[0].textContent;
      if (!confirm(`Delete channel "${name}"? This cannot be undone.`)) return;
      try {
        await fetchJson(`/admin/channels/${id}`, { method: 'DELETE' });
        hideBanner();
        await loadAll();
      } catch (err) {
        showBanner(err.message);
      }
    });
  });
}
```

(The `fetchJson` helper already handles a `204 No Content` response correctly — `res.json()` on an empty body rejects, caught by its existing `.catch(() => ({}))`, and `res.ok` is `true` for 204, so no error is thrown. No changes needed to `fetchJson` itself.)

- [ ] **Step 5: Update `catalogRowHtml()` — dropdown with the smart default**

Replace the existing function:

```js
function catalogRowHtml(cat) {
  if (cat.channelId) {
    return `<tr><td>${escapeHtml(cat.catalogName)}</td><td>${escapeHtml(cat.type)}</td><td>Already added</td></tr>`;
  }
  const key = cssEscape(`${cat.addon}::${cat.catalog}`);
  return `
    <tr data-addon="${escapeHtml(cat.addon)}" data-catalog="${escapeHtml(cat.catalog)}" data-key="${key}">
      <td>${escapeHtml(cat.catalogName)}</td><td>${escapeHtml(cat.type)}</td>
      <td><button data-action="toggle-form">Add channel</button></td>
    </tr>
    <tr class="add-form-row">
      <td colspan="3">
        <div class="add-form" id="form-${key}">
          <input type="text" data-field="name" placeholder="Channel name" value="${escapeHtml(cat.catalogName)}">
          ${selectHtml('mode', MODES, 'random-start')}
          ${selectHtml('minQuality', QUALITIES, '720p')}
          ${selectHtml('language', LANGUAGES, 'en')}
          <input type="text" data-field="streamAddon" placeholder="Stream addon ID (optional — overrides the global default)">
          <button data-action="submit">Save</button>
        </div>
      </td>
    </tr>
  `;
}
```

with:

```js
function catalogRowHtml(cat) {
  if (cat.channelId) {
    return `<tr><td>${escapeHtml(cat.catalogName)}</td><td>${escapeHtml(cat.type)}</td><td>Already added</td></tr>`;
  }
  const key = cssEscape(`${cat.addon}::${cat.catalog}`);
  const sourceAddon = addonsCache.addons.find((a) => a.id === cat.addon);
  const defaultStreamAddon = sourceAddon && sourceAddon.supportsStreams ? cat.addon : '';
  return `
    <tr data-addon="${escapeHtml(cat.addon)}" data-catalog="${escapeHtml(cat.catalog)}" data-key="${key}">
      <td>${escapeHtml(cat.catalogName)}</td><td>${escapeHtml(cat.type)}</td>
      <td><button data-action="toggle-form">Add channel</button></td>
    </tr>
    <tr class="add-form-row">
      <td colspan="3">
        <div class="add-form" id="form-${key}">
          <input type="text" data-field="name" placeholder="Channel name" value="${escapeHtml(cat.catalogName)}">
          ${selectHtml('mode', MODES, 'random-start')}
          ${selectHtml('minQuality', QUALITIES, '720p')}
          ${selectHtml('language', LANGUAGES, 'en')}
          <select data-field="streamAddon"${addonsCache.degraded ? ' disabled' : ''}>${addonOptionsHtml(addonsCache.addons, defaultStreamAddon)}</select>
          <button data-action="submit">Save</button>
        </div>
      </td>
    </tr>
  `;
}
```

- [ ] **Step 6: Update the add-channel submit handler to read the `<select>`'s value**

In `loadCatalogs()`'s submit-button handler, change:

```js
      const streamAddon = formDiv.querySelector('[data-field="streamAddon"]').value.trim() || undefined;
```

to:

```js
      const streamAddon = formDiv.querySelector('[data-field="streamAddon"]').value || undefined;
```

- [ ] **Step 7: Verify**

Run `node --check public/admin.js` to confirm valid syntax, then run the full test suite (`npm test`) to confirm nothing broke (no test changes are expected for this task — this project's convention is manual-only verification for the static admin UI).

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/admin.js
git commit -m "Turn per-channel stream addon into a dropdown (with smart default) and add channel delete"
```

---

### Task 5: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions beyond the one deliberate, plan-mandated fixture update in Task 1.

- [ ] **Step 2: Manual verification**

Per this project's existing testing approach (the admin UI is manually verified, not covered by browser tests): run the app with `DATA_DIR` pointed at a scratch directory and valid `STREMIO_EMAIL`/`STREMIO_PASSWORD` env vars, open the admin UI, and confirm: (a) an existing channel's "Stream addon" cell is now a dropdown showing its current value (or "None"); (b) adding a channel from a catalog whose own addon supports streams pre-selects that addon in the add-form's dropdown, while a catalog from a stream-incapable addon (e.g. Cinemeta) defaults to "None"; (c) clicking "Delete" on a channel prompts for confirmation, and confirming removes it from the table and from `/data/channels.json`; (d) declining the confirmation leaves the channel untouched.
