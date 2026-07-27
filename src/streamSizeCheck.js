export const MIN_PLAYABLE_FILE_BYTES = 50 * 1024 * 1024;

export async function isLikelyPlayableSize(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
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
