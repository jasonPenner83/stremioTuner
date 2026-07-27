import path from 'node:path';
import fsPromises from 'node:fs/promises';

export function durationCachePath(dataDir) {
  return path.join(dataDir, 'runtimeCache.json');
}

export async function readDurationCache(dataDir, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(durationCachePath(dataDir), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeDurationCache(dataDir, cache, { fs = fsPromises } = {}) {
  const filePath = durationCachePath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2));
}
