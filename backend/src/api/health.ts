import { Router } from 'express';
import type { Database } from '../features/todos/types.js';

export function createHealthRouter(database: Database) {
  const router = Router();
  router.get('/health', async (req, res) => {
    await database.todo.findFirst({ select: { id: true } });
    res.json({ status: 'ok' });
  });
  router.get('/health/echo/:word', (req, res) => {
    res.json({ word: req.params.word });
  });
  router.get('/health/upper/:word', (req, res) => {
    res.json({ word: req.params.word.toUpperCase() });
  });
  return router;
}
