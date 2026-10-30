import { Router } from 'express';
import type { Database } from '../features/todos/types.js';

export function createHealthRouter(database: Database) {
  const router = Router();
  router.get('/health', async (req, res) => {
    await database.todo.findFirst({ select: { id: true } });
    res.json({ status: 'ok' });
  });
  // Liveness check: answers without touching the database.
  router.get('/health/live', (req, res) => {
    res.json({ status: 'live' });
  });
  return router;
}
