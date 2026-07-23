import { spawn } from 'node:child_process';

export function buildArgs(sourceUrl, offsetSeconds, mode) {
  const args = ['-ss', String(Math.max(0, Math.floor(offsetSeconds))), '-i', sourceUrl];
  if (mode === 'copy') {
    args.push('-c', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-c:a', 'aac');
  }
  args.push('-f', 'mpegts', 'pipe:1');
  return args;
}

export function streamViaFfmpeg({ sourceUrl, offsetSeconds, res, spawnImpl = spawn, ffmpegPath = 'ffmpeg', onLog = () => {} }) {
  return new Promise((resolve) => {
    let bytesSent = false;
    let currentChild = null;
    let clientDisconnected = false;

    function onResClose() {
      clientDisconnected = true;
      if (currentChild) currentChild.kill('SIGKILL');
    }

    res.on('close', onResClose);
    res.on('error', (err) => {
      onLog(`response write error: ${err.message}`);
    });

    function run(mode) {
      const child = spawnImpl(ffmpegPath, buildArgs(sourceUrl, offsetSeconds, mode));
      currentChild = child;
      let settled = false;

      child.stdout.on('data', () => {
        bytesSent = true;
      });
      child.stdout.pipe(res, { end: false });

      child.stderr.on('data', (chunk) => {
        onLog(chunk.toString());
      });

      function handleFailure(code) {
        // A single spawn failure can surface as both an 'error' and an
        // 'exit' event on the same child; only act on the first one.
        if (settled) return;
        settled = true;
        currentChild = null;
        if (!bytesSent && mode === 'copy' && !clientDisconnected) {
          run('transcode');
        } else {
          res.removeListener('close', onResClose);
          res.end();
          resolve();
        }
      }

      child.on('error', (err) => {
        onLog(`ffmpeg spawn error: ${err.message}`);
        handleFailure(null);
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          handleFailure(code);
          return;
        }
        if (settled) return;
        settled = true;
        currentChild = null;
        res.removeListener('close', onResClose);
        res.end();
        resolve();
      });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    run('copy');
  });
}
