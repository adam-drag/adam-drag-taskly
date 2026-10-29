import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

import { resolveDatabaseUrl } from '../src/core/config.ts';

afterEach(() => vi.unstubAllEnvs());

function stubParts() {
  vi.stubEnv('POSTGRES_USER', 'user');
  vi.stubEnv('POSTGRES_PASSWORD', 'pass');
  vi.stubEnv('POSTGRES_HOST', 'dbhost');
  vi.stubEnv('DB_PORT', '5433');
  vi.stubEnv('POSTGRES_DB', 'mydb');
}

describe('resolveDatabaseUrl', () => {
  it('trims whitespace around an explicit override', () => {
    expect(resolveDatabaseUrl('  postgresql://a:b@h:5432/d \n')).toBe('postgresql://a:b@h:5432/d');
  });

  it('trims whitespace around DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', '\t postgresql://a:b@h:5432/d  ');
    expect(resolveDatabaseUrl()).toBe('postgresql://a:b@h:5432/d');
  });

  it('rewrites the psycopg scheme after trimming', () => {
    expect(resolveDatabaseUrl('  postgresql+psycopg://a:b@h:5432/d ')).toBe('postgresql://a:b@h:5432/d');
  });

  it('returns an untrimmed-free explicit URL unchanged', () => {
    expect(resolveDatabaseUrl('postgresql://a:b@h:5432/d')).toBe('postgresql://a:b@h:5432/d');
  });

  it('falls back to the component variables when the explicit URL is blank', () => {
    stubParts();
    vi.stubEnv('DATABASE_URL', '   ');
    expect(resolveDatabaseUrl()).toBe('postgresql://user:pass@dbhost:5433/mydb');
  });

  it('throws for a missing component variable when no URL is set', () => {
    stubParts();
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('POSTGRES_HOST', '');
    expect(() => resolveDatabaseUrl()).toThrow('Missing environment variable: POSTGRES_HOST');
  });
});
