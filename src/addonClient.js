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
