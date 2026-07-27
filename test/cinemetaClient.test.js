import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImdbId, fetchCinemetaRuntimeMs } from '../src/cinemetaClient.js';

test('isImdbId matches tt-prefixed ids', () => {
  assert.equal(isImdbId('tt1234567'), true);
  assert.equal(isImdbId('tt1234567:1:2'), true);
});

test('isImdbId rejects non-tt ids', () => {
  assert.equal(isImdbId('some-addon-id-42'), false);
});

test('fetchCinemetaRuntimeMs returns null without fetching for a non-IMDb id', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const result = await fetchCinemetaRuntimeMs('movie', 'custom-id', { fetchImpl });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('fetchCinemetaRuntimeMs parses runtime from a successful response', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://v3-cinemeta.strem.io/meta/movie/tt1234567.json');
    return { ok: true, json: async () => ({ meta: { runtime: '120 min' } }) };
  };
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, 120 * 60 * 1000);
});

test('fetchCinemetaRuntimeMs returns null on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false });
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, null);
});

test('fetchCinemetaRuntimeMs returns null when meta has no runtime', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ meta: {} }) });
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, null);
});

test('fetchCinemetaRuntimeMs returns null on a network error', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const result = await fetchCinemetaRuntimeMs('movie', 'tt1234567', { fetchImpl });
  assert.equal(result, null);
});
