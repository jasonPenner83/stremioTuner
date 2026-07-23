import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildArgs, streamViaFfmpeg } from '../src/server/ffmpegProxy.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function fakeRes() {
  return {
    headers: {},
    written: [],
    ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; }
  };
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
