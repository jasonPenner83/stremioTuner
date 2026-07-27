import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyPlayableSize, MIN_PLAYABLE_FILE_BYTES } from '../src/streamSizeCheck.js';

test('isLikelyPlayableSize returns false for a Content-Length below the threshold', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://example.com/video.mkv');
    assert.equal(opts.method, 'HEAD');
    return { ok: true, headers: { get: (name) => (name === 'content-length' ? '2097152' : null) } };
  };
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, false);
});

test('isLikelyPlayableSize returns true for a Content-Length at or above the threshold', async () => {
  const fetchImpl = async () => ({ ok: true, headers: { get: (name) => (name === 'content-length' ? String(MIN_PLAYABLE_FILE_BYTES) : null) } });
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) on a non-ok HEAD response', async () => {
  const fetchImpl = async () => ({ ok: false, headers: { get: () => null } });
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) when Content-Length is missing', async () => {
  const fetchImpl = async () => ({ ok: true, headers: { get: () => null } });
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) when the HEAD request throws', async () => {
  const fetchImpl = async () => { throw new Error('network error'); };
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl });
  assert.equal(result, true);
});

test('isLikelyPlayableSize fails open (true) when the HEAD request times out', async () => {
  let capturedSignal;
  const fetchImpl = (url, opts) => {
    capturedSignal = opts.signal;
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  const start = Date.now();
  const result = await isLikelyPlayableSize('https://example.com/video.mkv', { fetchImpl, timeoutMs: 10 });
  const elapsed = Date.now() - start;
  assert.ok(capturedSignal instanceof AbortSignal, 'expected an AbortSignal to be passed to fetchImpl');
  assert.equal(capturedSignal.aborted, true, 'expected the signal to have fired within the timeout');
  assert.equal(result, true);
  assert.ok(elapsed < 1000, `expected fast timeout, took ${elapsed}ms`);
});
