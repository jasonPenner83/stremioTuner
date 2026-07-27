import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeMs } from '../src/runtimeParse.js';

test('parseRuntimeMs converts a "N min" string to milliseconds', () => {
  assert.equal(parseRuntimeMs('148 min'), 148 * 60 * 1000);
});

test('parseRuntimeMs extracts the leading number from other formats', () => {
  assert.equal(parseRuntimeMs('90'), 90 * 60 * 1000);
});

test('parseRuntimeMs returns null for empty/nullish input', () => {
  assert.equal(parseRuntimeMs(null), null);
  assert.equal(parseRuntimeMs(undefined), null);
  assert.equal(parseRuntimeMs(''), null);
});

test('parseRuntimeMs returns null when no digits are present', () => {
  assert.equal(parseRuntimeMs('unknown'), null);
});
