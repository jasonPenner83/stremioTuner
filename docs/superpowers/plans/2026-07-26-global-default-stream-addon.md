# Global Default Stream Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user configure one global default stream addon (via the admin UI) that every channel uses for stream resolution unless it sets its own per-channel override, so the common case ("always use TorrentioRD") requires zero per-channel configuration.

**Architecture:** A new `src/settingsStore.js`/`src/settingsActions.js` pair (mirroring the existing `channelStore.js`/`channelActions.js` pattern) persists `{ defaultStreamAddon }` to `/data/settings.json` and exposes `getSettings`/`updateSettings`. `bootstrap.js` holds the loaded settings as one mutable object (the same "shared object flows so live changes apply immediately" pattern the `channels` array already uses) and its existing `resolveStreamSource` closure falls back to `settings.defaultStreamAddon` when a channel has no `streamAddon` of its own. Changing the default via a new `PATCH /admin/settings` route re-resolves every affected live channel's `streamSource` immediately.

**Tech Stack:** Node.js (native `fetch`, no new dependencies), Express, `node:test`/`node:assert`, vanilla JS admin UI.

## Global Constraints

- No new npm dependencies.
- Every pre-existing test must keep passing, **except** one specific, deliberate exception called out in Task 4 (`channelActions.test.js`'s "addChannel sets streamSource: null when streamAddon is omitted" test) — that test's premise (`resolveStreamSourceImpl` must NOT be called when `streamAddon` is absent) is exactly what this plan changes, per the design spec: "That guard is removed... so a channel added with no `streamAddon` still picks up whatever the global default currently is." This is a **plan-mandated behavior change**, not a regression — Task 4 replaces that test with one asserting the new behavior.
- Resolution order: `channel.streamAddon` → `settings.defaultStreamAddon` → neither set (fall back to `channel.source`, unchanged from before this plan).
- `settings` must be held as one mutable object, mutated via `Object.assign` (never reassigned), exactly mirroring how the existing `channels` live array is mutated in place — this is what makes `PATCH /admin/settings` apply without a restart.
- Follow existing code style: named exports, injectable `*Impl` params, `node:test` + `node:assert/strict`.

---

### Task 1: `src/settingsStore.js` — read/write `/data/settings.json`

**Files:**
- Create: `src/settingsStore.js`
- Test: `test/settingsStore.test.js`

**Interfaces:**
- Produces: `settingsPath(dataDir)`, `readSettings(dataDir, {fs?})` (returns `{}` on ENOENT, matching `readChannels`'s `[]`-on-ENOENT pattern), `writeSettings(dataDir, settings, {fs?})`.

- [ ] **Step 1: Write the failing tests**

Create `test/settingsStore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { settingsPath, readSettings, writeSettings } from '../src/settingsStore.js';

test('settingsPath joins dataDir/settings.json', () => {
  assert.equal(settingsPath('/data'), path.join('/data', 'settings.json'));
});

test('readSettings returns an empty object when the file does not exist', async () => {
  const fakeFs = {
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
  };
  const result = await readSettings('/data', { fs: fakeFs });
  assert.deepEqual(result, {});
});

test('readSettings parses the persisted JSON', async () => {
  const fakeFs = { readFile: async () => JSON.stringify({ defaultStreamAddon: 'org.torrentio' }) };
  const result = await readSettings('/data', { fs: fakeFs });
  assert.deepEqual(result, { defaultStreamAddon: 'org.torrentio' });
});

test('readSettings rethrows a non-ENOENT error', async () => {
  const fakeFs = { readFile: async () => { throw new Error('disk exploded'); } };
  await assert.rejects(() => readSettings('/data', { fs: fakeFs }), /disk exploded/);
});

test('writeSettings creates the directory and writes JSON', async () => {
  const calls = { mkdir: null, writeFile: null };
  const fakeFs = {
    mkdir: async (dir, opts) => { calls.mkdir = { dir, opts }; },
    writeFile: async (p, content) => { calls.writeFile = { p, content }; }
  };
  await writeSettings('/data', { defaultStreamAddon: 'org.torrentio' }, { fs: fakeFs });
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.ok(calls.writeFile.p.endsWith('settings.json'));
  assert.deepEqual(JSON.parse(calls.writeFile.content), { defaultStreamAddon: 'org.torrentio' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/settingsStore.test.js`
Expected: FAIL with "Cannot find module '../src/settingsStore.js'" (file doesn't exist yet).

- [ ] **Step 3: Implement `src/settingsStore.js`**

```js
import path from 'node:path';
import fsPromises from 'node:fs/promises';

export function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json');
}

export async function readSettings(dataDir, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(settingsPath(dataDir), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeSettings(dataDir, settings, { fs = fsPromises } = {}) {
  const filePath = settingsPath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2));
}
```

(This is a direct structural mirror of `src/channelStore.js`'s `channelsPath`/`readChannels`/`writeChannels` — same shape, singular object instead of an array.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/settingsStore.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settingsStore.js test/settingsStore.test.js
git commit -m "Add settingsStore: read/write /data/settings.json"
```

---

### Task 2: `src/settingsActions.js` — get/update settings, re-resolving affected channels

**Files:**
- Create: `src/settingsActions.js`
- Test: `test/settingsActions.test.js`

**Interfaces:**
- Consumes: `ValidationError` from `src/channelActions.js` (reused, not redefined — `adminRoutes.js` already does an `instanceof` check against this one class, so both channel and settings routes must throw the same class).
- Produces: `createSettingsActions({dataDir, settings, channels, discoverInstalledAddons, resolveStreamSourceImpl, readSettingsImpl?, writeSettingsImpl?}) → {getSettings, updateSettings}`. `updateSettings(patch)` mutates the passed-in `settings` object in place (via `Object.assign`) and, when the patch touches `defaultStreamAddon`, re-resolves `streamSource` on every entry in the passed-in `channels` array that has no `streamAddon` of its own.

- [ ] **Step 1: Write the failing tests**

Create `test/settingsActions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsActions } from '../src/settingsActions.js';
import { ValidationError } from '../src/channelActions.js';

function baseDeps(overrides = {}) {
  return {
    dataDir: '/data',
    settings: {},
    channels: [],
    discoverInstalledAddons: async () => [],
    resolveStreamSourceImpl: () => null,
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    ...overrides
  };
}

test('getSettings returns the persisted settings', async () => {
  const actions = createSettingsActions(baseDeps({
    readSettingsImpl: async () => ({ defaultStreamAddon: 'org.torrentio' })
  }));
  const result = await actions.getSettings();
  assert.deepEqual(result, { defaultStreamAddon: 'org.torrentio' });
});

test('updateSettings persists and returns the new defaultStreamAddon', async () => {
  let written = null;
  const actions = createSettingsActions(baseDeps({
    writeSettingsImpl: async (dataDir, settings) => { written = settings; }
  }));
  const result = await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });
  assert.deepEqual(result, { defaultStreamAddon: 'org.torrentio' });
  assert.deepEqual(written, { defaultStreamAddon: 'org.torrentio' });
});

test('updateSettings rejects a non-string/non-null defaultStreamAddon without persisting', async () => {
  let writeCalled = false;
  const actions = createSettingsActions(baseDeps({
    writeSettingsImpl: async () => { writeCalled = true; }
  }));
  await assert.rejects(() => actions.updateSettings({ defaultStreamAddon: 42 }), ValidationError);
  assert.equal(writeCalled, false);
});

test('updateSettings normalizes an empty string to null', async () => {
  let written = null;
  const actions = createSettingsActions(baseDeps({
    writeSettingsImpl: async (dataDir, settings) => { written = settings; }
  }));
  const result = await actions.updateSettings({ defaultStreamAddon: '' });
  assert.equal(result.defaultStreamAddon, null);
  assert.equal(written.defaultStreamAddon, null);
});

test('updateSettings mutates the shared settings object in place rather than replacing it', async () => {
  const settings = {};
  const actions = createSettingsActions(baseDeps({ settings }));
  await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });
  assert.equal(settings.defaultStreamAddon, 'org.torrentio');
});

test('updateSettings re-resolves streamSource for a live channel with no per-channel streamAddon override', async () => {
  const channels = [{ id: 'a', name: 'A', streamSource: null }];
  const installedAddons = [{ manifest: { id: 'org.torrentio' }, transportUrl: 'https://torrentio/manifest.json' }];
  const actions = createSettingsActions(baseDeps({
    channels,
    discoverInstalledAddons: async () => installedAddons,
    resolveStreamSourceImpl: (channel, addons) => {
      const found = addons.find((a) => a.manifest.id === 'org.torrentio');
      return found ? { transportUrl: found.transportUrl } : null;
    }
  }));

  await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });

  assert.equal(channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
});

test('updateSettings does not call resolveStreamSourceImpl for a channel with its own streamAddon override', async () => {
  const channels = [{ id: 'b', name: 'B', streamAddon: 'org.other', streamSource: { transportUrl: 'https://other/manifest.json' } }];
  const calledFor = [];
  const actions = createSettingsActions(baseDeps({
    channels,
    resolveStreamSourceImpl: (channel) => { calledFor.push(channel.id); return null; }
  }));

  await actions.updateSettings({ defaultStreamAddon: 'org.torrentio' });

  assert.deepEqual(calledFor, []);
  assert.equal(channels[0].streamSource.transportUrl, 'https://other/manifest.json');
});

test('updateSettings does not touch channels or call discoverInstalledAddons when the patch does not include defaultStreamAddon', async () => {
  const channels = [{ id: 'a', streamSource: null }];
  let discoverCalled = false;
  const actions = createSettingsActions(baseDeps({
    channels,
    discoverInstalledAddons: async () => { discoverCalled = true; return []; }
  }));
  await actions.updateSettings({});
  assert.equal(discoverCalled, false);
  assert.equal(channels[0].streamSource, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/settingsActions.test.js`
Expected: FAIL with "Cannot find module '../src/settingsActions.js'" (file doesn't exist yet).

- [ ] **Step 3: Implement `src/settingsActions.js`**

```js
import { readSettings, writeSettings } from './settingsStore.js';
import { ValidationError } from './channelActions.js';

export function createSettingsActions({
  dataDir,
  settings,
  channels,
  discoverInstalledAddons,
  resolveStreamSourceImpl,
  readSettingsImpl = readSettings,
  writeSettingsImpl = writeSettings
}) {
  async function getSettings() {
    return readSettingsImpl(dataDir);
  }

  async function updateSettings(patch) {
    const allowed = {};
    if ('defaultStreamAddon' in patch) {
      const value = patch.defaultStreamAddon;
      if (value !== null && typeof value !== 'string') {
        throw new ValidationError(`Invalid defaultStreamAddon "${value}" (must be a string or null)`);
      }
      allowed.defaultStreamAddon = value || null;
    }

    const current = await readSettingsImpl(dataDir);
    const updated = { ...current, ...allowed };
    await writeSettingsImpl(dataDir, updated);
    Object.assign(settings, updated);

    if ('defaultStreamAddon' in allowed) {
      const installedAddons = await discoverInstalledAddons();
      for (const channel of channels) {
        if (!channel.streamAddon) {
          channel.streamSource = resolveStreamSourceImpl(channel, installedAddons);
        }
      }
    }

    return updated;
  }

  return { getSettings, updateSettings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/settingsActions.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settingsActions.js test/settingsActions.test.js
git commit -m "Add settingsActions: get/update global settings, re-resolving affected channels"
```

---

### Task 3: `bootstrap.js` — load settings, fall back to the global default, wire settingsActions

**Files:**
- Modify: `src/bootstrap.js`
- Test: `test/bootstrap.test.js`

**Interfaces:**
- Consumes: `readSettings`/`writeSettings` (Task 1), `createSettingsActions` (Task 2).
- Produces: `bootstrap()`'s returned object gains `settingsActions`; `createAppImpl` is now called with an additional `settingsActions` property (consumed by Task 5).

`src/bootstrap.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state and line numbers.

- [ ] **Step 1: Write the failing tests**

Add to `test/bootstrap.test.js` (the `channel()` helper and `fakeApp()` already exist at the top):

```js
test('bootstrap resolves streamSource from the global default stream addon when a channel has no per-channel override', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({ defaultStreamAddon: 'org.torrentio' }),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://torrentio/manifest.json', manifest: { id: 'org.torrentio', catalogs: [] } }
    ],
    findAddonByIdImpl: (addons, id) => {
      const found = addons.find((a) => a.manifest.id === id);
      if (!found) throw new Error(`addon not found: ${id}`);
      return found;
    },
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].streamSource.transportUrl, 'https://torrentio/manifest.json');
  assert.ok(createdAppArgs[0].settingsActions);
});

test('bootstrap prefers a channel\'s own streamAddon over the global default', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', streamAddon: 'org.other' })]),
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({ defaultStreamAddon: 'org.torrentio' }),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://torrentio/manifest.json', manifest: { id: 'org.torrentio', catalogs: [] } },
      { transportUrl: 'https://other/manifest.json', manifest: { id: 'org.other', catalogs: [] } }
    ],
    findAddonByIdImpl: (addons, id) => {
      const found = addons.find((a) => a.manifest.id === id);
      if (!found) throw new Error(`addon not found: ${id}`);
      return found;
    },
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].streamSource.transportUrl, 'https://other/manifest.json');
});

test('bootstrap wires a real settingsActions instance backed by the shared settings object', async () => {
  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {},
    readSettingsImpl: async () => ({}),
    writeSettingsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [],
    findAddonByIdImpl: (addons, id) => { throw new Error(`addon not found: ${id}`); },
    resolveChannelSourceImpl: () => null,
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async () => ({ generatedAt: 'new', items: [] }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });

  assert.ok(result.settingsActions);
  const settings = await result.settingsActions.getSettings();
  assert.deepEqual(settings, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bootstrap.test.js`
Expected: FAIL — `bootstrap` doesn't accept `readSettingsImpl`/`writeSettingsImpl`, `streamSource` never falls back to a global default, and `result.settingsActions`/`createdAppArgs[0].settingsActions` are `undefined`.

- [ ] **Step 3: Implement the change**

Add two imports near the top of `src/bootstrap.js` (alongside the existing imports):

```js
import { readSettings, writeSettings } from './settingsStore.js';
import { createSettingsActions } from './settingsActions.js';
```

Add two new params to `bootstrap()`'s destructured options (alongside `readChannelsImpl`/`writeChannelsImpl`):

```js
  readSettingsImpl = readSettings,
  writeSettingsImpl = writeSettings,
```

and (alongside `createChannelActionsImpl`):

```js
  createSettingsActionsImpl = createSettingsActions,
```

Right after the existing `const authCachePath = ...`/`realDebridApiKey` block, load settings into one mutable object:

```js
  const settings = await readSettingsImpl(dataDir);
```

Change `resolveStreamSource`'s body to fall back to the global default:

```js
  function resolveStreamSource(channel, installedAddons) {
    const streamAddon = channel.streamAddon || settings.defaultStreamAddon;
    if (!streamAddon) return null;
    if (!installedAddons) return null;
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, streamAddon);
      return { transportUrl: addonEntry.transportUrl };
    } catch (err) {
      console.error(`Could not resolve stream addon for channel "${channel.name}": ${err.message}`);
      return null;
    }
  }
```

In `runDailyRegeneration`, update both places that check `channel.streamAddon` to also consider the global default:

```js
    const channelsNeedingSource = channels.filter((channel) => !channel.source || ((channel.streamAddon || settings.defaultStreamAddon) && !channel.streamSource));
```

and inside the loop:

```js
          if ((channel.streamAddon || settings.defaultStreamAddon) && !channel.streamSource) {
```

Create `settingsActions` and pass it into `createAppImpl`, right after the existing `channelActions` creation:

```js
  const settingsActions = createSettingsActionsImpl({
    dataDir,
    settings,
    channels,
    discoverInstalledAddons,
    resolveStreamSourceImpl: resolveStreamSource,
    readSettingsImpl,
    writeSettingsImpl
  });

  const app = createAppImpl({ channels, dataDir, baseUrl, channelActions, settingsActions, realDebridApiKey });
```

Finally, add `settingsActions` to `bootstrap()`'s returned object:

```js
  return { app, channels, server, startupRegenerationDone, channelActions, settingsActions };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/bootstrap.test.js`
Expected: all tests PASS, including every pre-existing test. None of them override `readSettingsImpl`, so `bootstrap()` calls the real `readSettings(dataDir)` for them — this hits the real filesystem at whatever `dataDir` that test uses (typically the default `'/data'`), but `readSettings` catches `ENOENT` and returns `{}`, so `settings.defaultStreamAddon` is simply `undefined` (falsy) for all of them — identical to today's behavior. Confirm this by running the full pre-existing suite in this file, not just the three new tests.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.js test/bootstrap.test.js
git commit -m "Load global settings in bootstrap; fall back to the default stream addon"
```

---

### Task 4: `channelActions.js` — always attempt stream-source resolution (global default may apply)

**Files:**
- Modify: `src/channelActions.js`
- Test: `test/channelActions.test.js`

**Interfaces:** No signature changes — `resolveStreamSourceImpl` is now called unconditionally instead of being guarded behind `streamAddon ? ... : null`.

**This task includes one deliberate, plan-mandated change to an existing test** — see Step 1's note.

`src/channelActions.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state and line numbers.

- [ ] **Step 1: Update the existing test, and understand why**

In `test/channelActions.test.js`, find the test `'addChannel sets streamSource: null when streamAddon is omitted'`. Its current premise is that `resolveStreamSourceImpl` must **not** be called at all when `streamAddon` is omitted (it deliberately throws if called, to prove that). That premise is exactly what this plan changes: per the design spec, a channel added with no `streamAddon` must still pick up whatever the global default currently is, which means `resolveStreamSourceImpl` must now always run (the closure itself decides whether the default applies). **Replace that test** with:

```js
test('addChannel resolves streamSource via resolveStreamSourceImpl even when streamAddon is omitted (global default may apply)', async () => {
  const channels = [];
  let calledWith = null;
  const actions = createChannelActions({
    dataDir: '/data',
    channels,
    discoverInstalledAddons: async () => ([]),
    resolveSourceImpl: () => ({ transportUrl: 'https://cinemeta/manifest.json', type: 'movie' }),
    resolveStreamSourceImpl: (channel) => { calledWith = channel.streamAddon; return null; },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {}
  });

  const record = await actions.addChannel({
    addon: 'cinemeta', catalog: 'top', name: 'X', mode: 'random', minQuality: '480p', language: 'en'
  });

  assert.equal(record.streamAddon, undefined);
  assert.equal(calledWith, undefined);
  assert.equal(channels[0].streamSource, null);
});
```

Every other existing test in this file is unaffected and must keep passing unmodified.

- [ ] **Step 2: Run tests to verify the updated test fails**

Run: `node --test test/channelActions.test.js`
Expected: the updated test FAILS — with the current code, `resolveStreamSourceImpl` is still guarded behind `streamAddon ? ... : null`, so it's never called, and `calledWith` stays `null` (not `undefined` as asserted) — or, depending on exact assertion order, the test fails on the `calledWith` assertion. Confirm the failure is because the guard skips the call, not for some other reason.

- [ ] **Step 3: Implement the change**

In `src/channelActions.js`'s `addChannel`, change:

```js
    const streamSource = streamAddon ? resolveStreamSourceImpl({ streamAddon, name }, installedAddons) : null;
```

to:

```js
    const streamSource = resolveStreamSourceImpl({ streamAddon, name }, installedAddons);
```

In `updateChannel`'s re-add branch (`liveIndex === -1`), change:

```js
      const streamSource = updated.streamAddon ? resolveStreamSourceImpl(updated, installedAddons) : null;
```

to:

```js
      const streamSource = resolveStreamSourceImpl(updated, installedAddons);
```

Leave the in-place-edit branch (`liveIndex !== -1`, the `if ('streamAddon' in allowedPatch) { ... }` block) exactly as-is — per-channel edits still only re-resolve `streamSource` when `streamAddon` is explicitly part of the patch; global-default-driven changes are handled separately by `settingsActions.updateSettings` (Task 2), not here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/channelActions.test.js`
Expected: all tests PASS, including the updated test and every other pre-existing test (none of them relied on `resolveStreamSourceImpl` being skipped except the one just replaced).

- [ ] **Step 5: Commit**

```bash
git add src/channelActions.js test/channelActions.test.js
git commit -m "Always attempt stream-source resolution on add/update (global default may apply)"
```

---

### Task 5: Admin API — `GET`/`PATCH /admin/settings`

**Files:**
- Modify: `src/server/adminRoutes.js`
- Modify: `src/server/app.js`
- Test: `test/adminRoutes.test.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `settingsActions` (Task 2/3's `{getSettings, updateSettings}`), `ValidationError` (already imported in `adminRoutes.js` from `channelActions.js` — reused for settings validation errors too, since `settingsActions.js` throws the same class).
- Produces: `createAdminRouter(channelActions, settingsActions)` — `settingsActions` is a new, second, **optional** parameter; when omitted, `/admin/settings` routes are simply not registered (this is what keeps the existing "admin routes are mounted... when channelActions is provided" test passing unmodified, since that test never supplies `settingsActions`). `createApp({..., settingsActions})` — new optional param, forwarded to `createAdminRouter`.

`src/server/adminRoutes.js` and `src/server/app.js` currently exist and have NOT changed since this plan was written — read both in full before editing to confirm exact current state and line numbers.

- [ ] **Step 1: Write the failing tests**

In `test/adminRoutes.test.js`, change the `withRouter` helper to accept an optional second argument:

```js
async function withRouter(t, channelActions, settingsActions) {
  const app = express();
  app.use('/admin', createAdminRouter(channelActions, settingsActions));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://localhost:${port}/admin`;
}
```

(Every existing call site passes only one argument, e.g. `withRouter(t, { listCatalogs: ... })` — those keep working unmodified since `settingsActions` simply defaults to `undefined`.)

Add new tests to `test/adminRoutes.test.js`:

```js
test('GET /admin/settings proxies to settingsActions.getSettings', async (t) => {
  const baseUrl = await withRouter(t, {}, { getSettings: async () => ({ defaultStreamAddon: 'org.torrentio' }) });
  const res = await fetch(`${baseUrl}/settings`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { defaultStreamAddon: 'org.torrentio' });
});

test('PATCH /admin/settings returns the updated settings', async (t) => {
  const baseUrl = await withRouter(t, {}, {
    updateSettings: async (patch) => ({ defaultStreamAddon: patch.defaultStreamAddon })
  });
  const res = await fetch(`${baseUrl}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultStreamAddon: 'org.torrentio' })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { defaultStreamAddon: 'org.torrentio' });
});

test('PATCH /admin/settings returns 400 when settingsActions throws ValidationError', async (t) => {
  const baseUrl = await withRouter(t, {}, {
    updateSettings: async () => { throw new ValidationError('bad input'); }
  });
  const res = await fetch(`${baseUrl}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultStreamAddon: 42 })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, 'bad input');
});

test('routes under /admin/settings are not registered when settingsActions is omitted', async (t) => {
  const baseUrl = await withRouter(t, { listChannels: async () => [] });
  const res = await fetch(`${baseUrl}/settings`);
  assert.equal(res.status, 404);
});
```

In `test/app.test.js`, extend the `withApp` helper to also forward `settingsActions`:

```js
async function withApp(t, { channels, schedules = {}, corruptSchedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl, channelActions, settingsActions, realDebridApiKey, checkInstantAvailabilityImpl, resolveStreamImpl } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  for (const [channelId, schedule] of Object.entries(schedules)) {
    await writeSchedule(dataDir, channelId, schedule);
  }
  for (const [channelId, rawContent] of Object.entries(corruptSchedules)) {
    const filePath = schedulePath(dataDir, channelId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, rawContent);
  }
  const app = createApp({
    channels,
    dataDir,
    baseUrl: 'http://localhost:0',
    fetchStreamsImpl,
    streamViaFfmpegImpl,
    nowImpl,
    channelActions,
    settingsActions,
    realDebridApiKey,
    checkInstantAvailabilityImpl,
    resolveStreamImpl
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return `http://localhost:${port}`;
}
```

Add one new test to `test/app.test.js`, after the existing admin-routes tests:

```js
test('GET /admin/settings is reachable through createApp when settingsActions is provided', async (t) => {
  const baseUrl = await withApp(t, {
    channels: [],
    channelActions: { listChannels: async () => [] },
    settingsActions: { getSettings: async () => ({ defaultStreamAddon: 'org.torrentio' }) }
  });
  const res = await fetch(`${baseUrl}/admin/settings`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { defaultStreamAddon: 'org.torrentio' });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/adminRoutes.test.js test/app.test.js`
Expected: FAIL — `createAdminRouter` doesn't accept a second argument yet and `/admin/settings` doesn't exist (404 on all the new requests, or a thrown error from `settingsActions.getSettings`/`updateSettings` never being reachable).

- [ ] **Step 3: Implement the change**

In `src/server/adminRoutes.js`, change the function signature and add the two new routes (placed after the existing `/channels` routes, before the error-handling middleware):

```js
export function createAdminRouter(channelActions, settingsActions) {
  const router = express.Router();
  router.use(express.json());

  router.get('/catalogs', async (req, res) => {
    try {
      const result = await channelActions.listCatalogs();
      res.json(result);
    } catch (err) {
      console.error('Failed to list catalogs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/channels', async (req, res) => {
    try {
      const channels = await channelActions.listChannels();
      res.json(channels);
    } catch (err) {
      console.error('Failed to list channels:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/channels', async (req, res) => {
    try {
      const record = await channelActions.addChannel(req.body || {});
      res.status(201).json(record);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error('Failed to add channel:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/channels/:id', async (req, res) => {
    try {
      const updated = await channelActions.updateChannel(req.params.id, req.body || {});
      res.json(updated);
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error('Failed to update channel:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  if (settingsActions) {
    router.get('/settings', async (req, res) => {
      try {
        const settings = await settingsActions.getSettings();
        res.json(settings);
      } catch (err) {
        console.error('Failed to get settings:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    router.patch('/settings', async (req, res) => {
      try {
        const updated = await settingsActions.updateSettings(req.body || {});
        res.json(updated);
      } catch (err) {
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        console.error('Failed to update settings:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  // Error-handling middleware for body-parsing errors
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({ error: 'Malformed JSON body' });
      return;
    }
    console.error('Unexpected error in admin router:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}
```

(Only the function signature and the new `if (settingsActions) { ... }` block are new — everything else shown above is the existing, unchanged code, included so you can see exactly where the new block goes.)

In `src/server/app.js`, add `settingsActions` to `createApp`'s destructured params (alongside `channelActions`):

```js
export function createApp({
  channels,
  dataDir,
  baseUrl,
  channelActions,
  settingsActions,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  realDebridApiKey = null,
  nowImpl = () => new Date()
}) {
```

and change the router-mounting line:

```js
  if (channelActions) {
    app.use('/admin', createAdminRouter(channelActions, settingsActions));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adminRoutes.test.js test/app.test.js`
Expected: all tests PASS, including every pre-existing test in both files (they call `withRouter`/`withApp` without a `settingsActions` argument, which now simply defaults to `undefined` and skips registering `/admin/settings`).

- [ ] **Step 5: Commit**

```bash
git add src/server/adminRoutes.js src/server/app.js test/adminRoutes.test.js test/app.test.js
git commit -m "Add GET/PATCH /admin/settings routes for the global default stream addon"
```

---

### Task 6: Admin UI — global default stream addon setting

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `GET`/`PATCH /admin/settings` (Task 5).
- Produces: nothing consumed by later tasks — this is the UI leaf.

- [ ] **Step 1: Add a "Global settings" section**

In `public/index.html`, add a new `<section>` right after the `<div id="banner">` line and before the existing `<section><h2>My channels</h2>...`:

```html
  <section>
    <h2>Global settings</h2>
    <div class="settings-form">
      <label for="default-stream-addon">Default stream addon</label>
      <input type="text" id="default-stream-addon" placeholder="org.stremio.torrentiorexpanded.addon">
      <button type="button" id="save-settings">Save</button>
    </div>
  </section>
```

- [ ] **Step 2: Load and save the setting in `public/admin.js`**

Add a new function (placed near `loadChannels`/`loadCatalogs`):

```js
async function loadSettings() {
  const settings = await fetchJson('/admin/settings');
  document.getElementById('default-stream-addon').value = settings.defaultStreamAddon || '';
}

function wireSettingsForm() {
  document.getElementById('save-settings').addEventListener('click', async () => {
    const value = document.getElementById('default-stream-addon').value.trim();
    try {
      await fetchJson('/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultStreamAddon: value || null })
      });
      hideBanner();
    } catch (err) {
      showBanner(err.message);
    }
  });
}
```

Update `loadAll` to also load settings:

```js
async function loadAll() {
  await loadSettings();
  await loadChannels();
  await loadCatalogs();
}
```

Update the bottom of the file to wire the new form's button, alongside the existing `wireCopyButtons()` call:

```js
wireCopyButtons();
wireSettingsForm();
loadAll();
```

- [ ] **Step 3: Update the per-channel stream-addon placeholder text to mention the override relationship**

In `loadChannels`'s row template, change:

```js
      <td><input type="text" data-field="streamAddon" value="${escapeHtml(ch.streamAddon || '')}" placeholder="org.stremio.torrentio.addon"></td>
```

to:

```js
      <td><input type="text" data-field="streamAddon" value="${escapeHtml(ch.streamAddon || '')}" placeholder="Overrides global default"></td>
```

In `catalogRowHtml`'s add-form template, change:

```js
          <input type="text" data-field="streamAddon" placeholder="Stream addon ID (optional, e.g. org.stremio.torrentio.addon)">
```

to:

```js
          <input type="text" data-field="streamAddon" placeholder="Stream addon ID (optional — overrides the global default)">
```

- [ ] **Step 4: Verify**

Run `node --check public/admin.js` to confirm valid syntax, then run the full test suite (`npm test`) to confirm nothing broke (no test changes are expected for this task, but confirm the suite still passes — this project's convention is manual-only verification for the static admin UI).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/admin.js
git commit -m "Add global default stream addon setting to the admin UI"
```

---

### Task 7: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions in any pre-existing test file beyond the one deliberate, plan-mandated replacement in Task 4.

- [ ] **Step 2: Manual verification**

Per this project's existing testing approach (the admin UI is manually verified, not covered by browser tests): run the app with `DATA_DIR` pointed at a scratch directory and valid `STREMIO_EMAIL`/`STREMIO_PASSWORD` env vars, open the admin UI, set a "Default stream addon" value and save it, then add a new channel without setting its own per-channel stream addon and confirm (via `GET /admin/channels` or the "Stream addon" column, which will show blank since the override field itself stays empty) that its stream resolution still works at play-time — this can't be fully confirmed without a real Real-Debrid-backed addon installed, so it's sufficient to confirm the settings round-trip (`GET /admin/settings` reflects what was saved) and that a newly-added channel's live object has a non-null `streamSource` when a default is set.
