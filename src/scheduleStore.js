import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { mostRecentBoundary } from './scheduling.js';

export function schedulePath(dataDir, channelId) {
  return path.join(dataDir, 'schedules', `${channelId}.json`);
}

export async function readSchedule(dataDir, channelId, { fs = fsPromises } = {}) {
  try {
    const raw = await fs.readFile(schedulePath(dataDir, channelId), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSchedule(dataDir, channelId, schedule, { fs = fsPromises } = {}) {
  const filePath = schedulePath(dataDir, channelId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(schedule, null, 2));
}

export function isScheduleFresh(schedule, refreshTime, now) {
  if (!schedule) return false;
  const boundary = mostRecentBoundary(refreshTime, now);
  return new Date(schedule.generatedAt).getTime() >= boundary.getTime();
}
