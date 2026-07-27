import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { probeDurationMs } from '../src/durationProbe.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = function kill(signal) {
    child.killed = true;
    child.killSignal = signal;
  };
  return child;
}

test('probeDurationMs parses seconds from ffprobe stdout into milliseconds', async () => {
  const child = fakeChild();
  let capturedArgs = null;
  const spawnImpl = (cmd, args) => { capturedArgs = args; return child; };

  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.stdout.write('5410.123000\n');
  child.emit('exit', 0);

  const result = await promise;
  assert.equal(result, 5410123);
  assert.deepEqual(capturedArgs, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'http://example/video.mkv']);
});

test('probeDurationMs returns null on a non-zero exit code', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.emit('exit', 1);
  assert.equal(await promise, null);
});

test('probeDurationMs returns null on unparseable stdout', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.stdout.write('N/A\n');
  child.emit('exit', 0);
  assert.equal(await promise, null);
});

test('probeDurationMs returns null and kills the child on a spawn error', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl });
  child.emit('error', new Error('ENOENT'));
  assert.equal(await promise, null);
});

test('probeDurationMs times out, kills the child, and resolves null', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = probeDurationMs('http://example/video.mkv', { spawnImpl, timeoutMs: 20 });
  const result = await promise;
  assert.equal(result, null);
  assert.equal(child.killed, true);
});
