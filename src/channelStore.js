import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { QUALITY_ORDER, SUPPORTED_LANGUAGES } from './streamSelect.js';

const VALID_MODES = ['random', 'random-start'];

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

export function channelId(addon, catalog) {
  return slugify(`${addon}:${catalog}`);
}

export function channelsPath(dataDir) {
  return path.join(dataDir, 'channels.json');
}

export async function readChannels(dataDir, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(channelsPath(dataDir), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function writeChannels(dataDir, channels, { fs = fsPromises } = {}) {
  const filePath = channelsPath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(channels, null, 2));
}

export function validateNewChannelFields({ mode, minQuality, language }) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode "${mode}" (must be one of ${VALID_MODES.join(', ')})`);
  }
  if (!QUALITY_ORDER.includes(minQuality)) {
    throw new Error(`Invalid minQuality "${minQuality}" (must be one of ${QUALITY_ORDER.join(', ')})`);
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`Invalid language "${language}" (must be one of ${SUPPORTED_LANGUAGES.join(', ')})`);
  }
}

export function validatePatchFields(patch) {
  if (patch.mode !== undefined && !VALID_MODES.includes(patch.mode)) {
    throw new Error(`Invalid mode "${patch.mode}" (must be one of ${VALID_MODES.join(', ')})`);
  }
  if (patch.minQuality !== undefined && !QUALITY_ORDER.includes(patch.minQuality)) {
    throw new Error(`Invalid minQuality "${patch.minQuality}" (must be one of ${QUALITY_ORDER.join(', ')})`);
  }
  if (patch.language !== undefined && !SUPPORTED_LANGUAGES.includes(patch.language)) {
    throw new Error(`Invalid language "${patch.language}" (must be one of ${SUPPORTED_LANGUAGES.join(', ')})`);
  }
}
