import { loadConfig } from './config.js';
import { getAuthKey, getInstalledAddons, findAddonById } from './stremioAccount.js';
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
  loadConfigImpl = loadConfig,
  getAuthKeyImpl = getAuthKey,
  getInstalledAddonsImpl = getInstalledAddons,
  findAddonByIdImpl = findAddonById,
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

  const config = await loadConfigImpl(configPath);

  let installedAddons = null;
  try {
    const authKey = await withRetries(() => getAuthKeyImpl({
      email: env.STREMIO_EMAIL,
      password: env.STREMIO_PASSWORD,
      cachePath: `${dataDir}/auth.json`
    }), { sleepImpl });
    installedAddons = await getInstalledAddonsImpl(authKey);
  } catch (err) {
    console.error(`Stremio login/addon discovery failed after retries, continuing with cached schedules only: ${err.message}`);
  }

  const channels = config.channels.map((channel) => {
    if (!installedAddons) return { ...channel, source: null };
    try {
      const addonEntry = findAddonByIdImpl(installedAddons, channel.addon);
      const source = {
        transportUrl: addonEntry.transportUrl,
        ...resolveChannelSourceImpl(addonEntry.manifest, channel.catalog)
      };
      return { ...channel, source };
    } catch (err) {
      console.error(`Could not resolve addon source for channel "${channel.name}": ${err.message}`);
      return { ...channel, source: null };
    }
  });

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

  for (const channel of channels) {
    const existing = await readScheduleImpl(dataDir, channel.id);
    if (!isScheduleFreshImpl(existing, config.refreshTime, new Date())) {
      await regenerate(channel);
    }
  }

  scheduleDailyAtImpl(config.refreshTime, () => {
    channels.forEach(regenerate);
  });

  const app = createAppImpl({ channels, dataDir, baseUrl });
  const server = app.listen(port, () => console.log(`stremioTuner listening on port ${port}`));

  return { app, channels, server };
}
