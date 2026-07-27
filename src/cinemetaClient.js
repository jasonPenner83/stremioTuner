import { parseRuntimeMs } from './runtimeParse.js';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

export function isImdbId(id) {
  return /^tt\d+/.test(String(id));
}

export async function fetchCinemetaRuntimeMs(type, id, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!isImdbId(id)) return null;
  try {
    const res = await fetchImpl(`${CINEMETA_BASE}/meta/${type}/${id}.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return parseRuntimeMs(data?.meta?.runtime);
  } catch {
    return null;
  }
}
