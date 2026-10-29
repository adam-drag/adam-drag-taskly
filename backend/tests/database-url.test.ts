import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

import { resolveDatabaseUrl } from '../src/core/config.ts';

describe('resolveDatabaseUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('trims whitespace around an explicit override', () => {
    expect(resolveDatabaseUrl('  postgresql://u:p@localhost:5432/db \n')).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('trims whitespace around DATABASE_URL and rewrites the psycopg scheme', () => {
    vi.stubEnv('DATABASE_URL', ' postgresql+psycopg://u:p@localhost:5432/db\n');
    expect(resolveDatabaseUrl()).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('leaves a clean URL unchanged', () => {
    expect(resolveDatabaseUrl('postgresql://u:p@localhost:5432/db')).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('builds the URL from parts when no URL is given', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('POSTGRES_USER', 'user');
    vi.stubEnv('POSTGRES_PASSWORD', 'pass');
    vi.stubEnv('POSTGRES_HOST', 'dbhost');
    vi.stubEnv('DB_PORT', '5433');
    vi.stubEnv('POSTGRES_DB', 'taskly');
    expect(resolveDatabaseUrl()).toBe('postgresql://user:pass@dbhost:5433/taskly');
  });

  it('throws when a required variable is missing', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('POSTGRES_USER', '');
    expect(() => resolveDatabaseUrl()).toThrow('Missing environment variable: POSTGRES_USER');
  });
});
