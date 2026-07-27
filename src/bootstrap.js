import { readChannels, writeChannels } from './channelStore.js';
import { getAuthKey, getInstalledAddons, findAddonById, invalidateAuthKey } from './stremioAccount.js';
import { resolveChannelSource } from './addonClient.js';
import { generateChannelSchedule } from './generateSchedule.js';
import { readSchedule, writeSchedule, isScheduleFresh } from './scheduleStore.js';
import { scheduleDailyAt } from './scheduling.js';
import { createApp } from './server/app.js';
import { createChannelActions } from './channelActions.js';
import { readSettings, writeSettings } from './settingsStore.js';
import { createSettingsActions } from './settingsActions.js';

export async function withRetries(fn, { retries = 3, delayMs = 1000, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleepImpl(delayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function bootstrap({
  env = process.env,
  readChannelsImpl = readChannels,
  writeChannelsImpl = writeChannels,
  readSettingsImpl = readSettings,
  writeSettingsImpl = writeSettings,
  getAuthKeyImpl = getAuthKey,
  getInstalledAddonsImpl = getInstalledAddons,
  findAddonByIdImpl = findAddonById,
  invalidateAuthKeyImpl = invalidateAuthKey,
  resolveChannelSourceImpl = resolveChannelSource,
  generateChannelScheduleImpl = generateChannelSchedule,
  readScheduleImpl = readSchedule,
  writeScheduleImpl = writeSchedule,
  isScheduleFreshImpl = isScheduleFresh,
  scheduleDailyAtImpl = scheduleDailyAt,
  createAppImpl = createApp,
  createChannelActionsImpl = createChannelActions,
  createSettingsActionsImpl = createSettingsActions,
  sleepImpl
} = {}) {
  const dataDir = env.DATA_DIR || '/data';
  const refreshTime = env.REFRESH_TIME || '00:00';
  const port = Number(env.PORT || 8080);
  const baseUrl = env.BASE_URL || `http://localhost:${port}`;
  const authCachePath = `${dataDir}/auth.json`;

  const realDebridApiKey = env.REALDEBRID_API_KEY || null;
  if (!realDebridApiKey) {
    console.warn('REALDEBRID_API_KEY not set — magnet-only stream candidates will be ignored.');
  }

  const settings = await readSettingsImpl(dataDir);

  // Attempts to log in and fetch the installed addon list. On failure (after
  // retries), invalidates the cached auth key so a stale/expired key isn't
  // reused forever on subsequent attempts (startup or cron re-resolution).
  async function discoverInstalledAddons() {
    try {
      const authKey = await withRetries(() => getAuthKeyImpl({
        email: env.STREMIO_EMAIL,
        password: env.STREMIO_PASSWORD,
        cachePath: authCachePath
      }), { sleepImpl });
      return await withRetries(() => getInstalledAddonsImpl(authKey), { sleepImpl });
    } catch (err) {
      console.error(`Stremio login/addon discovery failed after retries: ${err.message}`);
      try {
        await invalidateAuthKeyImpl(authCachePath);
      } catch (invalidateErr) {
        console.error(`Failed to invalidate cached auth key: ${invalidateErr.message}`);
      }
      return null;
    }
  }

  function resolveSource(channel, installedAddons) {
    if (!installedAddons) return null;
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, channel.addon);
      return {
        transportUrl: addonEntry.transportUrl,
        ...resolveChannelSourceImpl(addonEntry.manifest, channel.catalog)
      };
    } catch (err) {
      console.error(`Could not resolve addon source for channel "${channel.name}": ${err.message}`);
      return null;
    }
  }

  function resolveStreamSource(channel, installedAddons) {
    const streamAddon = channel.streamAddon || settings.defaultStreamAddon;
    if (!streamAddon) return null;
    if (!installedAddons) return null;
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, streamAddon);
      return { transportUrl: addonEntry.transportUrl };
    } catch (err) {
      console.error(`Could not resolve stream addon for channel "${channel.name}": ${err.message}`);
      return null;
    }
  }

  async function regenerate(channel) {
    if (!channel.source) {
      channel.lastError = 'No resolved addon source';
      console.error(`Skipping schedule regeneration for "${channel.name}": no resolved addon source`);
      return;
    }
    try {
      const schedule = await generateChannelScheduleImpl({ channel, source: channel.source });
      await writeScheduleImpl(dataDir, channel.id, schedule);
      channel.lastError = null;
    } catch (err) {
      channel.lastError = err.message;
      console.error(`Schedule generation failed for "${channel.name}": ${err.message}`);
    }
  }

  const installedAddonsAtStartup = await discoverInstalledAddons();
  if (!installedAddonsAtStartup) {
    console.error('Continuing with cached schedules only.');
  }

  const persistedChannels = await readChannelsImpl(dataDir);
  const channels = persistedChannels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      ...channel,
      source: resolveSource(channel, installedAddonsAtStartup),
      streamSource: resolveStreamSource(channel, installedAddonsAtStartup)
    }));

  async function runStartupRegeneration() {
    for (const channel of channels) {
      const existing = await readScheduleImpl(dataDir, channel.id);
      if (!isScheduleFreshImpl(existing, refreshTime, new Date())) {
        await regenerate(channel);
      }
    }
  }

  async function runDailyRegeneration() {
    // Re-resolve any channel whose source is still null (e.g. because Stremio
    // login/addon discovery failed at startup or on a previous cron run) so a
    // transient outage doesn't permanently degrade the channel until a manual
    // restart.
    const channelsNeedingSource = channels.filter((channel) => !channel.source || ((channel.streamAddon || settings.defaultStreamAddon) && !channel.streamSource));
    if (channelsNeedingSource.length > 0) {
      const installedAddons = await discoverInstalledAddons();
      if (installedAddons) {
        for (const channel of channelsNeedingSource) {
          if (!channel.source) {
            const source = resolveSource(channel, installedAddons);
            if (source) channel.source = source;
          }
          if ((channel.streamAddon || settings.defaultStreamAddon) && !channel.streamSource) {
            const streamSource = resolveStreamSource(channel, installedAddons);
            if (streamSource) channel.streamSource = streamSource;
          }
        }
      }
    }

    for (const channel of channels) {
      await regenerate(channel);
    }
  }

  scheduleDailyAtImpl(refreshTime, () => runDailyRegeneration());

  const channelActions = createChannelActionsImpl({
    dataDir,
    channels,
    discoverInstalledAddons,
    resolveSourceImpl: resolveSource,
    resolveStreamSourceImpl: resolveStreamSource,
    regenerateImpl: regenerate,
    readChannelsImpl,
    writeChannelsImpl
  });

  const settingsActions = createSettingsActionsImpl({
    dataDir,
    settings,
    channels,
    discoverInstalledAddons,
    resolveStreamSourceImpl: resolveStreamSource,
    readSettingsImpl,
    writeSettingsImpl
  });

  const app = createAppImpl({ channels, dataDir, baseUrl, channelActions, settingsActions, realDebridApiKey });
  const server = app.listen(port, () => console.log(`stremioTuner listening on port ${port}`));

  // Populate/refresh on-disk schedules in the background so the HTTP server
  // is reachable immediately, rather than blocking listen() behind
  // potentially long (or hung) per-channel metadata fetches.
  const startupRegenerationDone = runStartupRegeneration().catch((err) => {
    console.error(`Startup schedule regeneration failed: ${err.message}`);
  });

  return { app, channels, server, startupRegenerationDone, channelActions, settingsActions };
}
