const API_BASE = 'https://api.real-debrid.com/rest/1.0';

export const MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024;

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function formHeaders(apiKey) {
  return { ...authHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' };
}

export function parseSeasonEpisode(id) {
  const match = String(id).match(/:(\d+):(\d+)$/);
  if (!match) return {};
  return { season: Number(match[1]), episode: Number(match[2]) };
}

const EPISODE_RE = /s(\d{1,2})e(\d{1,2})|(\d{1,2})x(\d{1,2})/i;

export function pickTorrentFile(files, { season, episode } = {}) {
  if (season != null && episode != null) {
    const found = files.find((f) => {
      const m = f.path.match(EPISODE_RE);
      if (!m) return false;
      const s = Number(m[1] ?? m[3]);
      const e = Number(m[2] ?? m[4]);
      return s === season && e === episode;
    });
    if (found) return found;
  }
  if (!files.length) return null;
  return files.reduce((largest, f) => (f.bytes > largest.bytes ? f : largest));
}

export async function checkInstantAvailability(apiKey, infoHashes, { fetchImpl = fetch } = {}) {
  if (!infoHashes.length) return new Set();
  const path = infoHashes.map((h) => h.toLowerCase()).join('/');
  const res = await fetchImpl(`${API_BASE}/torrents/instantAvailability/${path}`, {
    headers: authHeaders(apiKey)
  });
  if (!res.ok) throw new Error(`instantAvailability failed (${res.status})`);
  const data = await res.json();
  const cached = new Set();
  for (const hash of infoHashes) {
    const entry = data[hash.toLowerCase()];
    if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) cached.add(hash);
  }
  return cached;
}

async function findExistingTorrent(apiKey, infoHash, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`list torrents failed (${res.status})`);
  const list = await res.json();
  return list.find((t) => t.hash?.toLowerCase() === infoHash.toLowerCase() && t.links?.length > 0) || null;
}

async function addMagnet(apiKey, infoHash, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents/addMagnet`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${infoHash}` })
  });
  if (!res.ok) throw new Error(`addMagnet failed (${res.status})`);
  return res.json();
}

async function getTorrentInfo(apiKey, id, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents/info/${id}`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`torrent info failed (${res.status})`);
  return res.json();
}

async function selectFiles(apiKey, id, fileId, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/torrents/selectFiles/${id}`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ files: String(fileId) })
  });
  if (!res.ok) throw new Error(`selectFiles failed (${res.status})`);
}

async function unrestrictLink(apiKey, link, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: formHeaders(apiKey),
    body: new URLSearchParams({ link })
  });
  if (!res.ok) throw new Error(`unrestrict/link failed (${res.status})`);
  const data = await res.json();
  if (typeof data.filesize === 'number' && data.filesize < MIN_PLAYABLE_FILE_BYTES) {
    throw new Error(`Resolved file too small (likely a takedown placeholder): ${data.filesize} bytes`);
  }
  return data.download;
}

export async function resolveStream(apiKey, infoHash, { season, episode } = {}, { fetchImpl = fetch } = {}) {
  const existing = await findExistingTorrent(apiKey, infoHash, fetchImpl);
  if (existing) {
    return unrestrictLink(apiKey, existing.links[0], fetchImpl);
  }

  const { id } = await addMagnet(apiKey, infoHash, fetchImpl);
  const info = await getTorrentInfo(apiKey, id, fetchImpl);
  const file = pickTorrentFile(info.files || [], { season, episode });
  if (!file) throw new Error(`No file found in torrent ${id} for ${infoHash}`);

  await selectFiles(apiKey, id, file.id, fetchImpl);
  const updatedInfo = await getTorrentInfo(apiKey, id, fetchImpl);
  const link = updatedInfo.links?.[0];
  if (!link) throw new Error(`No link produced for torrent ${id}`);

  return unrestrictLink(apiKey, link, fetchImpl);
}
