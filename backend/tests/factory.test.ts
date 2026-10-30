import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createDatabase } from '../src/core/database.ts';
import { createApp } from '../src/factory.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  return { database, app: createApp(database) };
}

describe('createApp', () => {
  it('answers unknown routes with 404', async () => {
    const { app } = setup();
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: 'Not Found' });
  });

  it('answers malformed JSON with 422', async () => {
    const { app } = setup();
    const response = await request(app).post('/api/todos').set('Content-Type', 'application/json').send('{"title":');
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ detail: 'Invalid JSON.' });
  });

  it('answers a body above the JSON limit with 413', async () => {
    const { app } = setup();
    const response = await request(app).post('/api/todos').set('Content-Type', 'application/json').send(JSON.stringify({ title: 'a'.repeat(200 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ detail: 'Request body too large.' });
  });

  it('answers unexpected errors with 500 and logs them', async () => {
    const { app, database } = setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Database unavailable');
    vi.spyOn(database.todo, 'findMany').mockRejectedValue(failure);
    const response = await request(app).get('/api/todos');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ detail: 'Internal Server Error' });
    expect(log).toHaveBeenCalledWith(failure);
  });

  it('serves the OpenAPI document', async () => {
    const { app } = setup();
    const specification = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual(specification);
  });

  it('serves Swagger UI at /docs/', async () => {
    const { app } = setup();
    const response = await request(app).get('/docs/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('does not send x-powered-by', async () => {
    const { app } = setup();
    const response = await request(app).get('/nope');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
