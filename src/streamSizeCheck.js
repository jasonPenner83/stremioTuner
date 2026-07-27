export const MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024;

export async function isLikelyPlayableSize(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD' });
    if (!res.ok) return true;
    const contentLength = res.headers.get('content-length');
    if (contentLength === null) return true;
    const size = Number(contentLength);
    if (!Number.isFinite(size)) return true;
    return size >= MIN_PLAYABLE_FILE_BYTES;
  } catch {
    return true;
  }
}
