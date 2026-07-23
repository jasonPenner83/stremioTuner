import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRandomStartLineup, buildRandomLineup } from '../src/lineup.js';

const ITEMS = ['a', 'b', 'c', 'd'];

test('buildRandomStartLineup rotates the list starting at the rng-chosen index', () => {
  const rng = () => 0.5; // floor(0.5 * 4) = 2
  assert.deepEqual(buildRandomStartLineup(ITEMS, rng), ['c', 'd', 'a', 'b']);
});

test('buildRandomStartLineup with rng returning 0 keeps original order', () => {
  const rng = () => 0;
  assert.deepEqual(buildRandomStartLineup(ITEMS, rng), ['a', 'b', 'c', 'd']);
});

test('buildRandomStartLineup returns empty array for empty input', () => {
  assert.deepEqual(buildRandomStartLineup([], () => 0.5), []);
});

test('buildRandomLineup picks `count` items independently via rng, repeats allowed', () => {
  const values = [0, 0.9, 0.9, 0];
  let i = 0;
  const rng = () => values[i++];
  assert.deepEqual(buildRandomLineup(ITEMS, 4, rng), ['a', 'd', 'd', 'a']);
});

test('buildRandomLineup returns an array of the requested length', () => {
  const result = buildRandomLineup(ITEMS, 10, () => 0.1);
  assert.equal(result.length, 10);
});
