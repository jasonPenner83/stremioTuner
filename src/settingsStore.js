import path from 'node:path';
import fsPromises from 'node:fs/promises';

export function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json');
}

export async function readSettings(dataDir, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(settingsPath(dataDir), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeSettings(dataDir, settings, { fs = fsPromises } = {}) {
  const filePath = settingsPath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2));
}
