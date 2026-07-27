import { readSettings, writeSettings } from './settingsStore.js';
import { ValidationError } from './channelActions.js';

export function createSettingsActions({
  dataDir,
  settings,
  channels,
  discoverInstalledAddons,
  resolveStreamSourceImpl,
  readSettingsImpl = readSettings,
  writeSettingsImpl = writeSettings
}) {
  async function getSettings() {
    return readSettingsImpl(dataDir);
  }

  async function updateSettings(patch) {
    const allowed = {};
    if ('defaultStreamAddon' in patch) {
      const value = patch.defaultStreamAddon;
      if (value !== null && typeof value !== 'string') {
        throw new ValidationError(`Invalid defaultStreamAddon "${value}" (must be a string or null)`);
      }
      allowed.defaultStreamAddon = value || null;
    }

    const current = await readSettingsImpl(dataDir);
    const updated = { ...current, ...allowed };
    await writeSettingsImpl(dataDir, updated);
    Object.assign(settings, updated);

    if ('defaultStreamAddon' in allowed) {
      const installedAddons = await discoverInstalledAddons();
      for (const channel of channels) {
        if (!channel.streamAddon) {
          channel.streamSource = resolveStreamSourceImpl(channel, installedAddons);
        }
      }
    }

    return updated;
  }

  async function listAddons() {
    const installedAddons = await discoverInstalledAddons();
    if (!installedAddons) return { degraded: true, addons: [] };
    return {
      degraded: false,
      addons: installedAddons.map((entry) => ({ id: entry.manifest.id, name: entry.manifest.name }))
    };
  }

  return { getSettings, updateSettings, listAddons };
}
