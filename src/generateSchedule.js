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
    const parsed = parseRuntimeMs(meta?.runtime);
    const ms = parsed && parsed > 0 ? parsed : defaultRuntimeMs;
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
