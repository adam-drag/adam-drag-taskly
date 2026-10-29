import { Router } from 'express';
import type { Database } from '../features/todos/types.js';

export function createHealthRouter(database: Database) {
  const router = Router();
  router.get('/health', async (req, res) => {
    try {
      await database.todo.findFirst({ select: { id: true } });
    } catch {
      // Report the database outage instead of failing the request with a 500.
      res.status(503).json({ status: 'unavailable' });
      return;
    }
    res.json({ status: 'ok' });
  });
  return router;
}
