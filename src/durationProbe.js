import { spawn } from 'node:child_process';

export function probeDurationMs(url, { spawnImpl = spawn, ffprobePath = 'ffprobe', timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url]);
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        resolve(null);
        return;
      }
      resolve(Math.round(seconds * 1000));
    });
  });
}
