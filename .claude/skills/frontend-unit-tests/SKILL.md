---
name: frontend-unit-tests
description: Conventions for writing Vitest + React Testing Library tests for the Taskly frontend (React 19, TanStack Query 5, styled-components design system, jsdom). Use before writing or editing any frontend/src/**/*.test.ts(x) or frontend/src/test/*Fixture.ts file.
---

# Frontend unit tests (frontend/)

## Where and how files are named

- Tests sit next to the code: `TodoItem.tsx` -> `TodoItem.test.tsx`, `utils/todos.ts` -> `utils/todos.test.ts`, `hooks/useNotice.ts` -> `hooks/useNotice.test.ts`. Use `.tsx` only when the file contains JSX.
- When a test file for the unit already exists, **extend it** (add `it` blocks) instead of creating a second file.
- Shared data: `src/test/todoFixture.ts` exports `todoFixture` (a `Todo`). Override with spreads: `{ ...todoFixture, id: 8, priority: 'high' }`. New shared fixtures go in `src/test/<name>Fixture.ts`. Never edit `src/test/setup.ts` (it loads `@testing-library/jest-dom/vitest` and runs `cleanup` after each test).

## Imports and style

- Vitest globals are **not** enabled in `vite.config.ts`: import everything from `vitest` explicitly, e.g. `import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'`.
- RTL: `import { render, renderHook, screen, waitFor } from '@testing-library/react'`; user input: `import userEvent from '@testing-library/user-event'` and `const user = userEvent.setup()` at the start of each test.
- Import the unit with a relative path and no extension: `import { selectTodos } from './todos'`.
- Prettier (`.prettierrc.json`): no semicolons, single quotes, trailing commas, 80 columns, 2 spaces.
- Titles describe behaviour: `'rejects a whitespace-only title without submitting'`, `'sorts by priority without changing the source array'`. Top-level `it` or one `describe` per unit.

## Design system

Components import from `../../../design-system` (styled-components). Always replace it with the Vitest mocks, which render native elements and keep roles, labels and callbacks:
```ts
vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
```
Adjust the relative depth to the test file. In the mocks, `Alert` renders `data-testid="alert"`, `Drawer` renders `role="dialog"` with `aria-label={title}`, `Input`/`Select` render a labelled control, `Heading` renders `h<level>`. The mocked components are `vi.fn`s, so `vi.mocked(Alert).mock.calls[0][0]` exposes props (see `components/SuccessNotice.test.tsx`).

## Queries and assertions

- Prefer roles and labels: `screen.getByRole('button', { name: 'Save task' })`, `screen.getByRole('heading', { name: todoFixture.title })`, `screen.getByLabelText(/Task title/)`, `screen.getByRole('checkbox')`.
- jest-dom matchers: `toBeVisible`, `toHaveTextContent`, `toBeChecked`, `toBeDisabled`, `toBeInTheDocument`.
- Assert callbacks precisely: `toHaveBeenCalledWith({...})`, `toHaveBeenCalledTimes(1)`, `not.toHaveBeenCalled()`.

## Module mocks

- Mock a module with a factory and drive it with `vi.mocked`:
```ts
vi.mock('../../../lib/http', () => ({ request: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
vi.mocked(request).mockResolvedValue([todoFixture])
```
- Components that use hooks (`TodosPage`, `TodoEditor`, `DeleteTodoDialog`) are tested by mocking the hook modules. The existing tests cast partial hook results with `as unknown as ReturnType<...>`. Do **not** add new `as unknown as` casts: for new hook tests, render the real hook with a real `QueryClient` (below); for component tests, mock with fully typed values where you can.

## Hooks and TanStack Query

Use a fresh client per test, no retries, and a wrapper:
```tsx
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}
const { result } = renderHook(() => useTodosQuery(), { wrapper })
await waitFor(() => expect(result.current.isSuccess).toBe(true))
```
Mock the API module (`vi.mock('../api/todos', () => ({ todosApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } }))`), seed the cache with `queryClient.setQueryData(todoKeys.list, [todoFixture])`, and read it back with `queryClient.getQueryData(todoKeys.list)`. A hook file that uses JSX in the wrapper must be `.test.tsx`.

## Time, fetch and globals

- Dates: `vi.useFakeTimers()` and `vi.setSystemTime(new Date('2026-10-20T10:00:00'))`, restore with `vi.useRealTimers()` in `afterEach`. With userEvent and fake timers use `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`. `isOverdue` compares local calendar dates; `formatDate` uses `en-GB` (`'15 Oct 2026'`).
- `fetch` (for `lib/http.ts`): `vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 422 })))` and `vi.unstubAllGlobals()` in `afterEach`. `Response` exists in this jsdom environment.

## Coverage and running (the pipeline runs these, you cannot)

- Coverage excludes `src/design-system/**`, `src/main.tsx`, `src/test/**`, types, `index.ts`, constants, `api/queryKeys.ts`, `lib/queryClient.ts`.
- `cd frontend && npx tsc --noEmit` (strict, `src` included, so tests are type-checked) and `npx vitest run --maxWorkers=4 src/<path>.test.tsx`.
