import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDatabase } from '../src/core/database.ts';
import { createHealthRouter } from '../src/api/health.ts';
import { record } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  const app = express();
  app.use('/api', createHealthRouter(database));
  return { app, database };
}

describe('health router', () => {
  it('reports ok when the database responds', async () => {
    const { app, database } = setup();
    const findFirst = vi.spyOn(database.todo, 'findFirst').mockResolvedValue(record);

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
  });

  it('reports 503 unavailable when the database query fails', async () => {
    const { app, database } = setup();
    vi.spyOn(database.todo, 'findFirst').mockRejectedValue(new Error('Database unavailable'));

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
  });
});
