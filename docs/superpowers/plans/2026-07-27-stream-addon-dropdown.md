# Global Default Stream Addon Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text "Default stream addon" input in the admin UI with a dropdown populated from the user's actual installed Stremio addons, so nobody has to type an addon id by hand.

**Architecture:** A new `listAddons()` action on `settingsActions.js` (reusing the `discoverInstalledAddons` dependency it already has) flattens every installed addon into `{id, name}` pairs — unlike `channelActions.listCatalogs()`, it does NOT filter by whether an addon has catalogs, since stream-only addons (Torrentio-style) typically declare none. A new `GET /admin/addons` route exposes it. The admin UI's "Default stream addon" `<input type=text>` becomes a `<select>`, populated on load with a "None" option plus one option per installed addon, with a safety net for a saved value that no longer matches any installed addon.

**Tech Stack:** Node.js/Express (no new dependencies), `node:test`/`node:assert`, vanilla JS admin UI.

## Global Constraints

- No new npm dependencies.
- The per-channel "Stream addon" override field (table row + add-channel form) is **out of scope** — stays a free-text input, unchanged.
- `listAddons()`'s degraded contract must exactly match `channelActions.listCatalogs()`'s: `{degraded: true, addons: []}` when `discoverInstalledAddons()` returns falsy, `{degraded: false, addons: [...]}` otherwise — same shape convention, different field name (`addons` vs `catalogs`).
- A saved `defaultStreamAddon` that doesn't match any currently-installed addon must never be silently dropped from the dropdown (see Task 3's "stale-selection safety" requirement) — this is a data-loss-prevention requirement, not optional polish.
- Follow existing code style: named exports, injectable `*Impl` params, `node:test` + `node:assert/strict`, existing `escapeHtml`/`fetchJson`/banner-show/hide conventions in `admin.js`.

---

### Task 1: `settingsActions.js` — `listAddons()`

**Files:**
- Modify: `src/settingsActions.js`
- Test: `test/settingsActions.test.js`

**Interfaces:**
- Produces: `listAddons(): Promise<{degraded: boolean, addons: Array<{id: string, name: string}>}>`, added to the object returned by `createSettingsActions(...)` alongside the existing `getSettings`/`updateSettings`.

`src/settingsActions.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Write the failing tests**

Add to `test/settingsActions.test.js` (the `baseDeps()` helper already exists at the top):

```js
test('listAddons returns degraded when Stremio discovery is unavailable', async () => {
  const actions = createSettingsActions(baseDeps({ discoverInstalledAddons: async () => null }));
  const result = await actions.listAddons();
  assert.deepEqual(result, { degraded: true, addons: [] });
});

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
      { id: 'org.torrentio', name: 'Torrentio' },
      { id: 'org.cinemeta', name: 'Cinemeta' }
    ]
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/settingsActions.test.js`
Expected: FAIL — `actions.listAddons` is not a function (doesn't exist yet).

- [ ] **Step 3: Implement the change**

In `src/settingsActions.js`, add `listAddons` inside `createSettingsActions` (alongside `getSettings`/`updateSettings`):

```js
  async function listAddons() {
    const installedAddons = await discoverInstalledAddons();
    if (!installedAddons) return { degraded: true, addons: [] };
    return {
      degraded: false,
      addons: installedAddons.map((entry) => ({ id: entry.manifest.id, name: entry.manifest.name }))
    };
  }
```

Update the return statement:

```js
  return { getSettings, updateSettings, listAddons };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/settingsActions.test.js`
Expected: all tests PASS, including every pre-existing test in this file (unaffected — `listAddons` is a pure addition).

- [ ] **Step 5: Commit**

```bash
git add src/settingsActions.js test/settingsActions.test.js
git commit -m "Add settingsActions.listAddons: flatten every installed addon into id/name pairs"
```

---

### Task 2: `GET /admin/addons` route

**Files:**
- Modify: `src/server/adminRoutes.js`
- Test: `test/adminRoutes.test.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `settingsActions.listAddons()` (Task 1).
- Produces: `GET /admin/addons` — `200` with `{degraded, addons}` on success, `500` on an unexpected error, genuinely unregistered (404 via Express fallthrough) when `settingsActions` is omitted from `createAdminRouter`.

`src/server/adminRoutes.js` already exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state and line numbers. It already accepts `settingsActions` as an optional second parameter (from a prior plan) and has an `if (settingsActions) { ... }` block containing the `/settings` routes — this task adds one more route inside that same block.

- [ ] **Step 1: Write the failing tests**

Add to `test/adminRoutes.test.js` (the `withRouter(t, channelActions, settingsActions)` helper already exists and accepts both arguments):

```js
test('GET /admin/addons proxies to settingsActions.listAddons', async (t) => {
  const baseUrl = await withRouter(t, {}, {
    listAddons: async () => ({ degraded: false, addons: [{ id: 'org.torrentio', name: 'Torrentio' }] })
  });
  const res = await fetch(`${baseUrl}/addons`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { degraded: false, addons: [{ id: 'org.torrentio', name: 'Torrentio' }] });
});

test('GET /admin/addons is not registered when settingsActions is omitted', async (t) => {
  const baseUrl = await withRouter(t, { listChannels: async () => [] });
  const res = await fetch(`${baseUrl}/addons`);
  assert.equal(res.status, 404);
});
```

Add to `test/app.test.js` (the `withApp` helper already forwards `settingsActions` to `createApp` — no helper changes needed):

```js
test('GET /admin/addons is reachable through createApp when settingsActions is provided', async (t) => {
  const baseUrl = await withApp(t, {
    channels: [],
    channelActions: { listChannels: async () => [] },
    settingsActions: { listAddons: async () => ({ degraded: false, addons: [{ id: 'org.torrentio', name: 'Torrentio' }] }) }
  });
  const res = await fetch(`${baseUrl}/admin/addons`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { degraded: false, addons: [{ id: 'org.torrentio', name: 'Torrentio' }] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adminRoutes.test.js test/app.test.js`
Expected: FAIL — `/admin/addons` doesn't exist yet (404 on the requests that expect 200).

- [ ] **Step 3: Implement the change**

In `src/server/adminRoutes.js`, inside the existing `if (settingsActions) { ... }` block (alongside the `/settings` GET/PATCH routes), add:

```js
    router.get('/addons', async (req, res) => {
      try {
        const result = await settingsActions.listAddons();
        res.json(result);
      } catch (err) {
        console.error('Failed to list addons:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
```

No changes needed to `src/server/app.js` — it already mounts `createAdminRouter(channelActions, settingsActions)` under `/admin`, so any route registered inside that router (including this new one) is automatically reachable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adminRoutes.test.js test/app.test.js`
Expected: all tests PASS, including every pre-existing test in both files.

- [ ] **Step 5: Commit**

```bash
git add src/server/adminRoutes.js test/adminRoutes.test.js test/app.test.js
git commit -m "Add GET /admin/addons route"
```

---

### Task 3: Admin UI — dropdown for the global default stream addon

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `GET /admin/addons` (Task 2), `GET /admin/settings` (existing).
- Produces: nothing consumed by later tasks — this is the UI leaf. `wireSettingsForm()`'s save handler is unchanged (reads `.value` off the element with id `default-stream-addon`, which works identically whether that element is an `<input>` or a `<select>`).

- [ ] **Step 1: Change the field to a `<select>` in `public/index.html`**

Change:

```html
      <input type="text" id="default-stream-addon" placeholder="org.stremio.torrentiorexpanded.addon">
```

to:

```html
      <select id="default-stream-addon"></select>
```

- [ ] **Step 2: Rewrite `loadSettings()` in `public/admin.js` to populate the dropdown**

Replace the existing `loadSettings` function:

```js
async function loadSettings() {
  const settings = await fetchJson('/admin/settings');
  document.getElementById('default-stream-addon').value = settings.defaultStreamAddon || '';
}
```

with:

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

`wireSettingsForm()` needs no changes — `document.getElementById('default-stream-addon').value` reads the selected `<option>`'s value the same way it read the text input's value before.

- [ ] **Step 3: Verify**

Run `node --check public/admin.js` to confirm valid syntax, then run the full test suite (`npm test`) to confirm nothing broke (no test changes are expected for this task — this project's convention is manual-only verification for the static admin UI).

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/admin.js
git commit -m "Turn the global default stream addon field into a dropdown of installed addons"
```

---

### Task 4: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions in any pre-existing test.

- [ ] **Step 2: Manual verification**

Per this project's existing testing approach (the admin UI is manually verified, not covered by browser tests): run the app with `DATA_DIR` pointed at a scratch directory and valid `STREMIO_EMAIL`/`STREMIO_PASSWORD` env vars, open the admin UI, confirm the "Default stream addon" dropdown lists your actual installed addons (including any stream-only ones with no catalogs, e.g. Torrentio), select one and Save, reload the page and confirm it's still selected, and confirm that setting `defaultStreamAddon` directly in `/data/settings.json` to an addon id not currently installed causes the dropdown to show it as a distinct "(not currently installed)" option rather than reverting to "None".
