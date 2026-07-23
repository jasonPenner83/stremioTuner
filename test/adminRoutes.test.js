import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter } from '../src/server/adminRoutes.js';
import { ValidationError, NotFoundError } from '../src/channelActions.js';

async function withRouter(t, channelActions) {
  const app = express();
  app.use('/admin', createAdminRouter(channelActions));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://localhost:${port}/admin`;
}

test('GET /admin/catalogs proxies to channelActions.listCatalogs', async (t) => {
  const baseUrl = await withRouter(t, {
    listCatalogs: async () => ({ degraded: false, catalogs: [{ addon: 'a', catalog: 'b' }] })
  });
  const res = await fetch(`${baseUrl}/catalogs`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { degraded: false, catalogs: [{ addon: 'a', catalog: 'b' }] });
});

test('GET /admin/channels proxies to channelActions.listChannels', async (t) => {
  const baseUrl = await withRouter(t, { listChannels: async () => [{ id: 'x' }] });
  const res = await fetch(`${baseUrl}/channels`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, [{ id: 'x' }]);
});

test('POST /admin/channels returns 201 with the created record', async (t) => {
  const baseUrl = await withRouter(t, {
    addChannel: async (input) => ({ id: 'new-id', ...input, enabled: true })
  });
  const res = await fetch(`${baseUrl}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addon: 'a', catalog: 'b', name: 'X', mode: 'random', minQuality: '720p', language: 'en' })
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.id, 'new-id');
});

test('POST /admin/channels returns 400 when channelActions throws ValidationError', async (t) => {
  const baseUrl = await withRouter(t, {
    addChannel: async () => { throw new ValidationError('bad input'); }
  });
  const res = await fetch(`${baseUrl}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, 'bad input');
});

test('POST /admin/channels returns 500 on an unexpected error', async (t) => {
  const baseUrl = await withRouter(t, {
    addChannel: async () => { throw new Error('disk exploded'); }
  });
  const res = await fetch(`${baseUrl}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 500);
});

test('PATCH /admin/channels/:id returns the updated record', async (t) => {
  const baseUrl = await withRouter(t, {
    updateChannel: async (id, patch) => ({ id, enabled: patch.enabled })
  });
  const res = await fetch(`${baseUrl}/channels/x`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { id: 'x', enabled: false });
});

test('PATCH /admin/channels/:id returns 404 when channelActions throws NotFoundError', async (t) => {
  const baseUrl = await withRouter(t, {
    updateChannel: async () => { throw new NotFoundError('no such channel'); }
  });
  const res = await fetch(`${baseUrl}/channels/unknown`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error, 'no such channel');
});
