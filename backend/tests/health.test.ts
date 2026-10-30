import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/core/database.ts';
import { createHealthRouter } from '../src/api/health.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  const app = express();
  app.use('/api', createHealthRouter(database));
  return { app, database };
}

it('responds to the ping route without touching the database', async () => {
  const { app, database } = setup();
  const findFirst = vi.spyOn(database.todo, 'findFirst');

  const response = await request(app).get('/api/health/ping');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ pong: true });
  expect(findFirst).not.toHaveBeenCalled();
});

it('responds to the version route without touching the database', async () => {
  const { app, database } = setup();
  const findFirst = vi.spyOn(database.todo, 'findFirst');

  const response = await request(app).get('/api/health/version');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ version: 1 });
  expect(findFirst).not.toHaveBeenCalled();
});

it('keeps the health route checking the database', async () => {
  const { app, database } = setup();
  const findFirst = vi.spyOn(database.todo, 'findFirst').mockResolvedValue(null);

  const response = await request(app).get('/api/health');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
});
