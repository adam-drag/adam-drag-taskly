import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import dotenv from 'dotenv';

vi.mock('dotenv');

import { resolveDatabaseUrl } from '../src/core/config.ts';

const names = ['DATABASE_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_HOST', 'DB_PORT', 'POSTGRES_DB'];

function stubParts(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    DATABASE_URL: '',
    POSTGRES_USER: 'user',
    POSTGRES_PASSWORD: 'secret',
    POSTGRES_HOST: 'db.local',
    DB_PORT: '5432',
    POSTGRES_DB: 'taskly',
    ...overrides,
  };
  for (const name of names) vi.stubEnv(name, values[name]);
}

describe('resolveDatabaseUrl', () => {
  beforeEach(() => {
    for (const name of names) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads the .env file once with quiet output on import', () => {
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    const options = vi.mocked(dotenv.config).mock.calls[0][0];
    expect(options?.quiet).toBe(true);
    expect(options?.path).toMatch(/\.env$/);
  });

  it('prefers the explicit argument over DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://env:env@envhost:5432/env');
    expect(resolveDatabaseUrl('postgresql://arg:arg@arghost:5432/arg')).toBe('postgresql://arg:arg@arghost:5432/arg');
  });

  it('uses DATABASE_URL when there is no argument', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://env:env@envhost:5432/env');
    expect(resolveDatabaseUrl()).toBe('postgresql://env:env@envhost:5432/env');
  });

  it('rewrites the postgresql+psycopg prefix in the argument', () => {
    expect(resolveDatabaseUrl('postgresql+psycopg://u:p@h:5432/d')).toBe('postgresql://u:p@h:5432/d');
  });

  it('rewrites the postgresql+psycopg prefix in DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql+psycopg://u:p@h:5432/d');
    expect(resolveDatabaseUrl()).toBe('postgresql://u:p@h:5432/d');
  });

  it('builds the URL from the parts', () => {
    stubParts();
    expect(resolveDatabaseUrl()).toBe('postgresql://user:secret@db.local:5432/taskly');
  });

  it('percent-encodes user, password and database name', () => {
    stubParts({ POSTGRES_USER: 'a b@c', POSTGRES_PASSWORD: 'p@ss:w/rd #1', POSTGRES_DB: 'my db/#' });
    expect(resolveDatabaseUrl()).toBe('postgresql://a%20b%40c:p%40ss%3Aw%2Frd%20%231@db.local:5432/my%20db%2F%23');
  });

  it.each(['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_HOST', 'DB_PORT', 'POSTGRES_DB'])(
    'throws when %s is missing',
    (name) => {
      stubParts({ [name]: '' });
      expect(() => resolveDatabaseUrl()).toThrow(`Missing environment variable: ${name}`);
    },
  );
});
