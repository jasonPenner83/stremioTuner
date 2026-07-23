# stremioTuner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-container Node.js service that turns a user's Stremio addon catalogs into continuous linear "TV channels," exposed as an M3U playlist and XMLTV EPG, with live stream resolution and offset-seeked playback via ffmpeg.

**Architecture:** One Node.js (Express) process. A daily-cron-driven scheduler generates each channel's full lineup (with real runtimes) and persists it as JSON; an HTTP server reads that persisted state to serve `/playlist.m3u` and `/epg.xml`, and resolves+proxies the actual stream live at `/stream/:channelId` via ffmpeg, seeking to the correct "currently airing" offset.

**Tech Stack:** Node.js 20+ (ES modules), Express, js-yaml, ffmpeg (spawned as a child process), Node's built-in `node:test` runner — no other dependencies.

## Global Constraints

- Node.js >= 20 (needed for stable global `fetch`), ES modules (`"type": "module"` in package.json).
- Only two runtime dependencies: `express`, `js-yaml`. No test framework dependency — use `node --test` and `node:assert/strict`.
- Every module that performs I/O (network, filesystem, child_process, `Math.random`, `Date.now`) must accept its dependency as an injectable, defaulted parameter so it is unit-testable without real I/O.
- Single Docker container, single mounted volume at `/data` holding `config.yml`, `auth.json`, and `schedules/*.json` (per the approved spec, Approach A).
- Config's per-channel `addon` field is the addon manifest's stable `id` (e.g. `"org.stremio.torrentio.addon"`), not a URL — it's resolved to a live `transportUrl` by cross-referencing the authenticated Stremio account's installed-addons list, so it stays correct if the user reconfigures the addon (e.g. changes debrid key) in Stremio itself.
- Stream selection: filter by language match AND minimum quality; if nothing qualifies, relax quality but keep language; pick highest peer count; if still nothing, skip the item.
- Playback: `ffmpeg -ss <offset> -i <url> -c copy -f mpegts pipe:1`, falling back to `-c:v libx264 -c:a aac` only if the copy attempt exits before producing any output.

---

## File Structure

```
stremioTuner/
  package.json
  Dockerfile
  docker-compose.yml
  config.example.yml
  .gitignore
  src/
    config.js               # load & validate config.yml
    scheduling.js            # refresh-time boundary math + daily timer
    lineup.js                # random / random-start lineup builders
    streamSelect.js          # stream candidate parsing + selection
    scheduleStore.js         # read/write/freshness of persisted schedules
    xmltv.js                 # XMLTV EPG builder
    m3u.js                   # M3U playlist builder
    stremioAccount.js        # Stremio account login + addon discovery
    addonClient.js            # Stremio addon protocol client (catalog/meta/stream/manifest)
    generateSchedule.js      # orchestrates one channel's daily schedule generation
    bootstrap.js              # wires all modules together (testable via DI)
    index.js                  # thin entrypoint: calls bootstrap()
    server/
      app.js                  # Express app + routes
      ffmpegProxy.js           # spawn ffmpeg, pipe to response, copy->transcode fallback
  test/
    config.test.js
    scheduling.test.js
    lineup.test.js
    streamSelect.test.js
    scheduleStore.test.js
    xmltv.test.js
    m3u.test.js
    stremioAccount.test.js
    addonClient.test.js
    generateSchedule.test.js
    ffmpegProxy.test.js
    app.test.js
    bootstrap.test.js
```

---

### Task 1: Project scaffolding + config loader

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `slugify(name: string) -> string`, `parseConfig(raw: object) -> { refreshTime: string, channels: Array<{id, name, addon, catalog, mode, minQuality, language}> }`, `loadConfig(configPath: string, { fs? }) -> Promise<ParsedConfig>`

- [ ] **Step 1: Scaffold the project**

```bash
mkdir -p src/server test
```

Create `package.json`:

```json
{
  "name": "stremio-tuner",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "express": "^4.19.2",
    "js-yaml": "^4.1.0"
  }
}
```

Create `.gitignore`:

```
node_modules/
data/
*.log
```

Run:
```bash
npm install
```

- [ ] **Step 2: Write the failing test for config parsing**

Create `test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, parseConfig, loadConfig } from '../src/config.js';

test('slugify lowercases and dashes non-alnum characters', () => {
  assert.equal(slugify('Marvel Movies'), 'marvel-movies');
  assert.equal(slugify('  90s Sitcoms!! '), '90s-sitcoms');
});

test('parseConfig accepts a valid config', () => {
  const parsed = parseConfig({
    refreshTime: '00:00',
    channels: [
      { name: 'Marvel Movies', addon: 'org.stremio.torrentio.addon', catalog: 'marvel-movies', mode: 'random-start', minQuality: '720p', language: 'en' }
    ]
  });
  assert.equal(parsed.refreshTime, '00:00');
  assert.deepEqual(parsed.channels, [
    { id: 'marvel-movies', name: 'Marvel Movies', addon: 'org.stremio.torrentio.addon', catalog: 'marvel-movies', mode: 'random-start', minQuality: '720p', language: 'en' }
  ]);
});

test('parseConfig rejects missing refreshTime', () => {
  assert.throws(() => parseConfig({ channels: [] }), /refreshTime/);
});

test('parseConfig rejects empty channels', () => {
  assert.throws(() => parseConfig({ refreshTime: '00:00', channels: [] }), /at least one channel/);
});

test('parseConfig rejects invalid mode', () => {
  assert.throws(() => parseConfig({
    refreshTime: '00:00',
    channels: [{ name: 'X', addon: 'a', catalog: 'c', mode: 'shuffle', minQuality: '720p', language: 'en' }]
  }), /invalid mode/);
});

test('parseConfig rejects channel missing a required field', () => {
  assert.throws(() => parseConfig({
    refreshTime: '00:00',
    channels: [{ name: 'X', catalog: 'c', mode: 'random', minQuality: '720p', language: 'en' }]
  }), /addon/);
});

test('loadConfig reads and parses YAML from disk', async () => {
  const fakeFs = {
    readFile: async (p) => {
      assert.equal(p, '/data/config.yml');
      return 'refreshTime: "00:00"\nchannels:\n  - name: X\n    addon: a\n    catalog: c\n    mode: random\n    minQuality: "480p"\n    language: en\n';
    }
  };
  const parsed = await loadConfig('/data/config.yml', { fs: fakeFs });
  assert.equal(parsed.channels[0].id, 'x');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/config.js'`

- [ ] **Step 4: Implement `src/config.js`**

```js
import fsPromises from 'node:fs/promises';
import yaml from 'js-yaml';

const VALID_MODES = ['random', 'random-start'];
const REQUIRED_FIELDS = ['name', 'addon', 'catalog', 'mode', 'minQuality', 'language'];

export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

export function validateChannel(raw) {
  for (const field of REQUIRED_FIELDS) {
    if (!raw[field]) {
      throw new Error(`Channel missing required field "${field}": ${JSON.stringify(raw)}`);
    }
  }
  if (!VALID_MODES.includes(raw.mode)) {
    throw new Error(`Channel "${raw.name}" has invalid mode "${raw.mode}" (must be one of ${VALID_MODES.join(', ')})`);
  }
  return {
    id: slugify(raw.name),
    name: raw.name,
    addon: raw.addon,
    catalog: raw.catalog,
    mode: raw.mode,
    minQuality: raw.minQuality,
    language: raw.language
  };
}

export function parseConfig(raw) {
  if (!raw.refreshTime || !/^\d{2}:\d{2}$/.test(raw.refreshTime)) {
    throw new Error(`Invalid or missing refreshTime (expected "HH:MM"): ${raw.refreshTime}`);
  }
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new Error('Config must define at least one channel');
  }
  return {
    refreshTime: raw.refreshTime,
    channels: raw.channels.map(validateChannel)
  };
}

export async function loadConfig(configPath, { fs = fsPromises } = {}) {
  const raw = yaml.load(await fs.readFile(configPath, 'utf-8'));
  return parseConfig(raw);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/config.js test/config.test.js
git commit -m "Add project scaffolding and config loader"
```

---

### Task 2: Scheduling timing helpers

**Files:**
- Create: `src/scheduling.js`
- Test: `test/scheduling.test.js`

**Interfaces:**
- Consumes: nothing (pure/timer-only module)
- Produces: `mostRecentBoundary(refreshTime: string, now: Date) -> Date`, `nextBoundary(refreshTime: string, now: Date) -> Date`, `msUntilNextRun(refreshTime: string, now: Date) -> number`, `scheduleDailyAt(refreshTime: string, callback: () => void, { now?, setTimeoutImpl?, clearTimeoutImpl? }) -> { cancel(): void }`

- [ ] **Step 1: Write the failing tests**

Create `test/scheduling.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostRecentBoundary, nextBoundary, msUntilNextRun, scheduleDailyAt } from '../src/scheduling.js';

test('mostRecentBoundary returns today\'s boundary when it has already passed', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = mostRecentBoundary('00:00', now);
  assert.equal(boundary.toISOString().slice(0, 10), '2026-07-22');
  assert.equal(boundary.getHours(), 0);
});

test('mostRecentBoundary returns yesterday\'s boundary when today\'s hasn\'t happened yet', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = mostRecentBoundary('23:00', now);
  assert.equal(boundary.getDate(), 21);
});

test('nextBoundary returns tomorrow when today\'s boundary already passed', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = nextBoundary('00:00', now);
  assert.equal(boundary.getDate(), 23);
});

test('nextBoundary returns today when the boundary hasn\'t happened yet', () => {
  const now = new Date('2026-07-22T10:00:00');
  const boundary = nextBoundary('23:00', now);
  assert.equal(boundary.getDate(), 22);
});

test('msUntilNextRun computes correct delay', () => {
  const now = new Date('2026-07-22T23:00:00');
  const ms = msUntilNextRun('23:30', now);
  assert.equal(ms, 30 * 60 * 1000);
});

test('scheduleDailyAt schedules a timer and reschedules after each firing', () => {
  const calls = [];
  const scheduled = [];
  const fakeSetTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };
  const fakeClearTimeout = () => {};

  scheduleDailyAt('00:00', () => calls.push('fired'), {
    now: () => new Date('2026-07-22T10:00:00'),
    setTimeoutImpl: fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout
  });

  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay > 0);

  scheduled[0].fn();
  assert.deepEqual(calls, ['fired']);
  assert.equal(scheduled.length, 2);
});

test('scheduleDailyAt.cancel prevents further rescheduling', () => {
  const scheduled = [];
  let cleared = false;
  const fakeSetTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };
  const fakeClearTimeout = () => { cleared = true; };

  const handle = scheduleDailyAt('00:00', () => {}, {
    now: () => new Date('2026-07-22T10:00:00'),
    setTimeoutImpl: fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout
  });

  handle.cancel();
  assert.equal(cleared, true);

  scheduled[0].fn();
  assert.equal(scheduled.length, 1, 'should not schedule again after cancel');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/scheduling.js'`

- [ ] **Step 3: Implement `src/scheduling.js`**

```js
export function mostRecentBoundary(refreshTime, now) {
  const [hh, mm] = refreshTime.split(':').map(Number);
  const boundary = new Date(now);
  boundary.setHours(hh, mm, 0, 0);
  if (boundary.getTime() > now.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}

export function nextBoundary(refreshTime, now) {
  const [hh, mm] = refreshTime.split(':').map(Number);
  const boundary = new Date(now);
  boundary.setHours(hh, mm, 0, 0);
  if (boundary.getTime() <= now.getTime()) {
    boundary.setDate(boundary.getDate() + 1);
  }
  return boundary;
}

export function msUntilNextRun(refreshTime, now) {
  return nextBoundary(refreshTime, now).getTime() - now.getTime();
}

export function scheduleDailyAt(refreshTime, callback, {
  now = () => new Date(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  let cancelled = false;
  let timer = null;

  function scheduleNext() {
    if (cancelled) return;
    const delay = msUntilNextRun(refreshTime, now());
    timer = setTimeoutImpl(() => {
      callback();
      scheduleNext();
    }, delay);
  }

  scheduleNext();

  return {
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeoutImpl(timer);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (14 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/scheduling.js test/scheduling.test.js
git commit -m "Add daily refresh timing helpers"
```

---

### Task 3: Lineup builders

**Files:**
- Create: `src/lineup.js`
- Test: `test/lineup.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `buildRandomStartLineup(items: Array, rng?: () => number) -> Array` (same items, rotated to a random start index), `buildRandomLineup(items: Array, count: number, rng?: () => number) -> Array` (length `count`, independently random picks, repeats allowed)

- [ ] **Step 1: Write the failing tests**

Create `test/lineup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRandomStartLineup, buildRandomLineup } from '../src/lineup.js';

const ITEMS = ['a', 'b', 'c', 'd'];

test('buildRandomStartLineup rotates the list starting at the rng-chosen index', () => {
  const rng = () => 0.5; // floor(0.5 * 4) = 2
  assert.deepEqual(buildRandomStartLineup(ITEMS, rng), ['c', 'd', 'a', 'b']);
});

test('buildRandomStartLineup with rng returning 0 keeps original order', () => {
  const rng = () => 0;
  assert.deepEqual(buildRandomStartLineup(ITEMS, rng), ['a', 'b', 'c', 'd']);
});

test('buildRandomStartLineup returns empty array for empty input', () => {
  assert.deepEqual(buildRandomStartLineup([], () => 0.5), []);
});

test('buildRandomLineup picks `count` items independently via rng, repeats allowed', () => {
  const values = [0, 0.9, 0.9, 0];
  let i = 0;
  const rng = () => values[i++];
  assert.deepEqual(buildRandomLineup(ITEMS, 4, rng), ['a', 'd', 'd', 'a']);
});

test('buildRandomLineup returns an array of the requested length', () => {
  const result = buildRandomLineup(ITEMS, 10, () => 0.1);
  assert.equal(result.length, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/lineup.js'`

- [ ] **Step 3: Implement `src/lineup.js`**

```js
export function buildRandomStartLineup(items, rng = Math.random) {
  if (items.length === 0) return [];
  const startIndex = Math.floor(rng() * items.length);
  return [...items.slice(startIndex), ...items.slice(0, startIndex)];
}

export function buildRandomLineup(items, count, rng = Math.random) {
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.floor(rng() * items.length);
    result.push(items[index]);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (19 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/lineup.js test/lineup.test.js
git commit -m "Add channel lineup builders for random and random-start modes"
```

---

### Task 4: Stream candidate parsing & selection

**Files:**
- Create: `src/streamSelect.js`
- Test: `test/streamSelect.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `parseQuality(text: string) -> string|null`, `qualityRank(quality: string|null) -> number|null`, `parsePeers(text: string) -> number`, `matchesLanguage(text: string, languageCode: string) -> boolean`, `selectStream(streams: Array<{title?, name?, url}>, { minQuality: string, language: string }) -> {url, quality, peers}|null`

- [ ] **Step 1: Write the failing tests**

Create `test/streamSelect.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuality, qualityRank, parsePeers, matchesLanguage, selectStream } from '../src/streamSelect.js';

test('parseQuality finds known quality tokens', () => {
  assert.equal(parseQuality('Movie.Title.2020.1080p.WEB-DL'), '1080p');
  assert.equal(parseQuality('Movie.Title.2020.2160p.UHD'), '2160p');
  assert.equal(parseQuality('Movie.Title.2020.4K.REMUX'), '2160p');
  assert.equal(parseQuality('Movie.Title.2020'), null);
});

test('qualityRank orders qualities and returns null for unknown', () => {
  assert.ok(qualityRank('1080p') > qualityRank('720p'));
  assert.equal(qualityRank(null), null);
});

test('parsePeers reads Torrentio-style emoji peer counts', () => {
  assert.equal(parsePeers('👤 45 💾 2.1GB ⚙️ Group'), 45);
});

test('parsePeers falls back to "N seeds"/"N peers" text', () => {
  assert.equal(parsePeers('120 seeds, 4.2GB'), 120);
  assert.equal(parsePeers('7 peers'), 7);
});

test('parsePeers defaults to 0 when nothing found', () => {
  assert.equal(parsePeers('no peer info here'), 0);
});

test('matchesLanguage matches an explicit non-English language', () => {
  assert.equal(matchesLanguage('Movie [Spanish Dub] 1080p', 'es'), true);
  assert.equal(matchesLanguage('Movie [Spanish Dub] 1080p', 'en'), false);
});

test('matchesLanguage treats untagged titles as English by default', () => {
  assert.equal(matchesLanguage('Movie.Title.2020.1080p.WEB-DL', 'en'), true);
});

test('matchesLanguage rejects English when another language is tagged', () => {
  assert.equal(matchesLanguage('Movie [French] 1080p', 'en'), false);
});

test('selectStream picks the highest-peer stream meeting language + minQuality', () => {
  const streams = [
    { title: '1080p 👤 10', url: 'http://a' },
    { title: '1080p 👤 50', url: 'http://b' },
    { title: '720p 👤 999', url: 'http://c' }
  ];
  const result = selectStream(streams, { minQuality: '1080p', language: 'en' });
  assert.equal(result.url, 'http://b');
});

test('selectStream relaxes quality but keeps language when nothing meets minQuality', () => {
  const streams = [
    { title: '480p 👤 5', url: 'http://a' },
    { title: '480p 👤 20', url: 'http://b' }
  ];
  const result = selectStream(streams, { minQuality: '1080p', language: 'en' });
  assert.equal(result.url, 'http://b');
});

test('selectStream returns null when nothing matches language at all', () => {
  const streams = [
    { title: '[French] 1080p 👤 50', url: 'http://a' }
  ];
  const result = selectStream(streams, { minQuality: '480p', language: 'en' });
  assert.equal(result, null);
});

test('selectStream ignores candidates without a url', () => {
  const streams = [
    { title: '1080p 👤 999' },
    { title: '1080p 👤 5', url: 'http://a' }
  ];
  const result = selectStream(streams, { minQuality: '720p', language: 'en' });
  assert.equal(result.url, 'http://a');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/streamSelect.js'`

- [ ] **Step 3: Implement `src/streamSelect.js`**

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

export function parseQuality(text) {
  const lower = text.toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(lower)) return '2160p';
  for (const q of QUALITY_ORDER) {
    if (q !== '2160p' && lower.includes(q)) return q;
  }
  return null;
}

export function qualityRank(quality) {
  const idx = QUALITY_ORDER.indexOf(quality);
  return idx === -1 ? null : idx;
}

export function parsePeers(text) {
  const emojiMatch = text.match(/👤\s*(\d+)/);
  if (emojiMatch) return Number(emojiMatch[1]);
  const seedMatch = text.match(/(\d+)\s*(?:seeds?|peers?)/i);
  if (seedMatch) return Number(seedMatch[1]);
  return 0;
}

export function matchesLanguage(text, languageCode) {
  const lower = text.toLowerCase();
  const targetKeywords = LANGUAGE_KEYWORDS[languageCode] || [languageCode];
  const otherEntries = Object.entries(LANGUAGE_KEYWORDS).filter(([code]) => code !== languageCode);

  if (targetKeywords.some((kw) => lower.includes(kw))) return true;

  const hasOtherLanguageTag = otherEntries.some(([, keywords]) => keywords.some((kw) => lower.includes(kw)));
  if (hasOtherLanguageTag) return false;

  return languageCode === 'en';
}

function maxByPeers(candidates) {
  return candidates.reduce((best, c) => (c.peers > best.peers ? c : best));
}

export function selectStream(streams, { minQuality, language }) {
  const minRank = qualityRank(minQuality);
  const parsed = streams
    .filter((s) => !!s.url)
    .map((s) => {
      const text = `${s.title || ''} ${s.name || ''}`;
      return {
        url: s.url,
        quality: parseQuality(text),
        peers: parsePeers(text),
        languageOk: matchesLanguage(text, language)
      };
    });

  const strict = parsed.filter((c) => c.languageOk && c.quality !== null && qualityRank(c.quality) >= minRank);
  if (strict.length) return maxByPeers(strict);

  const relaxed = parsed.filter((c) => c.languageOk);
  if (relaxed.length) return maxByPeers(relaxed);

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (31 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/streamSelect.js test/streamSelect.test.js
git commit -m "Add stream candidate parsing and selection logic"
```

---

### Task 5: Schedule store

**Files:**
- Create: `src/scheduleStore.js`
- Test: `test/scheduleStore.test.js`

**Interfaces:**
- Consumes: `mostRecentBoundary` from `src/scheduling.js`
- Produces: `schedulePath(dataDir: string, channelId: string) -> string`, `readSchedule(dataDir, channelId, { fs? }) -> Promise<Schedule|null>`, `writeSchedule(dataDir, channelId, schedule, { fs? }) -> Promise<void>`, `isScheduleFresh(schedule: Schedule|null, refreshTime: string, now: Date) -> boolean`, where `Schedule = { generatedAt: string, items: Array<{id, title, start, end, catalogRef}> }`

- [ ] **Step 1: Write the failing tests**

Create `test/scheduleStore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { schedulePath, readSchedule, writeSchedule, isScheduleFresh } from '../src/scheduleStore.js';

test('schedulePath joins dataDir/schedules/<id>.json', () => {
  assert.equal(schedulePath('/data', 'marvel-movies'), path.join('/data', 'schedules', 'marvel-movies.json'));
});

test('readSchedule returns null when file does not exist', async () => {
  const fakeFs = {
    readFile: async () => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    }
  };
  const result = await readSchedule('/data', 'x', { fs: fakeFs });
  assert.equal(result, null);
});

test('readSchedule parses the persisted JSON', async () => {
  const fakeFs = {
    readFile: async () => JSON.stringify({ generatedAt: '2026-07-22T00:00:00.000Z', items: [] })
  };
  const result = await readSchedule('/data', 'x', { fs: fakeFs });
  assert.equal(result.generatedAt, '2026-07-22T00:00:00.000Z');
});

test('writeSchedule creates the schedules directory and writes JSON', async () => {
  const calls = { mkdir: null, writeFile: null };
  const fakeFs = {
    mkdir: async (dir, opts) => { calls.mkdir = { dir, opts }; },
    writeFile: async (p, content) => { calls.writeFile = { p, content }; }
  };
  await writeSchedule('/data', 'x', { generatedAt: 'now', items: [] }, { fs: fakeFs });
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.ok(calls.writeFile.p.endsWith('x.json'));
  assert.deepEqual(JSON.parse(calls.writeFile.content), { generatedAt: 'now', items: [] });
});

test('isScheduleFresh is false for null schedule', () => {
  assert.equal(isScheduleFresh(null, '00:00', new Date()), false);
});

test('isScheduleFresh is true when generatedAt is at or after the most recent boundary', () => {
  const now = new Date('2026-07-22T10:00:00');
  const schedule = { generatedAt: new Date('2026-07-22T00:00:00').toISOString(), items: [] };
  assert.equal(isScheduleFresh(schedule, '00:00', now), true);
});

test('isScheduleFresh is false when generatedAt predates the most recent boundary', () => {
  const now = new Date('2026-07-22T10:00:00');
  const schedule = { generatedAt: new Date('2026-07-20T00:00:00').toISOString(), items: [] };
  assert.equal(isScheduleFresh(schedule, '00:00', now), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/scheduleStore.js'`

- [ ] **Step 3: Implement `src/scheduleStore.js`**

```js
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { mostRecentBoundary } from './scheduling.js';

export function schedulePath(dataDir, channelId) {
  return path.join(dataDir, 'schedules', `${channelId}.json`);
}

export async function readSchedule(dataDir, channelId, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(schedulePath(dataDir, channelId), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSchedule(dataDir, channelId, schedule, { fs = fsPromises } = {}) {
  const filePath = schedulePath(dataDir, channelId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(schedule, null, 2));
}

export function isScheduleFresh(schedule, refreshTime, now) {
  if (!schedule) return false;
  const boundary = mostRecentBoundary(refreshTime, now);
  return new Date(schedule.generatedAt).getTime() >= boundary.getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (38 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/scheduleStore.js test/scheduleStore.test.js
git commit -m "Add persisted schedule read/write/freshness logic"
```

---

### Task 6: XMLTV EPG builder

**Files:**
- Create: `src/xmltv.js`
- Test: `test/xmltv.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `toXmltvDate(iso: string) -> string`, `escapeXml(text: string) -> string`, `buildXmltv(channels: Array<{id, name, schedule: {items} | null}>) -> string`

- [ ] **Step 1: Write the failing tests**

Create `test/xmltv.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toXmltvDate, escapeXml, buildXmltv } from '../src/xmltv.js';

test('toXmltvDate formats an ISO string as XMLTV UTC date', () => {
  assert.equal(toXmltvDate('2026-07-22T10:05:09.000Z'), '20260722100509 +0000');
});

test('escapeXml escapes reserved characters', () => {
  assert.equal(escapeXml(`Tom & Jerry: "Cat" <3>`), 'Tom &amp; Jerry: &quot;Cat&quot; &lt;3&gt;');
});

test('buildXmltv includes a channel tag and programme tags for each item', () => {
  const xml = buildXmltv([
    {
      id: 'marvel-movies',
      name: 'Marvel Movies',
      schedule: {
        items: [
          { id: 'tt1', title: 'Iron Man', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:06:00.000Z' }
        ]
      }
    }
  ]);
  assert.match(xml, /<channel id="marvel-movies">/);
  assert.match(xml, /<display-name>Marvel Movies<\/display-name>/);
  assert.match(xml, /<programme start="20260722000000 \+0000" stop="20260722020600 \+0000" channel="marvel-movies">/);
  assert.match(xml, /<title>Iron Man<\/title>/);
});

test('buildXmltv handles a channel with no schedule yet', () => {
  const xml = buildXmltv([{ id: 'x', name: 'X', schedule: null }]);
  assert.match(xml, /<channel id="x">/);
  assert.doesNotMatch(xml, /<programme/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/xmltv.js'`

- [ ] **Step 3: Implement `src/xmltv.js`**

```js
export function toXmltvDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildXmltv(channels) {
  const channelTags = channels
    .map((ch) => `  <channel id="${escapeXml(ch.id)}">\n    <display-name>${escapeXml(ch.name)}</display-name>\n  </channel>`)
    .join('\n');

  const programmeTags = channels
    .flatMap((ch) => (ch.schedule?.items || []).map((item) => (
      `  <programme start="${toXmltvDate(item.start)}" stop="${toXmltvDate(item.end)}" channel="${escapeXml(ch.id)}">\n    <title>${escapeXml(item.title)}</title>\n  </programme>`
    )))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channelTags}\n${programmeTags}\n</tv>\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (42 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/xmltv.js test/xmltv.test.js
git commit -m "Add XMLTV EPG builder"
```

---

### Task 7: M3U playlist builder

**Files:**
- Create: `src/m3u.js`
- Test: `test/m3u.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `buildM3u(channels: Array<{id, name}>, baseUrl: string) -> string`

- [ ] **Step 1: Write the failing test**

Create `test/m3u.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildM3u } from '../src/m3u.js';

test('buildM3u emits one EXTINF + URL pair per channel', () => {
  const m3u = buildM3u([
    { id: 'marvel-movies', name: 'Marvel Movies' },
    { id: 'sitcoms-90s', name: '90s Sitcoms' }
  ], 'http://localhost:8080');

  const expected = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="marvel-movies" tvg-name="Marvel Movies" group-title="stremioTuner",Marvel Movies',
    'http://localhost:8080/stream/marvel-movies',
    '#EXTINF:-1 tvg-id="sitcoms-90s" tvg-name="90s Sitcoms" group-title="stremioTuner",90s Sitcoms',
    'http://localhost:8080/stream/sitcoms-90s',
    ''
  ].join('\n');

  assert.equal(m3u, expected);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/m3u.js'`

- [ ] **Step 3: Implement `src/m3u.js`**

```js
export function buildM3u(channels, baseUrl) {
  const lines = ['#EXTM3U'];
  for (const ch of channels) {
    lines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" group-title="stremioTuner",${ch.name}`);
    lines.push(`${baseUrl}/stream/${ch.id}`);
  }
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (43 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/m3u.js test/m3u.test.js
git commit -m "Add M3U playlist builder"
```

---

### Task 8: Stremio account client

**Files:**
- Create: `src/stremioAccount.js`
- Test: `test/stremioAccount.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `login(email, password, { fetchImpl?, apiBase? }) -> Promise<string authKey>`, `getInstalledAddons(authKey, { fetchImpl?, apiBase? }) -> Promise<Array<{transportUrl, manifest}>>`, `findAddonById(addons, addonId) -> {transportUrl, manifest}`, `getAuthKey({ email, password, cachePath, fs?, fetchImpl? }) -> Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `test/stremioAccount.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, getInstalledAddons, findAddonById, getAuthKey } from '../src/stremioAccount.js';

function fakeFetch(responses) {
  let call = 0;
  return async (url, opts) => {
    const r = responses[call++];
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body
    };
  };
}

test('login posts credentials and returns the authKey', async () => {
  const fetchImpl = fakeFetch([{ body: { result: { authKey: 'abc123' } } }]);
  const authKey = await login('a@b.com', 'pw', { fetchImpl, apiBase: 'https://api.example' });
  assert.equal(authKey, 'abc123');
});

test('login throws on error response', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401, body: { error: { message: 'bad creds' } } }]);
  await assert.rejects(() => login('a@b.com', 'wrong', { fetchImpl }), /bad creds/);
});

test('getInstalledAddons returns the addons array', async () => {
  const fetchImpl = fakeFetch([{ body: { result: { addons: [{ transportUrl: 'https://x/manifest.json', manifest: { id: 'org.x' } }] } } }]);
  const addons = await getInstalledAddons('abc123', { fetchImpl });
  assert.equal(addons[0].manifest.id, 'org.x');
});

test('findAddonById returns the matching addon', () => {
  const addons = [
    { transportUrl: 'https://a', manifest: { id: 'org.a' } },
    { transportUrl: 'https://b', manifest: { id: 'org.b' } }
  ];
  assert.equal(findAddonById(addons, 'org.b').transportUrl, 'https://b');
});

test('findAddonById throws when no addon matches', () => {
  assert.throws(() => findAddonById([], 'org.missing'), /org.missing/);
});

test('getAuthKey returns the cached key without logging in again', async () => {
  const fakeFs = { readFile: async () => JSON.stringify({ authKey: 'cached-key' }) };
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const authKey = await getAuthKey({ email: 'a@b.com', password: 'pw', cachePath: '/data/auth.json', fs: fakeFs, fetchImpl });
  assert.equal(authKey, 'cached-key');
});

test('getAuthKey logs in and writes the cache when no cache exists', async () => {
  let written = null;
  const fakeFs = {
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    writeFile: async (p, content) => { written = { p, content }; }
  };
  const fetchImpl = fakeFetch([{ body: { result: { authKey: 'fresh-key' } } }]);
  const authKey = await getAuthKey({ email: 'a@b.com', password: 'pw', cachePath: '/data/auth.json', fs: fakeFs, fetchImpl });
  assert.equal(authKey, 'fresh-key');
  assert.equal(JSON.parse(written.content).authKey, 'fresh-key');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/stremioAccount.js'`

- [ ] **Step 3: Implement `src/stremioAccount.js`**

```js
import fsPromises from 'node:fs/promises';

const STREMIO_API = 'https://api.strem.io/api';

export async function login(email, password, { fetchImpl = fetch, apiBase = STREMIO_API } = {}) {
  const res = await fetchImpl(`${apiBase}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Stremio login failed: ${data.error?.message || res.status}`);
  }
  return data.result.authKey;
}

export async function getInstalledAddons(authKey, { fetchImpl = fetch, apiBase = STREMIO_API } = {}) {
  const res = await fetchImpl(`${apiBase}/addonCollectionGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Fetching installed addons failed: ${data.error?.message || res.status}`);
  }
  return data.result.addons;
}

export function findAddonById(addons, addonId) {
  const found = addons.find((a) => a.manifest.id === addonId);
  if (!found) {
    throw new Error(`Addon "${addonId}" not found among installed Stremio addons`);
  }
  return found;
}

export async function getAuthKey({ email, password, cachePath, fs = fsPromises, fetchImpl = fetch }) {
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    if (cached.authKey) return cached.authKey;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const authKey = await login(email, password, { fetchImpl });
  await fs.writeFile(cachePath, JSON.stringify({ authKey }));
  return authKey;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (50 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/stremioAccount.js test/stremioAccount.test.js
git commit -m "Add Stremio account login and addon discovery client"
```

---

### Task 9: Stremio addon protocol client

**Files:**
- Create: `src/addonClient.js`
- Test: `test/addonClient.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `fetchCatalog(transportUrl, type, catalogId, { fetchImpl? }) -> Promise<Array<{id, type, name}>>`, `fetchMeta(transportUrl, type, id, { fetchImpl? }) -> Promise<{id, runtime}|null>`, `fetchStreams(transportUrl, type, id, { fetchImpl? }) -> Promise<Array<{title, name, url}>>`, `resolveChannelSource(manifest: {id, catalogs}, catalogId: string) -> {type: string, catalogId: string}`

- [ ] **Step 1: Write the failing tests**

Create `test/addonClient.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalog, fetchMeta, fetchStreams, resolveChannelSource } from '../src/addonClient.js';

function fakeFetch(expectedUrl, body, ok = true) {
  return async (url) => {
    assert.equal(url, expectedUrl);
    return { ok, status: ok ? 200 : 500, json: async () => body };
  };
}

test('fetchCatalog requests the correct URL and returns metas', async () => {
  const fetchImpl = fakeFetch(
    'https://addon.example/catalog/movie/marvel-movies.json',
    { metas: [{ id: 'tt1', type: 'movie', name: 'Iron Man' }] }
  );
  const items = await fetchCatalog('https://addon.example/manifest.json', 'movie', 'marvel-movies', { fetchImpl });
  assert.deepEqual(items, [{ id: 'tt1', type: 'movie', name: 'Iron Man' }]);
});

test('fetchCatalog throws on a non-ok response', async () => {
  const fetchImpl = fakeFetch('https://addon.example/catalog/movie/x.json', {}, false);
  await assert.rejects(() => fetchCatalog('https://addon.example/manifest.json', 'movie', 'x', { fetchImpl }));
});

test('fetchMeta returns the meta object', async () => {
  const fetchImpl = fakeFetch(
    'https://addon.example/meta/movie/tt1.json',
    { meta: { id: 'tt1', runtime: '126 min' } }
  );
  const meta = await fetchMeta('https://addon.example/manifest.json', 'movie', 'tt1', { fetchImpl });
  assert.equal(meta.runtime, '126 min');
});

test('fetchMeta returns null on a non-ok response', async () => {
  const fetchImpl = fakeFetch('https://addon.example/meta/movie/tt1.json', {}, false);
  const meta = await fetchMeta('https://addon.example/manifest.json', 'movie', 'tt1', { fetchImpl });
  assert.equal(meta, null);
});

test('fetchStreams returns the streams array', async () => {
  const fetchImpl = fakeFetch(
    'https://addon.example/stream/movie/tt1.json',
    { streams: [{ title: '1080p', url: 'http://x' }] }
  );
  const streams = await fetchStreams('https://addon.example/manifest.json', 'movie', 'tt1', { fetchImpl });
  assert.deepEqual(streams, [{ title: '1080p', url: 'http://x' }]);
});

test('resolveChannelSource finds the catalog\'s type by id', () => {
  const manifest = { id: 'org.x', catalogs: [{ id: 'marvel-movies', type: 'movie' }, { id: 'sitcoms', type: 'series' }] };
  assert.deepEqual(resolveChannelSource(manifest, 'sitcoms'), { type: 'series', catalogId: 'sitcoms' });
});

test('resolveChannelSource throws when the catalog id is not in the manifest', () => {
  const manifest = { id: 'org.x', catalogs: [] };
  assert.throws(() => resolveChannelSource(manifest, 'missing'), /missing/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/addonClient.js'`

- [ ] **Step 3: Implement `src/addonClient.js`**

```js
function addonBaseUrl(transportUrl) {
  return transportUrl.replace(/manifest\.json$/, '');
}

export async function fetchCatalog(transportUrl, type, catalogId, { fetchImpl = fetch } = {}) {
  const url = `${addonBaseUrl(transportUrl)}catalog/${type}/${catalogId}.json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Catalog fetch failed (${res.status}): ${url}`);
  const data = await res.json();
  return data.metas || [];
}

export async function fetchMeta(transportUrl, type, id, { fetchImpl = fetch } = {}) {
  const url = `${addonBaseUrl(transportUrl)}meta/${type}/${id}.json`;
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.meta || null;
}

export async function fetchStreams(transportUrl, type, id, { fetchImpl = fetch } = {}) {
  const url = `${addonBaseUrl(transportUrl)}stream/${type}/${id}.json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Stream fetch failed (${res.status}): ${url}`);
  const data = await res.json();
  return data.streams || [];
}

export function resolveChannelSource(manifest, catalogId) {
  const catalog = (manifest.catalogs || []).find((c) => c.id === catalogId);
  if (!catalog) {
    throw new Error(`Catalog "${catalogId}" not found in manifest for addon "${manifest.id}"`);
  }
  return { type: catalog.type, catalogId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (57 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/addonClient.js test/addonClient.test.js
git commit -m "Add Stremio addon protocol client"
```

---

### Task 10: Schedule generation orchestrator

**Files:**
- Create: `src/generateSchedule.js`
- Test: `test/generateSchedule.test.js`

**Interfaces:**
- Consumes: `buildRandomStartLineup`, `buildRandomLineup` from `src/lineup.js`; `fetchCatalog`, `fetchMeta` from `src/addonClient.js` (as an injectable `addonClientImpl` object)
- Produces: `generateChannelSchedule({ channel: {mode, catalog}, source: {transportUrl, type}, addonClientImpl?, now?, targetWindowMs?, defaultRuntimeMs?, rng? }) -> Promise<{generatedAt: string, items: Array<{id, title, start, end, catalogRef}>}>`

- [ ] **Step 1: Write the failing tests**

Create `test/generateSchedule.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateChannelSchedule } from '../src/generateSchedule.js';

const ITEMS = [
  { id: 'tt1', type: 'movie', name: 'Movie One' },
  { id: 'tt2', type: 'movie', name: 'Movie Two' }
];

function makeAddonClientImpl({ metaByFor = {} } = {}) {
  return {
    fetchCatalog: async () => ITEMS,
    fetchMeta: async (transportUrl, type, id) => metaByFor[id] || null
  };
}

test('random-start mode wraps the catalog sequentially starting at a random index', async () => {
  const addonClientImpl = makeAddonClientImpl({ metaByFor: { tt1: { runtime: '60 min' }, tt2: { runtime: '60 min' } } });
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 3 * 60 * 60 * 1000, // 3 hours -> 3 items at 60 min each
    rng: () => 0.9 // floor(0.9*2) = 1 -> starts at tt2
  });

  assert.equal(schedule.generatedAt, '2026-07-22T00:00:00.000Z');
  assert.deepEqual(schedule.items.map((i) => i.id), ['tt2', 'tt1', 'tt2']);
  assert.equal(schedule.items[0].start, '2026-07-22T00:00:00.000Z');
  assert.equal(schedule.items[0].end, '2026-07-22T01:00:00.000Z');
  assert.equal(schedule.items[1].start, '2026-07-22T01:00:00.000Z');
});

test('random mode independently picks items and allows repeats', async () => {
  const addonClientImpl = makeAddonClientImpl({ metaByFor: { tt1: { runtime: '60 min' }, tt2: { runtime: '60 min' } } });
  const values = [0, 0, 0];
  let i = 0;
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 2.5 * 60 * 60 * 1000,
    rng: () => values[i++]
  });

  assert.deepEqual(schedule.items.map((i) => i.id), ['tt1', 'tt1', 'tt1']);
});

test('falls back to the default runtime when meta has no runtime', async () => {
  const addonClientImpl = makeAddonClientImpl({});
  const schedule = await generateChannelSchedule({
    channel: { mode: 'random-start', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 90 * 60 * 1000,
    defaultRuntimeMs: 90 * 60 * 1000,
    rng: () => 0
  });
  assert.equal(schedule.items.length, 1);
  assert.equal(schedule.items[0].end, '2026-07-22T01:30:00.000Z');
});

test('caches meta lookups so a repeated item is not fetched twice', async () => {
  let fetchCount = 0;
  const addonClientImpl = {
    fetchCatalog: async () => ITEMS,
    fetchMeta: async () => { fetchCount += 1; return { runtime: '30 min' }; }
  };
  await generateChannelSchedule({
    channel: { mode: 'random', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    targetWindowMs: 90 * 60 * 1000,
    rng: () => 0 // always picks ITEMS[0] = tt1
  });
  assert.equal(fetchCount, 1);
});

test('throws when the catalog returns no items', async () => {
  const addonClientImpl = { fetchCatalog: async () => [], fetchMeta: async () => null };
  await assert.rejects(() => generateChannelSchedule({
    channel: { mode: 'random', catalog: 'x' },
    source: { transportUrl: 'https://addon/manifest.json', type: 'movie' },
    addonClientImpl
  }), /no items/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/generateSchedule.js'`

- [ ] **Step 3: Implement `src/generateSchedule.js`**

```js
import * as addonClient from './addonClient.js';
import { buildRandomStartLineup, buildRandomLineup } from './lineup.js';

function parseRuntimeMs(runtime) {
  if (!runtime) return null;
  const match = String(runtime).match(/(\d+)/);
  if (!match) return null;
  return Number(match[1]) * 60 * 1000;
}

function makeEntry(item, startMs, runtimeMs) {
  return {
    id: item.id,
    title: item.name,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + runtimeMs).toISOString(),
    catalogRef: { type: item.type, id: item.id }
  };
}

export async function generateChannelSchedule({
  channel,
  source,
  addonClientImpl = addonClient,
  now = () => new Date(),
  targetWindowMs = 48 * 60 * 60 * 1000,
  defaultRuntimeMs = 90 * 60 * 1000,
  rng = Math.random
}) {
  const items = await addonClientImpl.fetchCatalog(source.transportUrl, source.type, channel.catalog);
  if (!items.length) {
    throw new Error(`Catalog "${channel.catalog}" returned no items`);
  }

  const runtimeCache = new Map();
  async function getRuntimeMs(item) {
    if (runtimeCache.has(item.id)) return runtimeCache.get(item.id);
    const meta = await addonClientImpl.fetchMeta(source.transportUrl, source.type, item.id);
    const ms = parseRuntimeMs(meta?.runtime) ?? defaultRuntimeMs;
    runtimeCache.set(item.id, ms);
    return ms;
  }

  const startTime = now().getTime();
  let cursorTime = startTime;
  const lineupItems = [];

  if (channel.mode === 'random-start') {
    const ordered = buildRandomStartLineup(items, rng);
    let i = 0;
    while (cursorTime - startTime < targetWindowMs) {
      const item = ordered[i % ordered.length];
      const runtimeMs = await getRuntimeMs(item);
      lineupItems.push(makeEntry(item, cursorTime, runtimeMs));
      cursorTime += runtimeMs;
      i += 1;
    }
  } else {
    while (cursorTime - startTime < targetWindowMs) {
      const [item] = buildRandomLineup(items, 1, rng);
      const runtimeMs = await getRuntimeMs(item);
      lineupItems.push(makeEntry(item, cursorTime, runtimeMs));
      cursorTime += runtimeMs;
    }
  }

  return {
    generatedAt: new Date(startTime).toISOString(),
    items: lineupItems
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (62 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/generateSchedule.js test/generateSchedule.test.js
git commit -m "Add per-channel daily schedule generation orchestrator"
```

---

### Task 11: ffmpeg stream proxy

**Files:**
- Create: `src/server/ffmpegProxy.js`
- Test: `test/ffmpegProxy.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `buildArgs(sourceUrl: string, offsetSeconds: number, mode: 'copy'|'transcode') -> string[]`, `streamViaFfmpeg({ sourceUrl, offsetSeconds, res, spawnImpl?, ffmpegPath?, onLog? }) -> Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/ffmpegProxy.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildArgs, streamViaFfmpeg } from '../src/server/ffmpegProxy.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function fakeRes() {
  return {
    headers: {},
    written: [],
    ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; }
  };
}

test('buildArgs constructs copy args with the seek offset', () => {
  assert.deepEqual(
    buildArgs('http://x', 125.9, 'copy'),
    ['-ss', '125', '-i', 'http://x', '-c', 'copy', '-f', 'mpegts', 'pipe:1']
  );
});

test('buildArgs constructs transcode args', () => {
  assert.deepEqual(
    buildArgs('http://x', 0, 'transcode'),
    ['-ss', '0', '-i', 'http://x', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1']
  );
});

test('streamViaFfmpeg pipes copy-mode output straight through on success', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].stdout.write('chunk1');
  children[0].emit('exit', 0);
  await promise;

  assert.equal(children.length, 1);
  assert.deepEqual(res.written, ['chunk1']);
  assert.equal(res.ended, true);
});

test('streamViaFfmpeg falls back to transcode when copy exits nonzero with no output', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].emit('exit', 1);
  await new Promise((r) => setImmediate(r));
  children[1].stdout.write('chunk-from-transcode');
  children[1].emit('exit', 0);
  await promise;

  assert.equal(children.length, 2);
  assert.deepEqual(res.written, ['chunk-from-transcode']);
});

test('streamViaFfmpeg does not fall back once bytes have already been sent', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].stdout.write('partial-chunk');
  children[0].emit('exit', 1);
  await promise;

  assert.equal(children.length, 1);
  assert.deepEqual(res.written, ['partial-chunk']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/server/ffmpegProxy.js'`

- [ ] **Step 3: Implement `src/server/ffmpegProxy.js`**

```js
import { spawn } from 'node:child_process';

export function buildArgs(sourceUrl, offsetSeconds, mode) {
  const args = ['-ss', String(Math.max(0, Math.floor(offsetSeconds))), '-i', sourceUrl];
  if (mode === 'copy') {
    args.push('-c', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-c:a', 'aac');
  }
  args.push('-f', 'mpegts', 'pipe:1');
  return args;
}

export function streamViaFfmpeg({ sourceUrl, offsetSeconds, res, spawnImpl = spawn, ffmpegPath = 'ffmpeg', onLog = () => {} }) {
  return new Promise((resolve) => {
    let bytesSent = false;

    function run(mode) {
      const child = spawnImpl(ffmpegPath, buildArgs(sourceUrl, offsetSeconds, mode));

      child.stdout.on('data', (chunk) => {
        bytesSent = true;
        res.write(chunk);
      });

      child.stderr.on('data', (chunk) => {
        onLog(chunk.toString());
      });

      child.on('error', (err) => {
        onLog(`ffmpeg spawn error: ${err.message}`);
        if (!bytesSent && mode === 'copy') {
          run('transcode');
        } else {
          res.end();
          resolve();
        }
      });

      child.on('exit', (code) => {
        if (code !== 0 && !bytesSent && mode === 'copy') {
          run('transcode');
        } else {
          res.end();
          resolve();
        }
      });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    run('copy');
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (67 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/server/ffmpegProxy.js test/ffmpegProxy.test.js
git commit -m "Add ffmpeg-based seek/proxy for live channel playback"
```

---

### Task 12: Express app and routes

**Files:**
- Create: `src/server/app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `buildM3u` from `src/m3u.js`; `buildXmltv` from `src/xmltv.js`; `readSchedule` from `src/scheduleStore.js`; `selectStream` from `src/streamSelect.js`; `fetchStreams` from `src/addonClient.js`; `streamViaFfmpeg` from `src/server/ffmpegProxy.js`
- Produces: `createApp({ channels: Array<{id, name, minQuality, language, source: {transportUrl, type}}>, dataDir: string, baseUrl: string, fetchStreamsImpl?, streamViaFfmpegImpl?, nowImpl? }) -> ExpressApp`

- [ ] **Step 1: Write the failing tests**

Create `test/app.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { writeSchedule } from '../src/scheduleStore.js';

async function withApp(t, { channels, schedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  for (const [channelId, schedule] of Object.entries(schedules)) {
    await writeSchedule(dataDir, channelId, schedule);
  }
  const app = createApp({
    channels,
    dataDir,
    baseUrl: 'http://localhost:0',
    fetchStreamsImpl,
    streamViaFfmpegImpl,
    nowImpl
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

test('GET /playlist.m3u returns an M3U referencing the channel', async (t) => {
  const baseUrl = await withApp(t, { channels: [{ id: 'x', name: 'X' }] });
  const res = await fetch(`${baseUrl}/playlist.m3u`);
  const text = await res.text();
  assert.match(text, /#EXTM3U/);
  assert.match(text, /\/stream\/x/);
});

test('GET /epg.xml includes programme entries from the persisted schedule', async (t) => {
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Iron Man', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, { channels: [{ id: 'x', name: 'X' }], schedules: { x: schedule } });
  const res = await fetch(`${baseUrl}/epg.xml`);
  const text = await res.text();
  assert.match(text, /Iron Man/);
});

test('GET /stream/:channelId 404s for an unknown channel', async (t) => {
  const baseUrl = await withApp(t, { channels: [{ id: 'x', name: 'X' }] });
  const res = await fetch(`${baseUrl}/stream/unknown`);
  assert.equal(res.status, 404);
});

test('GET /stream/:channelId 404s when nothing is currently scheduled', async (t) => {
  const schedule = { generatedAt: '2020-01-01T00:00:00.000Z', items: [{ id: 'tt1', title: 'Old', start: '2020-01-01T00:00:00.000Z', end: '2020-01-01T01:00:00.000Z' }] };
  const baseUrl = await withApp(t, { channels: [{ id: 'x', name: 'X' }], schedules: { x: schedule } });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 404);
});

test('GET /stream/:channelId 502s when the channel has no resolved addon source', async (t) => {
  const now = new Date('2026-07-22T01:00:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: null }],
    schedules: { x: schedule },
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
});

test('GET /stream/:channelId 502s when no stream passes selection', async (t) => {
  const now = new Date('2026-07-22T01:00:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '1080p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '[French] 480p', url: 'http://a' }],
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 502);
});

test('GET /stream/:channelId resolves the current item, selects a stream, and proxies via ffmpeg with the right offset', async (t) => {
  const now = new Date('2026-07-22T00:30:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  let capturedArgs = null;
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => [{ title: '1080p 👤 20', url: 'http://good' }],
    streamViaFfmpegImpl: async (args) => { capturedArgs = args; args.res.end(); },
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 200);
  assert.equal(capturedArgs.sourceUrl, 'http://good');
  assert.equal(capturedArgs.offsetSeconds, 30 * 60);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/server/app.js'`

- [ ] **Step 3: Implement `src/server/app.js`**

```js
import express from 'express';
import { buildM3u } from '../m3u.js';
import { buildXmltv } from '../xmltv.js';
import { readSchedule } from '../scheduleStore.js';
import { selectStream } from '../streamSelect.js';
import { fetchStreams } from '../addonClient.js';
import { streamViaFfmpeg } from './ffmpegProxy.js';

export function createApp({
  channels,
  dataDir,
  baseUrl,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  nowImpl = () => new Date()
}) {
  const app = express();

  app.get('/playlist.m3u', (req, res) => {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(buildM3u(channels, baseUrl));
  });

  app.get('/epg.xml', async (req, res) => {
    const withSchedules = await Promise.all(channels.map(async (ch) => ({
      ...ch,
      schedule: await readSchedule(dataDir, ch.id)
    })));
    res.setHeader('Content-Type', 'application/xml');
    res.send(buildXmltv(withSchedules));
  });

  app.get('/stream/:channelId', async (req, res) => {
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
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (74 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/server/app.js test/app.test.js
git commit -m "Add Express app serving playlist, EPG, and live stream proxy routes"
```

---

### Task 13: Bootstrap wiring and entrypoint

**Files:**
- Create: `src/bootstrap.js`
- Create: `src/index.js`
- Test: `test/bootstrap.test.js`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.js`; `getAuthKey`, `getInstalledAddons`, `findAddonById` from `src/stremioAccount.js`; `resolveChannelSource` from `src/addonClient.js`; `generateChannelSchedule` from `src/generateSchedule.js`; `readSchedule`, `writeSchedule`, `isScheduleFresh` from `src/scheduleStore.js`; `scheduleDailyAt` from `src/scheduling.js`; `createApp` from `src/server/app.js`
- Produces: `withRetries(fn: () => Promise<T>, { retries?, delayMs?, sleepImpl? }) -> Promise<T>`, `bootstrap(overrides = {}) -> Promise<{ app, channels, server }>`. If Stremio login/addon discovery fails even after retries, `bootstrap` logs the error and still starts the server — affected channels get `source: null` (schedules aren't regenerated for them, but any previously-persisted schedule is still served; `/stream/:channelId` reports 502 for those channels per Task 12).

- [ ] **Step 1: Write the failing test**

Create `test/bootstrap.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/bootstrap.js';

function fakeApp() {
  return { listen: (port, cb) => { cb?.(); return { address: () => ({ port }) }; } };
}

test('bootstrap resolves each channel\'s source and only regenerates stale schedules', async () => {
  const writtenSchedules = [];
  const createdAppArgs = [];

  const result = await bootstrap({
    env: { DATA_DIR: '/data', CONFIG_PATH: '/data/config.yml', PORT: '9999', BASE_URL: 'http://localhost:9999', STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    loadConfigImpl: async () => ({
      refreshTime: '00:00',
      channels: [
        { id: 'fresh', name: 'Fresh', addon: 'org.a', catalog: 'cat-a', mode: 'random', minQuality: '480p', language: 'en' },
        { id: 'stale', name: 'Stale', addon: 'org.b', catalog: 'cat-b', mode: 'random-start', minQuality: '480p', language: 'en' }
      ]
    }),
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

  assert.deepEqual(writtenSchedules, ['stale']);
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'fresh').source.transportUrl, 'https://a/manifest.json');
  assert.equal(createdAppArgs[0].channels.find((c) => c.id === 'stale').source.type, 'series');
  assert.equal(result.app, createdAppArgs[0] && result.app);
});

test('bootstrap retries a failing getAuthKey with backoff before giving up', async () => {
  let attempts = 0;
  const sleeps = [];
  const createdAppArgs = [];

  await bootstrap({
    env: { STREMIO_EMAIL: 'a@b.com', STREMIO_PASSWORD: 'pw' },
    loadConfigImpl: async () => ({
      refreshTime: '00:00',
      channels: [{ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', mode: 'random', minQuality: '480p', language: 'en' }]
    }),
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
    loadConfigImpl: async () => ({
      refreshTime: '00:00',
      channels: [{ id: 'x', name: 'X', addon: 'org.a', catalog: 'cat-a', mode: 'random', minQuality: '480p', language: 'en' }]
    }),
    getAuthKeyImpl: async () => { throw new Error('always fails'); },
    sleepImpl: async () => {},
    readScheduleImpl: async () => ({ generatedAt: '2026-07-22T00:00:00.000Z', items: [] }),
    isScheduleFreshImpl: () => true,
    writeScheduleImpl: async (dataDir, channelId) => { writtenSchedules.push(channelId); },
    scheduleDailyAtImpl: () => ({ cancel() {} }),
    createAppImpl: (args) => { createdAppArgs.push(args); return fakeApp(); }
  });

  assert.equal(createdAppArgs[0].channels[0].source, null);
  assert.deepEqual(writtenSchedules, []);
  assert.ok(result.server);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/bootstrap.js'`

- [ ] **Step 3: Implement `src/bootstrap.js`**

```js
import { loadConfig } from './config.js';
import { getAuthKey, getInstalledAddons, findAddonById } from './stremioAccount.js';
import { resolveChannelSource } from './addonClient.js';
import { generateChannelSchedule } from './generateSchedule.js';
import { readSchedule, writeSchedule, isScheduleFresh } from './scheduleStore.js';
import { scheduleDailyAt } from './scheduling.js';
import { createApp } from './server/app.js';

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
  loadConfigImpl = loadConfig,
  getAuthKeyImpl = getAuthKey,
  getInstalledAddonsImpl = getInstalledAddons,
  findAddonByIdImpl = findAddonById,
  resolveChannelSourceImpl = resolveChannelSource,
  generateChannelScheduleImpl = generateChannelSchedule,
  readScheduleImpl = readSchedule,
  writeScheduleImpl = writeSchedule,
  isScheduleFreshImpl = isScheduleFresh,
  scheduleDailyAtImpl = scheduleDailyAt,
  createAppImpl = createApp,
  sleepImpl
} = {}) {
  const dataDir = env.DATA_DIR || '/data';
  const configPath = env.CONFIG_PATH || `${dataDir}/config.yml`;
  const port = Number(env.PORT || 8080);
  const baseUrl = env.BASE_URL || `http://localhost:${port}`;

  const config = await loadConfigImpl(configPath);

  let installedAddons = null;
  try {
    const authKey = await withRetries(() => getAuthKeyImpl({
      email: env.STREMIO_EMAIL,
      password: env.STREMIO_PASSWORD,
      cachePath: `${dataDir}/auth.json`
    }), { sleepImpl });
    installedAddons = await getInstalledAddonsImpl(authKey);
  } catch (err) {
    console.error(`Stremio login/addon discovery failed after retries, continuing with cached schedules only: ${err.message}`);
  }

  const channels = config.channels.map((channel) => {
    if (!installedAddons) return { ...channel, source: null };
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, channel.addon);
      const source = {
        transportUrl: addonEntry.transportUrl,
        ...resolveChannelSourceImpl(addonEntry.manifest, channel.catalog)
      };
      return { ...channel, source };
    } catch (err) {
      console.error(`Could not resolve addon source for channel "${channel.name}": ${err.message}`);
      return { ...channel, source: null };
    }
  });

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

  for (const channel of channels) {
    const existing = await readScheduleImpl(dataDir, channel.id);
    if (!isScheduleFreshImpl(existing, config.refreshTime, new Date())) {
      await regenerate(channel);
    }
  }

  scheduleDailyAtImpl(config.refreshTime, () => {
    channels.forEach(regenerate);
  });

  const app = createAppImpl({ channels, dataDir, baseUrl });
  const server = app.listen(port, () => console.log(`stremioTuner listening on port ${port}`));

  return { app, channels, server };
}
```

Create `src/index.js`:

```js
import { bootstrap } from './bootstrap.js';

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (77 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.js src/index.js test/bootstrap.test.js
git commit -m "Wire all modules together with a testable bootstrap and thin entrypoint"
```

---

### Task 14: Docker packaging and manual verification

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `config.example.yml`

**Interfaces:**
- Consumes: `src/index.js` as the container's entrypoint
- Produces: a runnable Docker image exposing `PORT` and mounting `/data`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

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

- [ ] **Step 2: Create `docker-compose.yml`**

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
    volumes:
      - ./data:/data
    restart: unless-stopped
```

- [ ] **Step 3: Create `config.example.yml`**

```yaml
# Copy this file to ./data/config.yml and edit before starting the container.
refreshTime: "00:00"  # local time (see TZ env var) at which schedules regenerate daily

channels:
  - name: "Marvel Movies"
    addon: "org.stremio.torrentio.addon"   # the addon manifest's "id" field — NOT a URL.
                                            # Must match an addon actually installed on
                                            # your Stremio account (its transportUrl,
                                            # including any embedded debrid key, is
                                            # looked up automatically at startup).
    catalog: "marvel-movies"               # a catalog "id" from that addon's manifest
    mode: "random-start"                   # "random-start" | "random"
    minQuality: "720p"                     # "480p" | "720p" | "1080p" | "2160p"
    language: "en"                         # "en" | "es" | "fr" | "de" | "it" | "pt"
```

- [ ] **Step 4: Run the full test suite one more time**

Run: `npm test`
Expected: PASS (77 tests total)

- [ ] **Step 5: Build the Docker image**

```bash
docker build -t stremio-tuner .
```

Expected: image builds successfully with `ffmpeg` installed.

- [ ] **Step 6: Manual smoke test with a real Stremio account**

```bash
mkdir -p data
cp config.example.yml data/config.yml
# edit data/config.yml with real addon id(s)/catalog(s) you have installed
docker run --rm -p 8080:8080 \
  -e STREMIO_EMAIL=you@example.com \
  -e STREMIO_PASSWORD='your-password' \
  -v "$(pwd)/data:/data" \
  stremio-tuner
```

In another terminal:

```bash
curl http://localhost:8080/playlist.m3u
curl http://localhost:8080/epg.xml
```

Expected: `/playlist.m3u` lists one entry per configured channel; `/epg.xml` contains `<programme>` entries with real titles/times. Open `http://localhost:8080/playlist.m3u` in VLC (Media → Open Network Stream) and confirm a channel starts mid-program rather than at 0:00.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml config.example.yml
git commit -m "Add Docker packaging and manual verification steps"
```
