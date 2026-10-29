import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createHealthRouter } from '../src/api/health.ts';
import { createDatabase } from '../src/core/database.ts';
import { record } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  const app = express();
  app.use('/api', createHealthRouter(database));
  return { app, database };
}

it('answers the liveness check without touching the database', async () => {
  const { app, database } = setup();
  const findFirst = vi.spyOn(database.todo, 'findFirst').mockRejectedValue(new Error('Database unavailable'));

  const response = await request(app).get('/api/health/live');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'live' });
  expect(findFirst).not.toHaveBeenCalled();
});

it('keeps the health check querying the database', async () => {
  const { app, database } = setup();
  const findFirst = vi.spyOn(database.todo, 'findFirst').mockResolvedValue(record);

  const response = await request(app).get('/api/health');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
});
