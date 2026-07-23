import express from 'express';
import { ValidationError, NotFoundError } from '../channelActions.js';

export function createAdminRouter(channelActions) {
  const router = express.Router();
  router.use(express.json());

  router.get('/catalogs', async (req, res) => {
    try {
      const result = await channelActions.listCatalogs();
      res.json(result);
    } catch (err) {
      console.error('Failed to list catalogs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/channels', async (req, res) => {
    try {
      const channels = await channelActions.listChannels();
      res.json(channels);
    } catch (err) {
      console.error('Failed to list channels:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/channels', async (req, res) => {
    try {
      const record = await channelActions.addChannel(req.body || {});
      res.status(201).json(record);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error('Failed to add channel:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/channels/:id', async (req, res) => {
    try {
      const updated = await channelActions.updateChannel(req.params.id, req.body || {});
      res.json(updated);
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error('Failed to update channel:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
