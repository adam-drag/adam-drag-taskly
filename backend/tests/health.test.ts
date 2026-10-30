import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDatabase } from '../src/core/database.ts';
import { createHealthRouter } from '../src/api/health.ts';
import { createApp } from '../src/factory.ts';
import { record } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());

const database = createDatabase('postgresql://test:test@localhost:5432/test');

it('reports ok after querying the database', async () => {
  const findFirst = vi.spyOn(database.todo, 'findFirst').mockResolvedValue(record);
  const app = express();
  app.use('/api', createHealthRouter(database));
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
});

it('answers 500 when the database query fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure = new Error('Database unavailable');
  vi.spyOn(database.todo, 'findFirst').mockRejectedValue(failure);
  const response = await request(createApp(database)).get('/api/health');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ detail: 'Internal Server Error' });
  expect(log).toHaveBeenCalledWith(failure);
});

it('responds to the ping route without touching the database', async () => {
  const findFirst = vi.spyOn(database.todo, 'findFirst');
  const app = express();
  app.use('/api', createHealthRouter(database));
  const response = await request(app).get('/api/health/ping');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ pong: true });
  expect(findFirst).not.toHaveBeenCalled();
});

it('responds to the version route without touching the database', async () => {
  const findFirst = vi.spyOn(database.todo, 'findFirst');
  const app = express();
  app.use('/api', createHealthRouter(database));
  const response = await request(app).get('/api/health/version');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ version: 1 });
  expect(findFirst).not.toHaveBeenCalled();
});
