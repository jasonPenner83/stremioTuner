import * as addonClient from './addonClient.js';
import { buildRandomStartLineup, buildRandomLineup } from './lineup.js';
import { parseRuntimeMs } from './runtimeParse.js';
import { resolvePlayableUrl } from './resolvePlayableUrl.js';
import { probeDurationMs } from './durationProbe.js';
import { fetchCinemetaRuntimeMs } from './cinemetaClient.js';

// Below this, a probed value is treated as a degenerate/unreliable ffprobe
// result (e.g. a preview clip) rather than a genuine full-length duration, so
// it falls through unresolved instead of being trusted and cached.
const MIN_PROBED_DURATION_MS = 60 * 1000;

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
  rng = Math.random,
  realDebridApiKey = null,
  durationCache = {},
  resolvePlayableUrlImpl = resolvePlayableUrl,
  probeDurationMsImpl = probeDurationMs,
  fetchCinemetaRuntimeImpl = fetchCinemetaRuntimeMs
}) {
  const items = await addonClientImpl.fetchCatalog(source.transportUrl, source.type, channel.catalog);
  if (!items.length) {
    throw new Error(`Catalog "${channel.catalog}" returned no items`);
  }

  const runtimeCache = new Map();

  async function resolveDurationMs(item) {
    const cached = durationCache[item.id];
    if (cached && cached.ms) return cached.ms;

    const meta = await addonClientImpl.fetchMeta(source.transportUrl, source.type, item.id);
    const metaMs = parseRuntimeMs(meta?.runtime);
    if (metaMs && metaMs > 0) {
      durationCache[item.id] = { ms: metaMs, source: 'meta', resolvedAt: new Date().toISOString() };
      return metaMs;
    }

    const cinemetaMs = await fetchCinemetaRuntimeImpl(source.type, item.id);
    if (cinemetaMs && cinemetaMs > 0) {
      durationCache[item.id] = { ms: cinemetaMs, source: 'cinemeta', resolvedAt: new Date().toISOString() };
      return cinemetaMs;
    }

    const streamSource = channel.streamSource || source;
    try {
      const url = await resolvePlayableUrlImpl({
        item,
        type: source.type,
        channel,
        streamSource,
        realDebridApiKey
      });
      if (url) {
        const probedMs = await probeDurationMsImpl(url);
        if (probedMs && probedMs >= MIN_PROBED_DURATION_MS) {
          durationCache[item.id] = { ms: probedMs, source: 'probe', resolvedAt: new Date().toISOString() };
          return probedMs;
        }
      }
    } catch (err) {
      console.error(`Duration probe failed for item "${item.id}": ${err.message}`);
    }

    return null;
  }

  async function getRuntimeMs(item) {
    if (runtimeCache.has(item.id)) return runtimeCache.get(item.id);
    const resolved = await resolveDurationMs(item);
    const ms = resolved && resolved > 0 ? resolved : defaultRuntimeMs;
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
