import { Router } from 'express';
import type { Database } from '../features/todos/types.js';

export function createHealthRouter(database: Database) {
  const router = Router();
  router.get('/health', async (req, res) => {
    await database.todo.findFirst({ select: { id: true } });
    res.json({ status: 'ok' });
  });
  router.get('/health/ping', (req, res) => {
    res.json({ pong: true });
  });
  router.get('/health/version', (req, res) => {
    res.json({ version: 1 });
  });
  router.get('/health/time', (req, res) => {
    res.json({ epoch: 0 });
  });
  return router;
}
