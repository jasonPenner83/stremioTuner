import fsPromises from 'node:fs/promises';
import yaml from 'js-yaml';

const VALID_MODES = ['random', 'random-start'];
const REQUIRED_FIELDS = ['name', 'addon', 'catalog', 'mode', 'minQuality', 'language'];

export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

export function validateChannel(raw) {
  for (const field of REQUIRED_FIELDS) {
    if (!raw[field]) {
      throw new Error(`Channel missing required field "${field}": ${JSON.stringify(raw)}`);
    }
  }
  if (!VALID_MODES.includes(raw.mode)) {
    throw new Error(`Channel "${raw.name}" has invalid mode "${raw.mode}" (must be one of ${VALID_MODES.join(', ')})`);
  }
  return {
    id: slugify(raw.name),
    name: raw.name,
    addon: raw.addon,
    catalog: raw.catalog,
    mode: raw.mode,
    minQuality: raw.minQuality,
    language: raw.language
  };
}

export function parseConfig(raw) {
  if (!raw.refreshTime || !/^\d{2}:\d{2}$/.test(raw.refreshTime)) {
    throw new Error(`Invalid or missing refreshTime (expected "HH:MM"): ${raw.refreshTime}`);
  }
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new Error('Config must define at least one channel');
  }
  return {
    refreshTime: raw.refreshTime,
    channels: raw.channels.map(validateChannel)
  };
}

export async function loadConfig(configPath, { fs = fsPromises } = {}) {
  const raw = yaml.load(await fs.readFile(configPath, 'utf-8'));
  return parseConfig(raw);
}
