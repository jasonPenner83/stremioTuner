import { channelId, validateNewChannelFields, validatePatchFields, readChannels, writeChannels } from './channelStore.js';

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export function createChannelActions({
  dataDir,
  channels,
  discoverInstalledAddons,
  resolveSourceImpl,
  regenerateImpl,
  readChannelsImpl = readChannels,
  writeChannelsImpl = writeChannels
}) {
  async function listCatalogs() {
    const installedAddons = await discoverInstalledAddons();
    if (!installedAddons) return { degraded: true, catalogs: [] };

    const persisted = await readChannelsImpl(dataDir);
    const byKey = new Map(persisted.map((ch) => [channelId(ch.addon, ch.catalog), ch.id]));

    const catalogs = installedAddons.flatMap((entry) => (entry.manifest.catalogs || []).map((catalog) => ({
      addon: entry.manifest.id,
      addonName: entry.manifest.name,
      catalog: catalog.id,
      catalogName: catalog.name,
      type: catalog.type,
      channelId: byKey.get(channelId(entry.manifest.id, catalog.id)) || null
    })));

    return { degraded: false, catalogs };
  }

  async function listChannels() {
    return readChannelsImpl(dataDir);
  }

  async function addChannel({ addon, catalog, name, mode, minQuality, language }) {
    try {
      validateNewChannelFields({ mode, minQuality, language });
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const persisted = await readChannelsImpl(dataDir);
    const id = channelId(addon, catalog);
    if (persisted.some((ch) => ch.id === id)) {
      throw new ValidationError(`Channel for addon "${addon}" / catalog "${catalog}" already exists`);
    }

    const installedAddons = await discoverInstalledAddons();
    const source = resolveSourceImpl({ addon, catalog, name }, installedAddons);
    if (!source) {
      throw new ValidationError(`Could not resolve addon "${addon}" / catalog "${catalog}" from your installed Stremio addons`);
    }

    const record = { id, addon, catalog, name, mode, minQuality, language, enabled: true };
    await writeChannelsImpl(dataDir, [...persisted, record]);

    const liveChannel = { ...record, source };
    channels.push(liveChannel);
    await regenerateImpl(liveChannel);

    return record;
  }

  async function updateChannel(id, patch) {
    const allowedPatch = {};
    for (const key of ['mode', 'minQuality', 'language', 'enabled']) {
      if (key in patch) allowedPatch[key] = patch[key];
    }

    try {
      validatePatchFields(allowedPatch);
      if (allowedPatch.enabled !== undefined && typeof allowedPatch.enabled !== 'boolean') {
        throw new Error(`Invalid enabled "${allowedPatch.enabled}" (must be a boolean)`);
      }
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const persisted = await readChannelsImpl(dataDir);
    const index = persisted.findIndex((ch) => ch.id === id);
    if (index === -1) {
      throw new NotFoundError(`No channel with id "${id}"`);
    }

    const updated = { ...persisted[index], ...allowedPatch };
    const nextPersisted = [...persisted];
    nextPersisted[index] = updated;
    await writeChannelsImpl(dataDir, nextPersisted);

    const liveIndex = channels.findIndex((ch) => ch.id === id);

    if (updated.enabled === false) {
      if (liveIndex !== -1) channels.splice(liveIndex, 1);
      return updated;
    }

    if (liveIndex === -1) {
      const installedAddons = await discoverInstalledAddons();
      const source = resolveSourceImpl(updated, installedAddons);
      const liveChannel = { ...updated, source };
      channels.push(liveChannel);
      await regenerateImpl(liveChannel);
    } else {
      Object.assign(channels[liveIndex], updated);
      await regenerateImpl(channels[liveIndex]);
    }

    return updated;
  }

  return { listCatalogs, listChannels, addChannel, updateChannel };
}
