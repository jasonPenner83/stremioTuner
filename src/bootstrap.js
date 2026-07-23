import { getAuthKey, getInstalledAddons, findAddonById, invalidateAuthKey } from './stremioAccount.js';
import { resolveChannelSource } from './addonClient.js';
import { generateChannelSchedule } from './generateSchedule.js';
import { readSchedule, writeSchedule, isScheduleFresh } from './scheduleStore.js';
import { scheduleDailyAt } from './scheduling.js';
import { createApp } from './server/app.js';

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
  loadConfigImpl,
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
  sleepImpl
} = {}) {
  const dataDir = env.DATA_DIR || '/data';
  const configPath = env.CONFIG_PATH || `${dataDir}/config.yml`;
  const port = Number(env.PORT || 8080);
  const baseUrl = env.BASE_URL || `http://localhost:${port}`;
  const authCachePath = `${dataDir}/auth.json`;

  const config = await loadConfigImpl(configPath);

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

  const installedAddonsAtStartup = await discoverInstalledAddons();
  if (!installedAddonsAtStartup) {
    console.error('Continuing with cached schedules only.');
  }

  const channels = config.channels.map((channel) => ({
    ...channel,
    source: resolveSource(channel, installedAddonsAtStartup)
  }));

  async function regenerate(channel) {
    if (!channel.source) {
      console.error(`Skipping schedule regeneration for "${channel.name}": no resolved addon source`);
      return;
    }
    try {
      const schedule = await generateChannelScheduleImpl({ channel, source: channel.source });
      await writeScheduleImpl(dataDir, channel.id, schedule);
    } catch (err) {
      console.error(`Schedule generation failed for "${channel.name}": ${err.message}`);
    }
  }

  async function runStartupRegeneration() {
    for (const channel of channels) {
      const existing = await readScheduleImpl(dataDir, channel.id);
      if (!isScheduleFreshImpl(existing, config.refreshTime, new Date())) {
        await regenerate(channel);
      }
    }
  }

  async function runDailyRegeneration() {
    // Re-resolve any channel whose source is still null (e.g. because Stremio
    // login/addon discovery failed at startup or on a previous cron run) so a
    // transient outage doesn't permanently degrade the channel until a manual
    // restart.
    const channelsNeedingSource = channels.filter((channel) => !channel.source);
    if (channelsNeedingSource.length > 0) {
      const installedAddons = await discoverInstalledAddons();
      if (installedAddons) {
        for (const channel of channelsNeedingSource) {
          const source = resolveSource(channel, installedAddons);
          if (source) channel.source = source;
        }
      }
    }

    for (const channel of channels) {
      await regenerate(channel);
    }
  }

  scheduleDailyAtImpl(config.refreshTime, () => runDailyRegeneration());

  const app = createAppImpl({ channels, dataDir, baseUrl });
  const server = app.listen(port, () => console.log(`stremioTuner listening on port ${port}`));

  // Populate/refresh on-disk schedules in the background so the HTTP server
  // is reachable immediately, rather than blocking listen() behind
  // potentially long (or hung) per-channel metadata fetches.
  const startupRegenerationDone = runStartupRegeneration().catch((err) => {
    console.error(`Startup schedule regeneration failed: ${err.message}`);
  });

  return { app, channels, server, startupRegenerationDone };
}
