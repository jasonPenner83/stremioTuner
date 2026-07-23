import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildArgs, streamViaFfmpeg } from '../src/server/ffmpegProxy.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = function kill(signal) {
    child.killed = true;
    child.killSignal = signal;
  };
  return child;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.written = [];
  res.ended = false;
  res.writable = true;
  res.setHeader = function setHeader(name, value) { this.headers[name] = value; };
  res.write = function write(chunk) { this.written.push(chunk); return true; };
  res.end = function end() { this.ended = true; };
  return res;
}

test('buildArgs constructs copy args with the seek offset', () => {
  assert.deepEqual(
    buildArgs('http://x', 125.9, 'copy'),
    ['-ss', '125', '-i', 'http://x', '-c', 'copy', '-f', 'mpegts', 'pipe:1']
  );
});

test('buildArgs constructs transcode args', () => {
  assert.deepEqual(
    buildArgs('http://x', 0, 'transcode'),
    ['-ss', '0', '-i', 'http://x', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1']
  );
});

test('streamViaFfmpeg pipes copy-mode output straight through on success', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].stdout.write('chunk1');
  children[0].emit('exit', 0);
  await promise;

  assert.equal(children.length, 1);
  assert.deepEqual(res.written.map((c) => c.toString()), ['chunk1']);
  assert.equal(res.ended, true);
});

test('streamViaFfmpeg falls back to transcode when copy exits nonzero with no output', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].emit('exit', 1);
  await new Promise((r) => setImmediate(r));
  children[1].stdout.write('chunk-from-transcode');
  children[1].emit('exit', 0);
  await promise;

  assert.equal(children.length, 2);
  assert.deepEqual(res.written.map((c) => c.toString()), ['chunk-from-transcode']);
});

test('streamViaFfmpeg does not fall back once bytes have already been sent', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].stdout.write('partial-chunk');
  children[0].emit('exit', 1);
  await promise;

  assert.equal(children.length, 1);
  assert.deepEqual(res.written.map((c) => c.toString()), ['partial-chunk']);
});

test('streamViaFfmpeg kills the ffmpeg child when the response closes (client disconnect)', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  children[0].stdout.write('some-bytes');
  await new Promise((r) => setImmediate(r));

  assert.equal(children[0].killed, false);

  res.emit('close');

  assert.equal(children[0].killed, true);
  assert.equal(children[0].killSignal, 'SIGKILL');

  // Clean up: simulate the process actually exiting after being killed so the
  // in-flight promise settles and doesn't leak into other tests.
  children[0].emit('exit', null);
  await promise;
});

test('streamViaFfmpeg does not spawn a transcode fallback when the client disconnected before any bytes were sent in copy mode', async () => {
  const res = fakeRes();
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };

  const promise = streamViaFfmpeg({ sourceUrl: 'http://x', offsetSeconds: 10, res, spawnImpl });

  // Client disconnects while still seeking in copy mode, before any output bytes.
  res.emit('close');

  assert.equal(children[0].killed, true);
  assert.equal(children[0].killSignal, 'SIGKILL');

  // The kill causes the child to exit; since no bytes were sent and mode is
  // 'copy', this would normally trigger a transcode retry.
  children[0].emit('exit', null);
  await promise;

  assert.equal(children.length, 1);
  assert.equal(res.ended, true);
});
