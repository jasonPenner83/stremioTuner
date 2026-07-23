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
