import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../src/server/app.js';
import { writeSchedule, schedulePath } from '../src/scheduleStore.js';

async function withApp(t, { channels, schedules = {}, corruptSchedules = {}, fetchStreamsImpl, streamViaFfmpegImpl, nowImpl, channelActions } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stremiotuner-'));
  for (const [channelId, schedule] of Object.entries(schedules)) {
    await writeSchedule(dataDir, channelId, schedule);
  }
  for (const [channelId, rawContent] of Object.entries(corruptSchedules)) {
    const filePath = schedulePath(dataDir, channelId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, rawContent);
  }
  const app = createApp({
    channels,
    dataDir,
    baseUrl: 'http://localhost:0',
    fetchStreamsImpl,
    streamViaFfmpegImpl,
    nowImpl,
    channelActions
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

test('GET /epg.xml returns 500 without crashing when the schedule file is corrupted', async (t) => {
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X' }],
    corruptSchedules: { x: '{ this is not valid JSON' }
  });
  const res = await fetch(`${baseUrl}/epg.xml`);
  assert.equal(res.status, 500);
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

test('GET /stream/:channelId returns 500 without crashing when fetchStreamsImpl rejects', async (t) => {
  const now = new Date('2026-07-22T01:00:00.000Z');
  const schedule = { generatedAt: '2026-07-22T00:00:00.000Z', items: [{ id: 'tt1', title: 'Current', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:00:00.000Z' }] };
  const baseUrl = await withApp(t, {
    channels: [{ id: 'x', name: 'X', minQuality: '480p', language: 'en', source: { transportUrl: 'https://addon/manifest.json', type: 'movie' } }],
    schedules: { x: schedule },
    fetchStreamsImpl: async () => { throw new Error('addon endpoint unreachable'); },
    nowImpl: () => now
  });
  const res = await fetch(`${baseUrl}/stream/x`);
  assert.equal(res.status, 500);
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

test('GET / serves the static admin UI', async (t) => {
  const baseUrl = await withApp(t, { channels: [] });
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
});

test('admin routes are mounted and reachable when channelActions is provided', async (t) => {
  const baseUrl = await withApp(t, {
    channels: [],
    channelActions: { listChannels: async () => [{ id: 'x' }] }
  });
  const res = await fetch(`${baseUrl}/admin/channels`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, [{ id: 'x' }]);
});

test('admin routes 404 when channelActions is not provided', async (t) => {
  const baseUrl = await withApp(t, { channels: [] });
  const res = await fetch(`${baseUrl}/admin/channels`);
  assert.equal(res.status, 404);
});
