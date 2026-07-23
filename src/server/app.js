import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildM3u } from '../m3u.js';
import { buildXmltv } from '../xmltv.js';
import { readSchedule } from '../scheduleStore.js';
import { selectStream } from '../streamSelect.js';
import { fetchStreams } from '../addonClient.js';
import { streamViaFfmpeg } from './ffmpegProxy.js';
import { createAdminRouter } from './adminRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export function createApp({
  channels,
  dataDir,
  baseUrl,
  channelActions,
  fetchStreamsImpl = fetchStreams,
  streamViaFfmpegImpl = streamViaFfmpeg,
  nowImpl = () => new Date()
}) {
  const app = express();

  app.use(express.static(PUBLIC_DIR));

  if (channelActions) {
    app.use('/admin', createAdminRouter(channelActions));
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
      const streams = await fetchStreamsImpl(channel.source.transportUrl, channel.source.type, item.id);
      const selected = selectStream(streams, { minQuality: channel.minQuality, language: channel.language });
      if (!selected) {
        res.status(502).end('No playable stream found');
        return;
      }

      await streamViaFfmpegImpl({ sourceUrl: selected.url, offsetSeconds, res });
    } catch (err) {
      console.error('Failed to serve stream:', err);
      if (!res.headersSent) {
        res.status(500).end('Internal server error');
      }
    }
  });

  return app;
}
