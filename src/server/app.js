import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildM3u } from '../m3u.js';
import { buildXmltv } from '../xmltv.js';
import { readSchedule } from '../scheduleStore.js';
import { fetchStreams } from '../addonClient.js';
import { streamViaFfmpeg } from './ffmpegProxy.js';
import { createAdminRouter } from './adminRoutes.js';
import { checkInstantAvailability, resolveStream } from '../realDebrid.js';
import { isLikelyPlayableSize } from '../streamSizeCheck.js';
import { resolvePlayableUrl } from '../resolvePlayableUrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export function createApp({
  channels,
  dataDir,
  baseUrl,
  channelActions,
  settingsActions,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  isLikelyPlayableSizeImpl = isLikelyPlayableSize,
  resolvePlayableUrlImpl = resolvePlayableUrl,
  realDebridApiKey = null,
  nowImpl = () => new Date()
}) {
  const app = express();

  app.use(express.static(PUBLIC_DIR));

  if (channelActions) {
    app.use('/admin', createAdminRouter(channelActions, settingsActions));
  }

  app.get('/playlist.m3u', (req, res) => {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(buildM3u(channels, baseUrl));
  });

  app.get('/epg.xml', async (req, res) => {
    try {
      const withSchedules = await Promise.all(channels.map(async (ch) => ({
        ...ch,
        schedule: await readSchedule(dataDir, ch.id)
      })));
      res.setHeader('Content-Type', 'application/xml');
      res.send(buildXmltv(withSchedules));
    } catch (err) {
      console.error('Failed to build EPG:', err);
      res.status(500).end('Internal server error');
    }
  });

  app.get('/stream/:channelId', async (req, res) => {
    try {
      const channel = channels.find((c) => c.id === req.params.channelId);
      if (!channel) {
        res.status(404).end('Unknown channel');
        return;
      }

      const schedule = await readSchedule(dataDir, channel.id);
      const now = nowImpl().getTime();
      const item = schedule?.items.find((i) => new Date(i.start).getTime() <= now && now < new Date(i.end).getTime());
      if (!item) {
        res.status(404).end('No program currently scheduled');
        return;
      }

      if (!channel.source) {
        res.status(502).end('Channel source unavailable (Stremio addon discovery failed)');
        return;
      }

      const offsetSeconds = (now - new Date(item.start).getTime()) / 1000;
      const streamSource = channel.streamSource || channel.source;
      const finalUrl = await resolvePlayableUrlImpl({
        item,
        type: channel.source.type,
        channel,
        streamSource,
        realDebridApiKey,
        fetchStreamsImpl,
        checkInstantAvailabilityImpl,
        resolveStreamImpl,
        isLikelyPlayableSizeImpl
      });

      if (!finalUrl) {
        res.status(502).end('No playable stream found');
        return;
      }

      await streamViaFfmpegImpl({ sourceUrl: finalUrl, offsetSeconds, res });
    } catch (err) {
      console.error('Failed to serve stream:', err);
      if (!res.headersSent) {
        res.status(500).end('Internal server error');
      }
    }
  });

  return app;
}
