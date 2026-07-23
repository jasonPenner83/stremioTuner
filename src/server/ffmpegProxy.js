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

    function run(mode) {
      const child = spawnImpl(ffmpegPath, buildArgs(sourceUrl, offsetSeconds, mode));

      child.stdout.on('data', (chunk) => {
        bytesSent = true;
        // Buffers round-trip losslessly through 'latin1' (unlike the default
        // utf8 decoding, which would corrupt arbitrary binary MPEG-TS bytes).
        // Passing the matching encoding to res.write() reproduces the exact
        // original bytes on the wire.
        res.write(chunk.toString('latin1'), 'latin1');
      });

      child.stderr.on('data', (chunk) => {
        onLog(chunk.toString());
      });

      child.on('error', (err) => {
        onLog(`ffmpeg spawn error: ${err.message}`);
        if (!bytesSent && mode === 'copy') {
          run('transcode');
        } else {
          res.end();
          resolve();
        }
      });

      child.on('exit', (code) => {
        if (code !== 0 && !bytesSent && mode === 'copy') {
          run('transcode');
        } else {
          res.end();
          resolve();
        }
      });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    run('copy');
  });
}
