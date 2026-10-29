---
name: backend-unit-tests
description: Conventions for writing Vitest + Supertest unit tests for the Taskly backend (Express 5, Prisma 7 with the pg adapter, Zod 4, TypeScript NodeNext strict). Use before writing or editing any file under backend/tests/.
---

# Backend unit tests (backend/)

## Where and how files are named

- Tests live flat in `backend/tests/`, one file per area: `validators.test.ts`, `mappers.test.ts`, `repository.test.ts`, `router.test.ts`. New areas get a new file with the same pattern, for example `tests/health.test.ts`, `tests/factory.test.ts`, `tests/environment.test.ts` (file names with `config` in them are denied by the guard).
- Vitest picks up `tests/**/*.test.ts` only (`backend/vitest.config.ts`). Environment `node`, no globals.
- Shared data: `tests/fixture.ts` exports `record` (a `TodoRecord`, Date objects, as Prisma returns it) and `todo` (the API JSON for the same row). Reuse them with spreads: `{ ...record, completed: true }`, `{ ...todo, completed: true }`.

## Imports (TypeScript NodeNext, `allowImportingTsExtensions`)

- Import test APIs explicitly: `import { describe, it, expect, vi, afterEach } from 'vitest';`
- Tests import src with the **`.ts`** extension: `import { createTodosRouter } from '../src/features/todos/router.ts';` and `import { record, todo } from './fixture.ts';`. (Src files import each other with `.js`; do not copy that into tests.)
- Types: `import type { TodoStore } from '../src/features/todos/types.ts';`
- Style: semicolons, single quotes, 2-space indent, long lines are accepted (the backend has no Prettier).

## Test style

- Mostly top-level `it(...)`; `describe` only to group one unit (validators use `describe('todo validation', ...)`).
- Titles state behaviour in the present tense: `'rejects invalid create input: %j'`, `'gets a task by ID and handles missing tasks'`.
- Input variants use `it.each([...])('... %s', ...)` or `%j` for objects.
- Assert exact values (`toBe`, `toEqual`, `toHaveBeenCalledWith`); check that collaborators are **not** called on rejected input (`expect(repository.create).not.toHaveBeenCalled()`).

## Patterns per layer

**Routers (HTTP)**: build a minimal app and a repository double that satisfies `TodoStore`:
```ts
function setup() {
  const repository = { list: vi.fn().mockResolvedValue([todo]), create: vi.fn().mockResolvedValue(todo), get: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodosRouter(repository));
  return { app, repository };
}
const response = await request(app).get('/api/todos');   // import request from 'supertest'
```
Check `response.status` and `response.body`, and what the repository received (`toHaveBeenCalledWith`). Query strings: `request(app).get('/api/todos').query({ completed: 'true' })` or put them in the URL.

**Whole app** (404 fallback, invalid JSON 422 `{ detail: 'Invalid JSON.' }`, 413 `{ detail: 'Request body too large.' }`, 500 `{ detail: 'Internal Server Error' }`, `/openapi.json`, `/docs`, `x-powered-by` absent): use `createApp(database)` from `../src/factory.ts`. Silence and assert the 500 log with `const error = vi.spyOn(console, 'error').mockImplementation(() => {});`.

**Anything that takes a `Database` (Prisma client)**: construct the real client without connecting and stub only the delegate method you need. No PostgreSQL and no network are available in tests.
```ts
import { createDatabase } from '../src/core/database.ts';
afterEach(() => vi.restoreAllMocks());
const database = createDatabase('postgresql://test:test@localhost:5432/test');
vi.spyOn(database.todo, 'findFirst').mockResolvedValue(record);        // success
vi.spyOn(database.todo, 'findFirst').mockRejectedValue(new Error('Database unavailable')); // failure
```
This keeps the types exact, so no `as` casts are needed. `createHealthRouter(database)` from `../src/api/health.ts` mounts `GET /health`; mount it like the app does: `app.use('/api', createHealthRouter(database))`.

**Repository**: `new TodoRepository(database)` with spies on `database.todo.findMany/findUnique/create/updateManyAndReturn/deleteMany`; assert the exact Prisma arguments (`orderBy: [{ created_at: 'desc' }, { id: 'desc' }]`, `where: { id }`) and the mapped result.

**Validators (Zod 4)**: accepted input `expect(schema.parse(input)).toEqual(expected)`; rejected input `expect(schema.safeParse(input).success).toBe(false)`; messages `expect(() => schema.parse(x)).toThrow('message text')`. `validators.ts` and `mappers.ts` need 100% statements, branches, functions and lines **per file**: cover every new branch.

**Config** (`src/core/config.ts` loads `../../../.env` at import time): `vi.mock('dotenv')` before importing, set variables with `vi.stubEnv('NAME', 'value')`, reset with `vi.unstubAllEnvs()` in `afterEach`.

## Error and response shapes (current code)

- Validation errors: 422 with `{ detail: <zod issues array> }`.
- Missing task: 404 `{ detail: 'Task not found.' }`; delete success: 204 with an empty body.
- Unknown route: 404 `{ detail: 'Not Found' }`.

## Type checking and running (the pipeline runs these, you cannot)

- `cd backend && npx tsc --noEmit` (strict; `tsconfig.json` includes `tests/**/*.ts`). Unused imports are fine, wrong types are not: mock return values must match Prisma types, so use `record`.
- `cd backend && npx vitest run --maxWorkers=4 tests/<file>.test.ts`; coverage with `npm run test:coverage`.
