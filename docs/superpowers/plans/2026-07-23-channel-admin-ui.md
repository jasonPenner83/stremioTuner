# Channel Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stremioTuner's hand-edited `config.yml` channel list with a small web UI (served by the same Express app/port) that lets the user browse live Stremio catalogs, add channels by picking from that list, and enable/disable/edit channels — all taking effect immediately, without a restart.

**Architecture:** A new persisted JSON store (`/data/channels.json`) replaces `config.yml`'s channel list; a `channelActions` module holds the business logic (browse catalogs, add/update channels) and is constructed once by `bootstrap.js`, sharing the same live in-memory `channels` array (and the same source-resolution/regeneration helpers) that already drive the scheduler. A thin Express admin router translates `channelActions` calls to HTTP, and a static vanilla-HTML/JS page (no framework, no build step) consumes that API.

**Tech Stack:** Same as the existing project — Node.js 20+ (ES modules), Express, `node:test` — with `js-yaml` removed (no longer needed) and no new dependencies added.

## Global Constraints

- Node.js >= 20, ES modules, `node:test`/`node:assert/strict` only (no test framework dependency).
- Only one runtime dependency after this feature: `express`. `js-yaml` is removed. No new dependency is introduced for the UI (plain static HTML + vanilla JS, no template engine, no frontend framework, no browser-test framework).
- Every function performing I/O, network calls, or reading the clock must accept an injectable, defaulted parameter — this project's existing convention, unchanged.
- Channel field names stay `addon` and `catalog` (matching the existing `resolveChannelSource`/`findAddonById` call sites in `bootstrap.js`), not `addonId`/`catalogId` as loosely sketched in the design doc's JSON example — this avoids renaming stable, already-reviewed interfaces.
- `channels.json` holds the full channel list (enabled AND disabled) so disabling a channel never loses its settings; only `enabled: true` entries populate the live in-memory `channels` array that `createApp`/the scheduler use.
- "Applies immediately" is implemented by mutating the *same* `channels` array object that flows from `bootstrap.js` into `createApp` — never replacing it with a new array reference.
- No authentication on the admin UI/API.
- The static HTML/JS UI itself is verified manually only; the backend admin API gets full automated test coverage in the same style as the rest of this project (real HTTP requests via `fetch` against a listening server, injected fakes for dependencies).

---

## File Structure

```
stremioTuner/
  src/
    channelStore.js          # NEW: read/write/validate /data/channels.json
    channelActions.js         # NEW: business logic (listCatalogs/listChannels/addChannel/updateChannel)
    streamSelect.js           # MODIFY: export QUALITY_ORDER + add SUPPORTED_LANGUAGES
    bootstrap.js               # MODIFY: replace config.yml/loadConfig with channelStore + REFRESH_TIME env; wire channelActions
    server/
      adminRoutes.js           # NEW: Express router wrapping channelActions
      app.js                   # MODIFY: mount admin router + serve static public/ dir
    config.js                  # DELETE
  test/
    channelStore.test.js       # NEW
    channelActions.test.js     # NEW
    adminRoutes.test.js        # NEW
    bootstrap.test.js          # MODIFY: rewritten for channelStore-based fixtures + channelActions wiring test
    app.test.js                 # MODIFY: add static-serving + admin-mounting tests
    config.test.js              # DELETE
  public/
    index.html                  # NEW: admin UI page
    admin.js                    # NEW: admin UI logic
  config.example.yml            # DELETE
  package.json                   # MODIFY: remove js-yaml dependency
  Dockerfile                     # MODIFY: copy public/ into the image
  docker-compose.yml              # MODIFY: add REFRESH_TIME env var, drop config.yml references
  portainer-stack.yml              # MODIFY: same as docker-compose.yml, plus updated NAS instructions
```

---

### Task 1: Remove the YAML config system

**Files:**
- Delete: `src/config.js`
- Delete: `test/config.test.js`
- Delete: `config.example.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: nothing new — this task only removes the now-obsolete YAML-based config loader and its dependency, in preparation for `channelStore.js` (Task 2) taking over.

- [ ] **Step 1: Delete the obsolete files**

```bash
rm src/config.js test/config.test.js config.example.yml
```

- [ ] **Step 2: Remove the `js-yaml` dependency**

Edit `package.json` — remove the `"js-yaml": "^4.1.0"` line from `dependencies`, leaving only `express`:

```json
{
  "name": "stremio-tuner",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

- [ ] **Step 3: Reinstall to update the lockfile, then run the full suite**

```bash
npm install
npm test
```

Expected: PASS, 0 failures (7 fewer tests than before this task, since `config.test.js` is gone — the exact prior/after counts don't matter; just confirm 0 failures).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "Remove YAML config system (config.yml/js-yaml), replaced by admin-managed channels.json"
```

Note: `git add` won't need to explicitly mention the deleted files — `git commit` will pick up the deletions once staged. Stage them explicitly if `git status` doesn't show them as already staged:

```bash
git add -u
git commit -m "Remove YAML config system (config.yml/js-yaml), replaced by admin-managed channels.json"
```

(Use whichever of the two commits actually captures the deletions plus the `package.json`/`package-lock.json` changes — check `git status` first and stage everything shown as modified/deleted before committing once.)

---

### Task 2: Channel store

**Files:**
- Modify: `src/streamSelect.js:1,3-10` (export `QUALITY_ORDER`, add `SUPPORTED_LANGUAGES` export)
- Create: `src/channelStore.js`
- Test: `test/channelStore.test.js`

**Interfaces:**
- Consumes: `QUALITY_ORDER`, `SUPPORTED_LANGUAGES` from `src/streamSelect.js`
- Produces: `slugify(text) -> string`, `channelId(addon, catalog) -> string`, `channelsPath(dataDir) -> string`, `readChannels(dataDir, options) -> Promise<Array>`, `writeChannels(dataDir, channels, options) -> Promise<void>`, `validateNewChannelFields({mode, minQuality, language}) -> void` (throws on invalid), `validatePatchFields(patch) -> void` (throws on invalid; only checks fields present in `patch`)

- [ ] **Step 1: Modify `src/streamSelect.js` to export the quality/language constant lists**

Find (near the top of the file):

```js
const QUALITY_ORDER = ['480p', '720p', '1080p', '2160p'];

const LANGUAGE_KEYWORDS = {
  en: ['english'],
  es: ['spanish', 'latino', 'espanol'],
  fr: ['french', 'francais'],
  de: ['german', 'deutsch'],
  it: ['italian', 'italiano'],
  pt: ['portuguese', 'portugues']
};
```

Replace with:

```js
export const QUALITY_ORDER = ['480p', '720p', '1080p', '2160p'];

const LANGUAGE_KEYWORDS = {
  en: ['english'],
  es: ['spanish', 'latino', 'espanol'],
  fr: ['french', 'francais'],
  de: ['german', 'deutsch'],
  it: ['italian', 'italiano'],
  pt: ['portuguese', 'portugues']
};

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_KEYWORDS);
```

(Everything else in the file — `parseQuality`, `qualityRank`, `parsePeers`, `matchesLanguage`, `selectStream`, etc. — is unchanged.)

- [ ] **Step 2: Run the existing streamSelect tests to confirm nothing broke**

```bash
node --test test/streamSelect.test.js
```

Expected: PASS, same test count as before (exporting existing constants doesn't change any behavior).

- [ ] **Step 3: Write the failing tests for `channelStore.js`**

Create `test/channelStore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  channelsPath,
  readChannels,
  writeChannels,
  channelId,
  slugify,
  validateNewChannelFields,
  validatePatchFields
} from '../src/channelStore.js';

test('channelsPath joins dataDir/channels.json', () => {
  assert.equal(channelsPath('/data'), path.join('/data', 'channels.json'));
});

test('slugify lowercases and dashes non-alnum characters', () => {
  assert.equal(slugify('org.stremio.torrentio.addon:marvel-movies'), 'org-stremio-torrentio-addon-marvel-movies');
});

test('channelId derives a stable id from addon and catalog', () => {
  assert.equal(channelId('org.a', 'cat-b'), slugify('org.a:cat-b'));
});

test('readChannels returns an empty array when the file does not exist', async () => {
  const fakeFs = {
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
  };
  const result = await readChannels('/data', { fs: fakeFs });
  assert.deepEqual(result, []);
});

test('readChannels parses the persisted JSON', async () => {
  const fakeFs = { readFile: async () => JSON.stringify([{ id: 'x' }]) };
  const result = await readChannels('/data', { fs: fakeFs });
  assert.deepEqual(result, [{ id: 'x' }]);
});

test('writeChannels creates the directory and writes JSON', async () => {
  const calls = { mkdir: null, writeFile: null };
  const fakeFs = {
    mkdir: async (dir, opts) => { calls.mkdir = { dir, opts }; },
    writeFile: async (p, content) => { calls.writeFile = { p, content }; }
  };
  await writeChannels('/data', [{ id: 'x' }], { fs: fakeFs });
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.ok(calls.writeFile.p.endsWith('channels.json'));
  assert.deepEqual(JSON.parse(calls.writeFile.content), [{ id: 'x' }]);
});

test('validateNewChannelFields accepts a valid mode/minQuality/language combination', () => {
  assert.doesNotThrow(() => validateNewChannelFields({ mode: 'random-start', minQuality: '720p', language: 'en' }));
});

test('validateNewChannelFields rejects an invalid mode', () => {
  assert.throws(() => validateNewChannelFields({ mode: 'shuffle', minQuality: '720p', language: 'en' }), /mode/);
});

test('validateNewChannelFields rejects an invalid minQuality', () => {
  assert.throws(() => validateNewChannelFields({ mode: 'random', minQuality: '4k', language: 'en' }), /minQuality/);
});

test('validateNewChannelFields rejects an invalid language', () => {
  assert.throws(() => validateNewChannelFields({ mode: 'random', minQuality: '720p', language: 'xx' }), /language/);
});

test('validatePatchFields ignores fields that are absent', () => {
  assert.doesNotThrow(() => validatePatchFields({ enabled: false }));
});

test('validatePatchFields validates fields that are present', () => {
  assert.throws(() => validatePatchFields({ mode: 'bogus' }), /mode/);
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
node --test test/channelStore.test.js
```

Expected: FAIL with `Cannot find module '../src/channelStore.js'`

- [ ] **Step 5: Implement `src/channelStore.js`**

```js
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { QUALITY_ORDER, SUPPORTED_LANGUAGES } from './streamSelect.js';

const VALID_MODES = ['random', 'random-start'];

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

export function channelId(addon, catalog) {
  return slugify(`${addon}:${catalog}`);
}

export function channelsPath(dataDir) {
  return path.join(dataDir, 'channels.json');
}

export async function readChannels(dataDir, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(channelsPath(dataDir), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function writeChannels(dataDir, channels, { fs = fsPromises } = {}) {
  const filePath = channelsPath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(channels, null, 2));
}

export function validateNewChannelFields({ mode, minQuality, language }) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode "${mode}" (must be one of ${VALID_MODES.join(', ')})`);
  }
  if (!QUALITY_ORDER.includes(minQuality)) {
    throw new Error(`Invalid minQuality "${minQuality}" (must be one of ${QUALITY_ORDER.join(', ')})`);
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`Invalid language "${language}" (must be one of ${SUPPORTED_LANGUAGES.join(', ')})`);
  }
}

export function validatePatchFields(patch) {
  if (patch.mode !== undefined && !VALID_MODES.includes(patch.mode)) {
    throw new Error(`Invalid mode "${patch.mode}" (must be one of ${VALID_MODES.join(', ')})`);
  }
  if (patch.minQuality !== undefined && !QUALITY_ORDER.includes(patch.minQuality)) {
    throw new Error(`Invalid minQuality "${patch.minQuality}" (must be one of ${QUALITY_ORDER.join(', ')})`);
  }
  if (patch.language !== undefined && !SUPPORTED_LANGUAGES.includes(patch.language)) {
    throw new Error(`Invalid language "${patch.language}" (must be one of ${SUPPORTED_LANGUAGES.join(', ')})`);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
node --test test/channelStore.test.js
```

Expected: PASS (12 tests)

- [ ] **Step 7: Run the full suite to confirm no regressions, then commit**

```bash
npm test
git add src/streamSelect.js src/channelStore.js test/channelStore.test.js
git commit -m "Add channelStore for persisted, admin-managed channel list"
```

---

### Task 3: Channel actions (business logic)

**Files:**
- Create: `src/channelActions.js`
- Test: `test/channelActions.test.js`

**Interfaces:**
- Consumes: `channelId`, `validateNewChannelFields`, `validatePatchFields`, `readChannels`, `writeChannels` from `src/channelStore.js`
- Produces: `ValidationError` (class, extends `Error`), `NotFoundError` (class, extends `Error`), `createChannelActions({ dataDir, channels, discoverInstalledAddons, resolveSourceImpl, regenerateImpl, readChannelsImpl?, writeChannelsImpl? }) -> { listCatalogs, listChannels, addChannel, updateChannel }` where:
  - `discoverInstalledAddons: () => Promise<Array|null>` — returns installed addons or `null` if Stremio login/discovery is currently degraded (this exact function is what `bootstrap.js` already builds internally in Task 6 — here it's just injected)
  - `resolveSourceImpl: (channel, installedAddons) => source|null` — resolves one channel's addon source, or `null` if unresolvable (this is `bootstrap.js`'s existing `resolveSource` closure, injected — not reimplemented here, to avoid duplicating that logic)
  - `regenerateImpl: (liveChannel) => Promise<void>` — generates and persists one channel's schedule, logging (not throwing) on failure (this is `bootstrap.js`'s existing `regenerate` closure, injected — same reasoning)
  - `channels` is the **same array reference** `bootstrap.js` passes into `createApp` — `addChannel`/`updateChannel` mutate it in place (`push`/`splice`/`Object.assign`), never replace it

- [ ] **Step 1: Write the failing tests**

Create `test/channelActions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelActions, ValidationError, NotFoundError } from '../src/channelActions.js';

function baseDeps(overrides = {}) {
  return {
    dataDir: '/data',
    channels: [],
    discoverInstalledAddons: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', name: 'Addon A', catalogs: [{ id: 'cat-a', name: 'Cat A', type: 'movie' }] } }
    ],
    resolveSourceImpl: (channel, installedAddons) => {
      if (!installedAddons) return null;
      const addonEntry = installedAddons.find((a) => a.manifest.id === channel.addon);
      if (!addonEntry) return null;
      const catalog = addonEntry.manifest.catalogs.find((c) => c.id === channel.catalog);
      if (!catalog) return null;
      return { transportUrl: addonEntry.transportUrl, type: catalog.type };
    },
    regenerateImpl: async () => {},
    readChannelsImpl: async () => [],
    writeChannelsImpl: async () => {},
    ...overrides
  };
}

test('listCatalogs returns degraded when Stremio discovery is unavailable', async () => {
  const actions = createChannelActions(baseDeps({ discoverInstalledAddons: async () => null }));
  const result = await actions.listCatalogs();
  assert.deepEqual(result, { degraded: true, catalogs: [] });
});

test('listCatalogs flattens every installed addon\'s catalogs and marks already-added ones', async () => {
  const actions = createChannelActions(baseDeps({
    readChannelsImpl: async () => [{ id: 'org-a-cat-a', addon: 'org.a', catalog: 'cat-a' }]
  }));
  const result = await actions.listCatalogs();
  assert.equal(result.degraded, false);
  assert.deepEqual(result.catalogs, [{
    addon: 'org.a', addonName: 'Addon A', catalog: 'cat-a', catalogName: 'Cat A', type: 'movie', channelId: 'org-a-cat-a'
  }]);
});

test('listCatalogs marks a catalog with no matching channel as channelId: null', async () => {
  const actions = createChannelActions(baseDeps());
  const result = await actions.listCatalogs();
  assert.equal(result.catalogs[0].channelId, null);
});

test('listChannels returns the persisted channel list', async () => {
  const actions = createChannelActions(baseDeps({ readChannelsImpl: async () => [{ id: 'x' }] }));
  const result = await actions.listChannels();
  assert.deepEqual(result, [{ id: 'x' }]);
});

test('addChannel rejects an invalid mode before touching the network or disk', async () => {
  let discoverCalled = false;
  const actions = createChannelActions(baseDeps({ discoverInstalledAddons: async () => { discoverCalled = true; return []; } }));
  await assert.rejects(
    () => actions.addChannel({ addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'bogus', minQuality: '720p', language: 'en' }),
    ValidationError
  );
  assert.equal(discoverCalled, false);
});

test('addChannel rejects when the addon/catalog cannot be resolved', async () => {
  const actions = createChannelActions(baseDeps({ resolveSourceImpl: () => null }));
  await assert.rejects(
    () => actions.addChannel({ addon: 'org.missing', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en' }),
    ValidationError
  );
});

test('addChannel rejects a duplicate addon/catalog combination', async () => {
  const actions = createChannelActions(baseDeps({
    readChannelsImpl: async () => [{ id: 'org-a-cat-a', addon: 'org.a', catalog: 'cat-a' }]
  }));
  await assert.rejects(
    () => actions.addChannel({ addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en' }),
    ValidationError
  );
});

test('addChannel persists the record, pushes it into the live channels array with a resolved source, and regenerates its schedule', async () => {
  const channels = [];
  let written = null;
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    writeChannelsImpl: async (dataDir, list) => { written = list; },
    regenerateImpl: async (liveChannel) => { regenerated = liveChannel; }
  }));

  const record = await actions.addChannel({ addon: 'org.a', catalog: 'cat-a', name: 'Marvel Movies', mode: 'random-start', minQuality: '720p', language: 'en' });

  assert.equal(record.id, 'org-a-cat-a');
  assert.equal(record.enabled, true);
  assert.deepEqual(written, [record]);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.equal(regenerated, channels[0]);
});

test('updateChannel rejects an unknown id', async () => {
  const actions = createChannelActions(baseDeps());
  await assert.rejects(() => actions.updateChannel('unknown', { enabled: false }), NotFoundError);
});

test('updateChannel disabling a channel removes it from the live array but keeps it persisted', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const channels = [{ ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } }];
  let written = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    writeChannelsImpl: async (dataDir, list) => { written = list; }
  }));

  const updated = await actions.updateChannel('x', { enabled: false });

  assert.equal(updated.enabled, false);
  assert.equal(channels.length, 0);
  assert.equal(written[0].enabled, false);
});

test('updateChannel enabling a previously-disabled channel re-resolves its source and regenerates its schedule', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: false }];
  const channels = [];
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    regenerateImpl: async (liveChannel) => { regenerated = liveChannel; }
  }));

  const updated = await actions.updateChannel('x', { enabled: true });

  assert.equal(updated.enabled, true);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.equal(regenerated, channels[0]);
});

test('updateChannel changing mode on an already-enabled channel mutates it in place and regenerates', async () => {
  const persisted = [{ id: 'x', addon: 'org.a', catalog: 'cat-a', name: 'X', mode: 'random', minQuality: '720p', language: 'en', enabled: true }];
  const liveChannel = { ...persisted[0], source: { transportUrl: 'https://a/manifest.json', type: 'movie' } };
  const channels = [liveChannel];
  let regenerated = null;
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => persisted,
    regenerateImpl: async (ch) => { regenerated = ch; }
  }));

  await actions.updateChannel('x', { mode: 'random-start' });

  assert.equal(channels.length, 1);
  assert.equal(channels[0], liveChannel); // same object reference, mutated in place
  assert.equal(channels[0].mode, 'random-start');
  assert.equal(regenerated, liveChannel);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/channelActions.test.js
```

Expected: FAIL with `Cannot find module '../src/channelActions.js'`

- [ ] **Step 3: Implement `src/channelActions.js`**

```js
import { channelId, validateNewChannelFields, validatePatchFields, readChannels, writeChannels } from './channelStore.js';

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export function createChannelActions({
  dataDir,
  channels,
  discoverInstalledAddons,
  resolveSourceImpl,
  regenerateImpl,
  readChannelsImpl = readChannels,
  writeChannelsImpl = writeChannels
}) {
  async function listCatalogs() {
    const installedAddons = await discoverInstalledAddons();
    if (!installedAddons) return { degraded: true, catalogs: [] };

    const persisted = await readChannelsImpl(dataDir);
    const byKey = new Map(persisted.map((ch) => [channelId(ch.addon, ch.catalog), ch.id]));

    const catalogs = installedAddons.flatMap((entry) => (entry.manifest.catalogs || []).map((catalog) => ({
      addon: entry.manifest.id,
      addonName: entry.manifest.name,
      catalog: catalog.id,
      catalogName: catalog.name,
      type: catalog.type,
      channelId: byKey.get(channelId(entry.manifest.id, catalog.id)) || null
    })));

    return { degraded: false, catalogs };
  }

  async function listChannels() {
    return readChannelsImpl(dataDir);
  }

  async function addChannel({ addon, catalog, name, mode, minQuality, language }) {
    validateNewChannelFields({ mode, minQuality, language });

    const persisted = await readChannelsImpl(dataDir);
    const id = channelId(addon, catalog);
    if (persisted.some((ch) => ch.id === id)) {
      throw new ValidationError(`Channel for addon "${addon}" / catalog "${catalog}" already exists`);
    }

    const installedAddons = await discoverInstalledAddons();
    const source = resolveSourceImpl({ addon, catalog, name }, installedAddons);
    if (!source) {
      throw new ValidationError(`Could not resolve addon "${addon}" / catalog "${catalog}" from your installed Stremio addons`);
    }

    const record = { id, addon, catalog, name, mode, minQuality, language, enabled: true };
    await writeChannelsImpl(dataDir, [...persisted, record]);

    const liveChannel = { ...record, source };
    channels.push(liveChannel);
    await regenerateImpl(liveChannel);

    return record;
  }

  async function updateChannel(id, patch) {
    validatePatchFields(patch);

    const persisted = await readChannelsImpl(dataDir);
    const index = persisted.findIndex((ch) => ch.id === id);
    if (index === -1) {
      throw new NotFoundError(`No channel with id "${id}"`);
    }

    const updated = { ...persisted[index], ...patch };
    const nextPersisted = [...persisted];
    nextPersisted[index] = updated;
    await writeChannelsImpl(dataDir, nextPersisted);

    const liveIndex = channels.findIndex((ch) => ch.id === id);

    if (updated.enabled === false) {
      if (liveIndex !== -1) channels.splice(liveIndex, 1);
      return updated;
    }

    if (liveIndex === -1) {
      const installedAddons = await discoverInstalledAddons();
      const source = resolveSourceImpl(updated, installedAddons);
      const liveChannel = { ...updated, source };
      channels.push(liveChannel);
      await regenerateImpl(liveChannel);
    } else {
      Object.assign(channels[liveIndex], updated);
      await regenerateImpl(channels[liveIndex]);
    }

    return updated;
  }

  return { listCatalogs, listChannels, addChannel, updateChannel };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/channelActions.test.js
```

Expected: PASS (12 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions, then commit**

```bash
npm test
git add src/channelActions.js test/channelActions.test.js
git commit -m "Add channelActions: catalog browsing and add/enable/disable/edit business logic"
```

---

### Task 4: Admin HTTP routes

**Files:**
- Create: `src/server/adminRoutes.js`
- Test: `test/adminRoutes.test.js`

**Interfaces:**
- Consumes: `ValidationError`, `NotFoundError` from `src/channelActions.js` (only the error classes — the actual `channelActions` object is injected as a plain parameter, not imported)
- Produces: `createAdminRouter(channelActions) -> ExpressRouter` mounting `GET /catalogs`, `GET /channels`, `POST /channels`, `PATCH /channels/:id`

- [ ] **Step 1: Write the failing tests**

Create `test/adminRoutes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter } from '../src/server/adminRoutes.js';
import { ValidationError, NotFoundError } from '../src/channelActions.js';

async function withRouter(t, channelActions) {
  const app = express();
  app.use('/admin', createAdminRouter(channelActions));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://localhost:${port}/admin`;
}

test('GET /admin/catalogs proxies to channelActions.listCatalogs', async (t) => {
  const baseUrl = await withRouter(t, {
    listCatalogs: async () => ({ degraded: false, catalogs: [{ addon: 'a', catalog: 'b' }] })
  });
  const res = await fetch(`${baseUrl}/catalogs`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { degraded: false, catalogs: [{ addon: 'a', catalog: 'b' }] });
});

test('GET /admin/channels proxies to channelActions.listChannels', async (t) => {
  const baseUrl = await withRouter(t, { listChannels: async () => [{ id: 'x' }] });
  const res = await fetch(`${baseUrl}/channels`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, [{ id: 'x' }]);
});

test('POST /admin/channels returns 201 with the created record', async (t) => {
  const baseUrl = await withRouter(t, {
    addChannel: async (input) => ({ id: 'new-id', ...input, enabled: true })
  });
  const res = await fetch(`${baseUrl}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addon: 'a', catalog: 'b', name: 'X', mode: 'random', minQuality: '720p', language: 'en' })
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.id, 'new-id');
});

test('POST /admin/channels returns 400 when channelActions throws ValidationError', async (t) => {
  const baseUrl = await withRouter(t, {
    addChannel: async () => { throw new ValidationError('bad input'); }
  });
  const res = await fetch(`${baseUrl}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, 'bad input');
});

test('POST /admin/channels returns 500 on an unexpected error', async (t) => {
  const baseUrl = await withRouter(t, {
    addChannel: async () => { throw new Error('disk exploded'); }
  });
  const res = await fetch(`${baseUrl}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 500);
});

test('PATCH /admin/channels/:id returns the updated record', async (t) => {
  const baseUrl = await withRouter(t, {
    updateChannel: async (id, patch) => ({ id, enabled: patch.enabled })
  });
  const res = await fetch(`${baseUrl}/channels/x`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { id: 'x', enabled: false });
});

test('PATCH /admin/channels/:id returns 404 when channelActions throws NotFoundError', async (t) => {
  const baseUrl = await withRouter(t, {
    updateChannel: async () => { throw new NotFoundError('no such channel'); }
  });
  const res = await fetch(`${baseUrl}/channels/unknown`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error, 'no such channel');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/adminRoutes.test.js
```

Expected: FAIL with `Cannot find module '../src/server/adminRoutes.js'`

- [ ] **Step 3: Implement `src/server/adminRoutes.js`**

```js
import express from 'express';
import { ValidationError, NotFoundError } from '../channelActions.js';

export function createAdminRouter(channelActions) {
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

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/adminRoutes.test.js
```

Expected: PASS (7 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions, then commit**

```bash
npm test
git add src/server/adminRoutes.js test/adminRoutes.test.js
git commit -m "Add admin HTTP routes wrapping channelActions"
```

---

### Task 5: Wire admin routes + static UI serving into the Express app

**Files:**
- Modify: `src/server/app.js`
- Modify: `test/app.test.js`
- Create: `public/index.html` (minimal placeholder — Task 7 replaces its content)

**Interfaces:**
- Consumes: `createAdminRouter` from `src/server/adminRoutes.js`
- Produces: `createApp` gains an optional `channelActions` parameter; when provided, `/admin/*` routes are mounted. `GET /` (and any other static path) serves files from the project's `public/` directory unconditionally (independent of `channelActions`).

- [ ] **Step 1: Create a minimal placeholder `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>stremioTuner</title>
</head>
<body>
  <p>stremioTuner admin UI — coming soon.</p>
</body>
</html>
```

- [ ] **Step 2: Write the failing tests**

Add to `test/app.test.js` (append after the existing tests, before the final closing of the file — the existing `withApp` helper needs a small extension first):

Find:

```js
async function withApp(t, { channels, schedules = {}, corruptSchedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl } = {}) {
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
    nowImpl
  });
```

Replace with:

```js
async function withApp(t, { channels, schedules = {}, corruptSchedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl, channelActions } = {}) {
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
    channelActions
  });
```

Then append these three new tests at the end of the file:

```js
test('GET / serves the static admin UI', async (t) => {
  const baseUrl = await withApp(t, { channels: [] });
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
});

test('admin routes are mounted and reachable when channelActions is provided', async (t) => {
  const baseUrl = await withApp(t, {
    channels: [],
    channelActions: { listChannels: async () => [{ id: 'x' }] }
  });
  const res = await fetch(`${baseUrl}/admin/channels`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, [{ id: 'x' }]);
});

test('admin routes 404 when channelActions is not provided', async (t) => {
  const baseUrl = await withApp(t, { channels: [] });
  const res = await fetch(`${baseUrl}/admin/channels`);
  assert.equal(res.status, 404);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test test/app.test.js
```

Expected: FAIL — the two new "admin routes"/static tests fail because `createApp` doesn't yet accept `channelActions` or serve static files.

- [ ] **Step 4: Modify `src/server/app.js`**

Full new contents:

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildM3u } from '../m3u.js';
import { buildXmltv } from '../xmltv.js';
import { readSchedule } from '../scheduleStore.js';
import { selectStream } from '../streamSelect.js';
import { fetchStreams } from '../addonClient.js';
import { streamViaFfmpeg } from './ffmpegProxy.js';
import { createAdminRouter } from './adminRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export function createApp({
  channels,
  dataDir,
  baseUrl,
  channelActions,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  nowImpl = () => new Date()
}) {
  const app = express();

  app.use(express.static(PUBLIC_DIR));

  if (channelActions) {
    app.use('/admin', createAdminRouter(channelActions));
  }

  app.get('/playlist.m3u', (req, res) => {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(buildM3u(channels, baseUrl));
  });

  app.get('/epg.xml', async (req, res) => {
    try {
      const withSchedules = await Promise.all(channels.map(async (ch) => ({
        ...ch,
        schedule: await readSchedule(dataDir, ch.id)
      })));
      res.setHeader('Content-Type', 'application/xml');
      res.send(buildXmltv(withSchedules));
    } catch (err) {
      console.error('Failed to build EPG:', err);
      res.status(500).end('Internal server error');
    }
  });

  app.get('/stream/:channelId', async (req, res) => {
    try {
      const channel = channels.find((c) => c.id === req.params.channelId);
      if (!channel) {
        res.status(404).end('Unknown channel');
        return;
      }

      const schedule = await readSchedule(dataDir, channel.id);
      const now = nowImpl().getTime();
      const item = schedule?.items.find((i) => new Date(i.start).getTime() <= now && now < new Date(i.end).getTime());
      if (!item) {
        res.status(404).end('No program currently scheduled');
        return;
      }

      if (!channel.source) {
        res.status(502).end('Channel source unavailable (Stremio addon discovery failed)');
        return;
      }

      const offsetSeconds = (now - new Date(item.start).getTime()) / 1000;
      const streams = await fetchStreamsImpl(channel.source.transportUrl, channel.source.type, item.id);
      const selected = selectStream(streams, { minQuality: channel.minQuality, language: channel.language });
      if (!selected) {
        res.status(502).end('No playable stream found');
        return;
      }

      await streamViaFfmpegImpl({ sourceUrl: selected.url, offsetSeconds, res });
    } catch (err) {
      console.error('Failed to serve stream:', err);
      if (!res.headersSent) {
        res.status(500).end('Internal server error');
      }
    }
  });

  return app;
}
```

(Only the imports, the `PUBLIC_DIR` constant, the `channelActions` parameter, and the two new `app.use(...)` calls at the top are new — `/playlist.m3u`, `/epg.xml`, and `/stream/:channelId` are unchanged from before.)

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test test/app.test.js
```

Expected: PASS (13 tests — 10 existing + 3 new)

- [ ] **Step 6: Run the full suite to confirm no regressions, then commit**

```bash
npm test
git add src/server/app.js test/app.test.js public/index.html
git commit -m "Mount admin routes and serve static admin UI from the Express app"
```

---

### Task 6: Wire channelStore/channelActions into bootstrap.js

**Files:**
- Modify: `src/bootstrap.js`
- Modify: `test/bootstrap.test.js`

**Interfaces:**
- Consumes: `readChannels`, `writeChannels` from `src/channelStore.js`; `createChannelActions` from `src/channelActions.js`
- Produces: `bootstrap(overrides)` — same return shape as before (`{ app, channels, server, startupRegenerationDone }`), now also including `channelActions` in the returned object. `config.yml`/`loadConfig`/`CONFIG_PATH` are gone; the global refresh time comes from `env.REFRESH_TIME` (default `"00:00"`); the channel list comes from `channelStore` (only `enabled: true` entries populate the live `channels` array).

- [ ] **Step 1: Write the failing/updated tests**

Replace the full contents of `test/bootstrap.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/bootstrap.js';

function fakeApp() {
  return { listen: (port, cb) => { cb?.(); return { address: () => ({ port }) }; } };
}

function channel(overrides = {}) {
  return { mode: 'random', minQuality: '480p', language: 'en', enabled: true, ...overrides };
}

test('bootstrap resolves each channel\'s source and only regenerates stale schedules', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { DATA_DIR: '/data', PORT: '9999', BASE_URL: 'http://localhost:9999', STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'fresh', name: 'Fresh', addon: 'org.a', catalog: 'cat-a' }),
      channel({ id: 'stale', name: 'Stale', addon: 'org.b', catalog: 'cat-b', mode: 'random-start' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://b/manifest.json', manifest: { id: 'org.b', catalogs: [{ id: 'cat-b', type: 'series' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async (dataDir, channelId) => (channelId === 'fresh' ? { generatedAt: '2026-07-22T00:00:00.000Z', items: [] } : null),
    isScheduleFreshImpl: (schedule) => schedule !== null,
    generateChannelScheduleImpl: async ({ channel }) => ({ generatedAt: 'new', items: [], channelId: channel.id }),
    writeScheduleImpl: async (dataDir, channelId, schedule) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.deepEqual(writtenSchedules, ['stale']);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'fresh').source.transportUrl, 'https://a/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'stale').source.type, 'series');
  assert.equal(result.app, createdAppArgs[0] && result.app);
  assert.ok(result.channelActions);
});

test('bootstrap only loads enabled channels into the live array', async () => {
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'on', name: 'On', addon: 'org.a', catalog: 'cat-a', enabled: true }),
      channel({ id: 'off', name: 'Off', addon: 'org.a', catalog: 'cat-a', enabled: false })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.deepEqual(createdAppArgs[0].channels.map((c) => c.id), ['on']);
});

test('bootstrap retries a failing getAuthKey with backoff before giving up', async () => {
  let attempts = 0;
  const sleeps = [];
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('login failed');
      return 'auth-key';
    },
    sleepImpl: async (ms) => { sleeps.push(ms); },
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async () => ({ generatedAt: 'new', items: [] }),
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(attempts, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(createdAppArgs[0].channels[0].source.transportUrl, 'https://a/manifest.json');
});

test('bootstrap still starts the server with source: null when login fails permanently', async () => {
  const createdAppArgs = [];
  const writtenSchedules = [];

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'wrong' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => { throw new Error('always fails'); },
    invalidateAuthKeyImpl: async () => {},
    sleepImpl: async () => {},
    readScheduleImpl: async () => ({ generatedAt: '2026-07-22T00:00:00.000Z', items: [] }),
    isScheduleFreshImpl: () => true,
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.equal(createdAppArgs[0].channels[0].source, null);
  assert.deepEqual(writtenSchedules, []);
  assert.ok(result.server);
});

test('bootstrap catches a schedule generation failure for one channel without affecting others', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'bad', name: 'Bad', addon: 'org.a', catalog: 'cat-a' }),
      channel({ id: 'good', name: 'Good', addon: 'org.b', catalog: 'cat-b' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } },
      { transportUrl: 'https://b/manifest.json', manifest: { id: 'org.b', catalogs: [{ id: 'cat-b', type: 'series' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => {
      if (ch.id === 'bad') throw new Error('generation exploded');
      return { generatedAt: 'new', items: [], channelId: ch.id };
    },
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.deepEqual(writtenSchedules, ['good']);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'bad').source.transportUrl, 'https://a/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'good').source.transportUrl, 'https://b/manifest.json');
  assert.ok(result.server);
});

test('bootstrap resolves source: null for a channel whose addon lookup fails while another channel resolves normally', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([
      channel({ id: 'missing', name: 'Missing', addon: 'org.missing', catalog: 'cat-a' }),
      channel({ id: 'ok', name: 'Ok', addon: 'org.b', catalog: 'cat-b' })
    ]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://b/manifest.json', manifest: { id: 'org.b', catalogs: [{ id: 'cat-b', type: 'series' }] } }
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
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });
  await result.startupRegenerationDone;

  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'missing').source, null);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'ok').source.transportUrl, 'https://b/manifest.json');
  assert.deepEqual(writtenSchedules.sort(), ['ok']);
  assert.ok(result.server);
});

test('bootstrap calls app.listen before the startup schedule-regeneration pass resolves', async () => {
  const events = [];
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => {
      await generationGate;
      events.push('generated');
      return { generatedAt: 'new', items: [], channelId: ch.id };
    },
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => ({
      listen: (port, cb) => { events.push('listen'); cb?.(); return { address: () => ({ port }) }; }
    })
  });

  assert.deepEqual(events, ['listen']);

  releaseGeneration();
  await result.startupRegenerationDone;
  assert.deepEqual(events, ['listen', 'generated']);
});

test('daily cron re-resolves a channel whose source is null and regenerates its schedule', async () => {
  const writtenSchedules = [];
  let cronCallback;
  let discoveryAttempts = 0;

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => {
      discoveryAttempts += 1;
      if (discoveryAttempts <= 4) throw new Error('login failed at startup');
      return 'auth-key';
    },
    invalidateAuthKeyImpl: async () => {},
    sleepImpl: async () => {},
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', catalogs: [{ id: 'cat-a', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: (refreshTime, cb) => { cronCallback = cb; return { cancel() {} }; },
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].source, null);
  assert.deepEqual(writtenSchedules, []);

  await cronCallback();

  assert.equal(result.channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.deepEqual(writtenSchedules, ['x']);
});

test('daily cron invalidates the cached auth key when re-resolution discovery fails again', async () => {
  let invalidateCalls = 0;
  let cronCallback;

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => { throw new Error('always fails'); },
    invalidateAuthKeyImpl: async () => { invalidateCalls += 1; },
    sleepImpl: async () => {},
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: (refreshTime, cb) => { cronCallback = cb; return { cancel() {} }; },
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(invalidateCalls, 1);
  assert.equal(result.channels[0].source, null);

  await cronCallback();

  assert.equal(invalidateCalls, 2);
  assert.equal(result.channels[0].source, null);
});

test('bootstrap wires a real channelActions instance that can add a channel and have it appear live immediately', async () => {
  const writtenSchedules = [];
  let writtenChannels = null;

  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => [],
    writeChannelsImpl: async (dataDir, list) => { writtenChannels = list; },
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [
      { transportUrl: 'https://a/manifest.json', manifest: { id: 'org.a', name: 'Addon A', catalogs: [{ id: 'cat-a', name: 'Cat A', type: 'movie' }] } }
    ],
    findAddonByIdImpl: (addons, id) => addons.find((a) => a.manifest.id === id),
    resolveChannelSourceImpl: (manifest, catalogId) => manifest.catalogs.find((c) => c.id === catalogId),
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    generateChannelScheduleImpl: async ({ channel: ch }) => ({ generatedAt: 'new', items: [], channelId: ch.id }),
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels.length, 0);

  const record = await result.channelActions.addChannel({
    addon: 'org.a', catalog: 'cat-a', name: 'New Channel', mode: 'random', minQuality: '480p', language: 'en'
  });

  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].id, record.id);
  assert.equal(result.channels[0].source.transportUrl, 'https://a/manifest.json');
  assert.deepEqual(writtenChannels, [record]);
  assert.deepEqual(writtenSchedules, [record.id]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/bootstrap.test.js
```

Expected: FAIL — `bootstrap.js` still imports `loadConfig` from the now-deleted `src/config.js`, so every test fails at import time.

- [ ] **Step 3: Modify `src/bootstrap.js`**

Full new contents:

```js
import { readChannels, writeChannels } from './channelStore.js';
import { getAuthKey, getInstalledAddons, findAddonById, invalidateAuthKey } from './stremioAccount.js';
import { resolveChannelSource } from './addonClient.js';
import { generateChannelSchedule } from './generateSchedule.js';
import { readSchedule, writeSchedule, isScheduleFresh } from './scheduleStore.js';
import { scheduleDailyAt } from './scheduling.js';
import { createApp } from './server/app.js';
import { createChannelActions } from './channelActions.js';

export async function withRetries(fn, { retries = 3, delayMs = 1000, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleepImpl(delayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function bootstrap({
  env = process.env,
  readChannelsImpl = readChannels,
  writeChannelsImpl = writeChannels,
  getAuthKeyImpl = getAuthKey,
  getInstalledAddonsImpl = getInstalledAddons,
  findAddonByIdImpl = findAddonById,
  invalidateAuthKeyImpl = invalidateAuthKey,
  resolveChannelSourceImpl = resolveChannelSource,
  generateChannelScheduleImpl = generateChannelSchedule,
  readScheduleImpl = readSchedule,
  writeScheduleImpl = writeSchedule,
  isScheduleFreshImpl = isScheduleFresh,
  scheduleDailyAtImpl = scheduleDailyAt,
  createAppImpl = createApp,
  createChannelActionsImpl = createChannelActions,
  sleepImpl
} = {}) {
  const dataDir = env.DATA_DIR || '/data';
  const refreshTime = env.REFRESH_TIME || '00:00';
  const port = Number(env.PORT || 8080);
  const baseUrl = env.BASE_URL || `http://localhost:${port}`;
  const authCachePath = `${dataDir}/auth.json`;

  // Attempts to log in and fetch the installed addon list. On failure (after
  // retries), invalidates the cached auth key so a stale/expired key isn't
  // reused forever on subsequent attempts (startup or cron re-resolution).
  async function discoverInstalledAddons() {
    try {
      const authKey = await withRetries(() => getAuthKeyImpl({
        email: env.STREMIO_EMAIL,
        password: env.STREMIO_PASSWORD,
        cachePath: authCachePath
      }), { sleepImpl });
      return await withRetries(() => getInstalledAddonsImpl(authKey), { sleepImpl });
    } catch (err) {
      console.error(`Stremio login/addon discovery failed after retries: ${err.message}`);
      try {
        await invalidateAuthKeyImpl(authCachePath);
      } catch (invalidateErr) {
        console.error(`Failed to invalidate cached auth key: ${invalidateErr.message}`);
      }
      return null;
    }
  }

  function resolveSource(channel, installedAddons) {
    if (!installedAddons) return null;
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, channel.addon);
      return {
        transportUrl: addonEntry.transportUrl,
        ...resolveChannelSourceImpl(addonEntry.manifest, channel.catalog)
      };
    } catch (err) {
      console.error(`Could not resolve addon source for channel "${channel.name}": ${err.message}`);
      return null;
    }
  }

  async function regenerate(channel) {
    if (!channel.source) {
      console.error(`Skipping schedule regeneration for "${channel.name}": no resolved addon source`);
      return;
    }
    try {
      const schedule = await generateChannelScheduleImpl({ channel, source: channel.source });
      await writeScheduleImpl(dataDir, channel.id, schedule);
    } catch (err) {
      console.error(`Schedule generation failed for "${channel.name}": ${err.message}`);
    }
  }

  const installedAddonsAtStartup = await discoverInstalledAddons();
  if (!installedAddonsAtStartup) {
    console.error('Continuing with cached schedules only.');
  }

  const persistedChannels = await readChannelsImpl(dataDir);
  const channels = persistedChannels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      ...channel,
      source: resolveSource(channel, installedAddonsAtStartup)
    }));

  async function runStartupRegeneration() {
    for (const channel of channels) {
      const existing = await readScheduleImpl(dataDir, channel.id);
      if (!isScheduleFreshImpl(existing, refreshTime, new Date())) {
        await regenerate(channel);
      }
    }
  }

  async function runDailyRegeneration() {
    const channelsNeedingSource = channels.filter((channel) => !channel.source);
    if (channelsNeedingSource.length > 0) {
      const installedAddons = await discoverInstalledAddons();
      if (installedAddons) {
        for (const channel of channelsNeedingSource) {
          const source = resolveSource(channel, installedAddons);
          if (source) channel.source = source;
        }
      }
    }

    for (const channel of channels) {
      await regenerate(channel);
    }
  }

  scheduleDailyAtImpl(refreshTime, () => runDailyRegeneration());

  const channelActions = createChannelActionsImpl({
    dataDir,
    channels,
    discoverInstalledAddons,
    resolveSourceImpl: resolveSource,
    regenerateImpl: regenerate,
    readChannelsImpl,
    writeChannelsImpl
  });

  const app = createAppImpl({ channels, dataDir, baseUrl, channelActions });
  const server = app.listen(port, () => console.log(`stremioTuner listening on port ${port}`));

  // Populate/refresh on-disk schedules in the background so the HTTP server
  // is reachable immediately, rather than blocking listen() behind
  // potentially long (or hung) per-channel metadata fetches.
  const startupRegenerationDone = runStartupRegeneration().catch((err) => {
    console.error(`Startup schedule regeneration failed: ${err.message}`);
  });

  return { app, channels, server, startupRegenerationDone, channelActions };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/bootstrap.test.js
```

Expected: PASS (10 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions, then commit**

```bash
npm test
git add src/bootstrap.js test/bootstrap.test.js
git commit -m "Wire channelStore/channelActions into bootstrap, replacing config.yml"
```

---

### Task 7: Static admin UI content

**Files:**
- Modify: `public/index.html` (replace the Task 5 placeholder with the real page)
- Create: `public/admin.js`

**Interfaces:**
- Consumes (via `fetch` from the browser): `GET /admin/catalogs`, `GET /admin/channels`, `POST /admin/channels`, `PATCH /admin/channels/:id` (Task 4/5)
- Produces: nothing consumed by other tasks — this is the leaf UI layer

No automated test for this task (per the plan's Global Constraints — manual verification only). There is no RED/GREEN cycle; just implement and manually verify per Step 3 below.

- [ ] **Step 1: Replace `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>stremioTuner</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    h1 { margin-bottom: 0.25rem; }
    section { margin-top: 2rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid #ddd; }
    button { cursor: pointer; }
    .banner { background: #fee; border: 1px solid #c00; padding: 0.5rem 1rem; margin-bottom: 1rem; display: none; }
    .add-form { display: none; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .add-form.open { display: flex; }
    select, input[type=text] { padding: 0.2rem; }
  </style>
</head>
<body>
  <h1>stremioTuner</h1>
  <p>Manage which Stremio catalogs are broadcast as channels. Changes take effect immediately.</p>

  <div id="banner" class="banner"></div>

  <section>
    <h2>My channels</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Mode</th><th>Min quality</th><th>Language</th><th>Enabled</th></tr>
      </thead>
      <tbody id="channels-body"></tbody>
    </table>
  </section>

  <section>
    <h2>Available catalogs</h2>
    <table>
      <thead>
        <tr><th>Addon</th><th>Catalog</th><th>Type</th><th></th></tr>
      </thead>
      <tbody id="catalogs-body"></tbody>
    </table>
  </section>

  <script src="/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/admin.js`**

```js
const MODES = ['random-start', 'random'];
const QUALITIES = ['480p', '720p', '1080p', '2160p'];
const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt'];

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request to ${url} failed (${res.status})`);
  return data;
}

function selectHtml(field, options, selected) {
  return `<select data-field="${field}">${options.map((o) => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
}

function cssEscape(text) {
  return text.replace(/[^a-zA-Z0-9]/g, '_');
}

function showBanner(message) {
  const banner = document.getElementById('banner');
  banner.textContent = message;
  banner.style.display = 'block';
}

function hideBanner() {
  document.getElementById('banner').style.display = 'none';
}

async function loadChannels() {
  const channels = await fetchJson('/admin/channels');
  const body = document.getElementById('channels-body');
  body.innerHTML = channels.map((ch) => `
    <tr data-id="${ch.id}">
      <td>${ch.name}</td>
      <td>${selectHtml('mode', MODES, ch.mode)}</td>
      <td>${selectHtml('minQuality', QUALITIES, ch.minQuality)}</td>
      <td>${selectHtml('language', LANGUAGES, ch.language)}</td>
      <td><input type="checkbox" data-field="enabled" ${ch.enabled ? 'checked' : ''}></td>
    </tr>
  `).join('');

  body.querySelectorAll('select, input[type=checkbox]').forEach((el) => {
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
}

async function loadCatalogs() {
  const result = await fetchJson('/admin/catalogs');
  if (result.degraded) {
    showBanner('Could not reach your Stremio account right now — catalog list unavailable.');
  }

  const body = document.getElementById('catalogs-body');
  body.innerHTML = result.catalogs.map((cat) => {
    if (cat.channelId) {
      return `<tr><td>${cat.addonName}</td><td>${cat.catalogName}</td><td>${cat.type}</td><td>Already added</td></tr>`;
    }
    const key = cssEscape(`${cat.addon}::${cat.catalog}`);
    return `
      <tr data-addon="${cat.addon}" data-catalog="${cat.catalog}" data-key="${key}">
        <td>${cat.addonName}</td><td>${cat.catalogName}</td><td>${cat.type}</td>
        <td><button data-action="toggle-form">Add channel</button></td>
      </tr>
      <tr class="add-form-row">
        <td colspan="4">
          <div class="add-form" id="form-${key}">
            <input type="text" data-field="name" placeholder="Channel name" value="${cat.catalogName}">
            ${selectHtml('mode', MODES, 'random-start')}
            ${selectHtml('minQuality', QUALITIES, '720p')}
            ${selectHtml('language', LANGUAGES, 'en')}
            <button data-action="submit">Save</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('button[data-action="toggle-form"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      document.getElementById(`form-${row.dataset.key}`).classList.toggle('open');
    });
  });

  body.querySelectorAll('button[data-action="submit"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const formDiv = e.target.closest('.add-form');
      const row = formDiv.closest('tr').previousElementSibling;
      const addon = row.dataset.addon;
      const catalog = row.dataset.catalog;
      const name = formDiv.querySelector('[data-field="name"]').value;
      const mode = formDiv.querySelector('[data-field="mode"]').value;
      const minQuality = formDiv.querySelector('[data-field="minQuality"]').value;
      const language = formDiv.querySelector('[data-field="language"]').value;
      try {
        await fetchJson('/admin/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addon, catalog, name, mode, minQuality, language })
        });
        hideBanner();
        await loadAll();
      } catch (err) {
        showBanner(err.message);
      }
    });
  });
}

async function loadAll() {
  await loadChannels();
  await loadCatalogs();
}

loadAll();
```

- [ ] **Step 3: Manual verification**

Run the app locally (or in Docker, once Task 8 is done) with real Stremio credentials and confirm:

```bash
STREMIO_EMAIL=you@example.com STREMIO_PASSWORD=yourpassword DATA_DIR=/tmp/stremiotuner-data node src/index.js
```

Then in a browser:
1. Open `http://localhost:8080/` — the page loads, shows an empty "My channels" table and a populated "Available catalogs" table from your real installed addons.
2. Click "Add channel" on a catalog, adjust the defaults if desired, click "Save" — the catalog moves to "My channels" and disappears from the "Add channel" prompt (shows "Already added" instead).
3. Fetch `http://localhost:8080/playlist.m3u` in another tab/curl — confirm the new channel appears without restarting the container.
4. Uncheck "Enabled" for that channel in the UI — refetch `/playlist.m3u` — confirm the channel is gone.
5. Re-check "Enabled" — confirm it reappears.
6. Change the channel's mode/quality/language dropdowns — confirm no error banner appears and the row keeps its new values after the page reloads its data.

Report any UI issues found; fix and re-verify before moving to Task 8.

- [ ] **Step 4: Run the full automated suite one more time (sanity check, no UI-related tests exist)**

```bash
npm test
```

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/admin.js
git commit -m "Add functional channel admin UI (browse catalogs, add/enable/disable/edit channels)"
```

---

### Task 8: Docker/Compose/Portainer updates

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `portainer-stack.yml`

**Interfaces:**
- Consumes: `public/` directory (Task 7), `REFRESH_TIME` env var (Task 6)
- Produces: an updated Docker image that includes the static UI and no longer references `config.yml`/`config.example.yml`

- [ ] **Step 1: Modify `Dockerfile` to copy `public/` into the image**

Find:

```dockerfile
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src

ENV PORT=8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "src/index.js"]
```

Replace with:

```dockerfile
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV PORT=8080
ENV DATA_DIR=/data
ENV REFRESH_TIME=00:00
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Modify `docker-compose.yml`**

Replace the full contents:

```yaml
services:
  stremio-tuner:
    build: .
    ports:
      - "8080:8080"
    environment:
      STREMIO_EMAIL: ${STREMIO_EMAIL}
      STREMIO_PASSWORD: ${STREMIO_PASSWORD}
      TZ: ${TZ:-UTC}
      BASE_URL: ${BASE_URL:-http://localhost:8080}
      REFRESH_TIME: ${REFRESH_TIME:-00:00}
    volumes:
      - ./data:/data
    restart: unless-stopped
```

(Only the added `REFRESH_TIME` line is new.)

- [ ] **Step 3: Modify `portainer-stack.yml`**

Replace the full contents:

```yaml
# Portainer stack for testing stremioTuner.
#
# Deploy via Portainer: Stacks -> Add stack -> Repository
#   Repository URL: https://github.com/jasonPenner83/stremioTuner.git
#   Compose path:    portainer-stack.yml
#
# Portainer will clone the repo and build the image itself (via `build: .`),
# so no separate image push is needed. Set the environment variables below
# in Portainer's "Environment variables" section when deploying the stack
# (do NOT hardcode your password into this file).
#
# Required env vars to set in Portainer:
#   STREMIO_EMAIL     - your Stremio account email
#   STREMIO_PASSWORD  - your Stremio account password
#
# Optional:
#   TZ            - defaults to UTC; set to your local timezone (e.g. America/Denver)
#                   so REFRESH_TIME means what you expect
#   REFRESH_TIME  - defaults to 00:00; local time (per TZ) at which channel
#                   schedules regenerate daily
#   BASE_URL      - defaults to http://localhost:8080; set to the real host:port
#                   your IPTV player will use to reach this container if it's
#                   not on localhost (e.g. http://192.168.1.50:8080)
#
# Data directory (Synology):
#   Persisted state (channels.json, auth.json, schedules/) lives on the NAS at
#   /volume1/docker/stremio-tuner. Create that folder before first deploy;
#   nothing else needs to be placed in it manually — once the container is
#   running, open http://<nas-ip>:8080/ in a browser to add channels via the
#   admin UI (no more hand-edited config file).

services:
  stremio-tuner:
    build: .
    container_name: stremio-tuner
    ports:
      - "8080:8080"
    environment:
      STREMIO_EMAIL: ${STREMIO_EMAIL}
      STREMIO_PASSWORD: ${STREMIO_PASSWORD}
      TZ: ${TZ:-UTC}
      BASE_URL: ${BASE_URL:-http://localhost:8080}
      REFRESH_TIME: ${REFRESH_TIME:-00:00}
    volumes:
      - /volume1/docker/stremio-tuner:/data
    restart: unless-stopped
```

- [ ] **Step 4: Run the full test suite one more time**

```bash
npm test
```

Expected: PASS, 0 failures.

- [ ] **Step 5: Build the Docker image and verify the UI is reachable**

```bash
docker build -t stremio-tuner .
docker run --rm -p 8080:8080 \
  -e STREMIO_EMAIL=you@example.com \
  -e STREMIO_PASSWORD='your-password' \
  stremio-tuner
```

In another terminal:

```bash
curl -s http://localhost:8080/ | grep -o '<title>[^<]*</title>'
```

Expected: `<title>stremioTuner</title>` — confirms the built image serves the real static UI (not the old placeholder, not a 404).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml portainer-stack.yml
git commit -m "Update Docker/Compose/Portainer packaging for the channel admin UI, remove config.yml references"
```
