import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase, initialize } from '../src/core/database.ts';

afterEach(() => vi.restoreAllMocks());

it('initialize creates the todos table with its constraints', async () => {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  const execute = vi.spyOn(database, '$executeRaw').mockResolvedValue(0);
  await initialize(database);
  expect(execute).toHaveBeenCalledTimes(1);
  const sql = (execute.mock.calls[0]![0] as TemplateStringsArray).join('');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS todos');
  expect(sql).toContain('id SERIAL PRIMARY KEY');
  expect(sql).toContain('todo_title_not_empty');
  expect(sql).toContain('todo_priority');
});

it('initialize propagates database errors', async () => {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  vi.spyOn(database, '$executeRaw').mockRejectedValue(new Error('Database unavailable'));
  await expect(initialize(database)).rejects.toThrow('Database unavailable');
});
