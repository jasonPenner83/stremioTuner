# Schedule Generation Error Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the last schedule-generation error per channel in the admin UI's "My channels" table, instead of only in container logs.

**Architecture:** `bootstrap.js`'s existing `regenerate(channel)` sets `channel.lastError` (a string) on either of its two existing failure paths, and clears it back to `null` on success — in-memory only, on the live channel object already mutated elsewhere. `channelActions.listChannels()` merges each persisted channel's live `lastError` into what it returns (it already has the live `channels` array in its closure). A new "Status" column in the admin UI shows "OK" or the error text.

**Tech Stack:** Node.js (no new dependencies), `node:test`/`node:assert`, vanilla JS admin UI.

## Global Constraints

- No persistence of `lastError` to disk — in-memory only, re-populates naturally on the next regeneration attempt (which already runs at startup for any non-fresh schedule).
- One pre-existing test in `test/channelActions.test.js` needs its expected fixture UPDATED (not left alone) to include the new `lastError: null` field — this is a plan-mandated additive change (the field is new), not a behavior contradiction.
- A channel not present in the live `channels` array (e.g. currently disabled) must report `lastError: null`, never throw or omit the field.
- No new npm dependencies.
- Follow existing code style: `node:test` + `node:assert/strict`, existing `escapeHtml`/banner-color conventions in `admin.js`/`index.html`.

---

### Task 1: `bootstrap.js` — track `channel.lastError`

**Files:**
- Modify: `src/bootstrap.js`
- Test: `test/bootstrap.test.js`

**Interfaces:**
- Produces: every live channel object gains a `lastError: string | null` field, set/cleared by `regenerate(channel)`. `undefined` until the first `regenerate()` call completes for that channel (the UI/consumers treat `undefined`, `null`, and absent identically — falsy means "no error").

`src/bootstrap.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state and line numbers.

- [ ] **Step 1: Write the failing tests**

Add to `test/bootstrap.test.js` (the `channel()` helper and `fakeApp()` already exist at the top):

```js
test('regenerate sets channel.lastError on a schedule generation failure', async () => {
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
    generateChannelScheduleImpl: async () => { throw new Error('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'); },
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].lastError, 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON');
});

test('regenerate sets channel.lastError to "No resolved addon source" when the source failed to resolve', async () => {
  const result = await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    readChannelsImpl: async () => ([channel({ id: 'x', name: 'X', addon: 'org.missing', catalog: 'cat-a' })]),
    writeChannelsImpl: async () => {},
    getAuthKeyImpl: async () => 'auth-key',
    getInstalledAddonsImpl: async () => [],
    findAddonByIdImpl: () => { throw new Error('not found'); },
    resolveChannelSourceImpl: () => null,
    readScheduleImpl: async () => null,
    isScheduleFreshImpl: () => false,
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].lastError, 'No resolved addon source');
});

test('regenerate clears a previously-set lastError after a subsequent successful regeneration', async () => {
  let generationAttempts = 0;
  let cronCallback;

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
      generationAttempts += 1;
      if (generationAttempts === 1) throw new Error('temporary failure');
      return { generatedAt: 'new', items: [], channelId: ch.id };
    },
    writeScheduleImpl: async () => {},
    scheduleDailyAtImpl: (refreshTime, cb) => { cronCallback = cb; return { cancel() {} }; },
    createAppImpl: () => fakeApp()
  });
  await result.startupRegenerationDone;

  assert.equal(result.channels[0].lastError, 'temporary failure');

  await cronCallback();

  assert.equal(result.channels[0].lastError, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bootstrap.test.js`
Expected: FAIL — `result.channels[0].lastError` is `undefined` in all three new tests (the field doesn't exist yet).

- [ ] **Step 3: Implement the change**

In `src/bootstrap.js`, update `regenerate`:

```js
  async function regenerate(channel) {
    if (!channel.source) {
      channel.lastError = 'No resolved addon source';
      console.error(`Skipping schedule regeneration for "${channel.name}": no resolved addon source`);
      return;
    }
    try {
      const schedule = await generateChannelScheduleImpl({ channel, source: channel.source });
      await writeScheduleImpl(dataDir, channel.id, schedule);
      channel.lastError = null;
    } catch (err) {
      channel.lastError = err.message;
      console.error(`Schedule generation failed for "${channel.name}": ${err.message}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/bootstrap.test.js`
Expected: all tests PASS, including every pre-existing test in this file (unaffected — none of them assert on `lastError`, so the new field's presence doesn't break anything).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.js test/bootstrap.test.js
git commit -m "Track channel.lastError on schedule generation success/failure"
```

---

### Task 2: `channelActions.listChannels()` — merge in `lastError`

**Files:**
- Modify: `src/channelActions.js`
- Test: `test/channelActions.test.js`

**Interfaces:**
- Produces: every object `listChannels()` returns gains a `lastError: string | null` field, sourced from the matching live channel in the `channels` array already in this module's closure (or `null` if the channel isn't currently live).

`src/channelActions.js` currently exists and has NOT changed since this plan was written — read it in full before editing to confirm exact current state.

- [ ] **Step 1: Update the existing test, then write the new failing tests**

In `test/channelActions.test.js`, find the test `'listChannels returns the persisted channel list'`. Rename and update it (this is a plan-mandated additive fixture update — the new field simply needs to appear in the expected output):

```js
test('listChannels returns the persisted channel list with lastError merged in from the live array', async () => {
  const actions = createChannelActions(baseDeps({ readChannelsImpl: async () => [{ id: 'x' }] }));
  const result = await actions.listChannels();
  assert.deepEqual(result, [{ id: 'x', lastError: null }]);
});
```

Then add two new tests after it:

```js
test('listChannels merges a live channel\'s lastError into its persisted record', async () => {
  const channels = [{ id: 'x', lastError: 'boom' }];
  const actions = createChannelActions(baseDeps({
    channels,
    readChannelsImpl: async () => [{ id: 'x' }]
  }));
  const result = await actions.listChannels();
  assert.equal(result[0].lastError, 'boom');
});

test('listChannels reports lastError: null for a channel not present in the live array (e.g. disabled)', async () => {
  const actions = createChannelActions(baseDeps({
    channels: [],
    readChannelsImpl: async () => [{ id: 'x', enabled: false }]
  }));
  const result = await actions.listChannels();
  assert.equal(result[0].lastError, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/channelActions.test.js`
Expected: FAIL — the updated test fails because `lastError` is missing from the actual result, and the two new tests fail with `undefined !== 'boom'` / `undefined !== null`.

- [ ] **Step 3: Implement the change**

In `src/channelActions.js`, update `listChannels`:

```js
  async function listChannels() {
    const persisted = await readChannelsImpl(dataDir);
    return persisted.map((ch) => {
      const live = channels.find((c) => c.id === ch.id);
      return { ...ch, lastError: live?.lastError ?? null };
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/channelActions.test.js`
Expected: all tests PASS, including every other pre-existing test in this file (unaffected — only the one renamed/updated test needed a fixture change).

- [ ] **Step 5: Commit**

```bash
git add src/channelActions.js test/channelActions.test.js
git commit -m "Merge live channel.lastError into channelActions.listChannels"
```

---

### Task 3: Admin UI — "Status" column

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `ch.lastError` from the existing `GET /admin/channels` response (Task 2).
- Produces: nothing consumed by later tasks — this is the UI leaf.

- [ ] **Step 1: Add a "Status" column header and its CSS in `public/index.html`**

Change the table header:

```html
        <tr><th>Name</th><th>Mode</th><th>Min quality</th><th>Language</th><th>Stream addon</th><th>Enabled</th><th>Delete</th></tr>
```

to:

```html
        <tr><th>Name</th><th>Mode</th><th>Min quality</th><th>Language</th><th>Stream addon</th><th>Enabled</th><th>Status</th><th>Delete</th></tr>
```

Add a CSS rule in the `<style>` block (near the existing `.banner` rule, reusing its red):

```css
    .status-error { color: #c00; }
```

- [ ] **Step 2: Render the Status cell in `public/admin.js`**

In `loadChannels()`'s row template, add a new `<td>` between the "Enabled" cell and the "Delete" cell:

```js
      <td><input type="checkbox" data-field="enabled" ${ch.enabled ? 'checked' : ''}></td>
      <td>${ch.lastError ? `<span class="status-error" title="${escapeHtml(ch.lastError)}">${escapeHtml(ch.lastError)}</span>` : 'OK'}</td>
      <td><button data-action="delete-channel">Delete</button></td>
```

(No other changes to `loadChannels()` are needed — this is a purely additive cell in the existing row template.)

- [ ] **Step 3: Verify**

Run `node --check public/admin.js` to confirm valid syntax, then run the full test suite (`npm test`) to confirm nothing broke (no test changes are expected for this task — this project's convention is manual-only verification for the static admin UI).

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/admin.js
git commit -m "Add a Status column to the My channels table showing the last generation error"
```

---

### Task 4: Full test suite run and final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `test/*.test.js` file PASS, with no regressions beyond the one deliberate, plan-mandated fixture rename/update in Task 2.

- [ ] **Step 2: Manual verification**

Per this project's existing testing approach (the admin UI is manually verified, not covered by browser tests): run the app with `DATA_DIR` pointed at a scratch directory and valid `STREMIO_EMAIL`/`STREMIO_PASSWORD` env vars, open the admin UI, and confirm: (a) a healthy channel's Status cell shows "OK"; (b) a channel whose schedule generation is currently failing (e.g. one pointed at a misconfigured addon) shows its error message in red, with the full message visible on hover via the tooltip; (c) restarting the container re-populates the error for a channel whose underlying problem hasn't been fixed, and clears it for one that has.
