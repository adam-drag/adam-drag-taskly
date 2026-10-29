---
name: analyze-pr-changes
description: Classify every file a PR changes in the Taskly repo (behaviour, refactor, non-functional, test-only, docs/config), map changed src files to existing tests and documented contracts, and decide per file whether to add tests, update tests, report a probable bug, or do nothing. Use first in every test-writer run.
---

# Analyze PR changes

`scope.json` in the context directory was produced by `scripts/scope.mjs` (this skill's folder). The same script runs in the scope job before you start, so its gates are already applied: if you are running, `decision` is `generate`. Read the script only if you need the exact rules.

## Steps

1. Read `scope.json`, then `pr.diff`, then `pr-induced.md`.
2. For each changed file, read the **whole** head version in the working directory, not only the hunk. Classify it:
   - **behaviour**: an output, status code, message, validation rule, filter, sort, side effect or error path changes for some input;
   - **refactor**: same observable behaviour, different code (renames, extraction, reordering). Existing tests that still pass cover it: no new tests;
   - **non-functional**: types only, comments, formatting, logging text nobody asserts. No tests;
   - **test-only / docs / config**: no tests (`kind` in scope.json: `backend-test`, `frontend-test`, `docs`, `config`).
3. For each behaviour change, list the inputs whose result changed. That list is what your tests must pin: at least the changed case, the boundary, and the unchanged neighbour case.
4. Find the existing tests. `existing_tests` in scope.json lists test files that import the src file. Also Grep for the function or route name in `backend/tests/` and `frontend/src/**/*.test.*`, and check tests of callers (for example `router.test.ts` exercises validators through HTTP).
5. Find the **documented contract** for the changed code, in this order, and quote it with `file:line`:
   - JSDoc and comments in the changed file and in the types it implements (`backend/src/features/todos/types.ts` holds `TodoStore`);
   - `backend/openapi.json` (status codes, parameters, response shapes; served at `/openapi.json` and `/docs`);
   - the database schema: `backend/prisma/schema.prisma` and the `CREATE TABLE` in `backend/src/core/database.ts` (column lengths, CHECK constraints);
   - user-facing copy that restates a rule, for example the 422 message in `frontend/src/lib/http.ts`;
   - `README.md`.
   If the head code contradicts its contract, that is a probable bug, not a test to adjust.
6. Decide per file: `add` (new tests), `extend` (add cases to an existing test file), `update` (a human expectation, only under the rule below), `probable-bug`, or `none` with the reason.

## PR-induced failures (from `pr-induced.md`)

Each entry is a human test that fails on the PR head and passes on the merge base. For each one:
- if the diff deliberately changes exactly what the test asserts (same message, rule or value, changed on purpose in the diff), update the expected value to the new behaviour, cite the head diff line, and keep every case and assertion;
- if the change looks accidental, or the old expectation matches a documented contract that the PR did not change, keep the test and report a probable bug;
- report every entry in `pr_induced_failures` with its `test_id` copied exactly.

## Coverage configuration (know it, do not chase it)

- Backend (`backend/vitest.config.ts`): coverage includes `src/**/*.ts`, excludes `src/**/types.ts` and `src/generated/**`. `src/features/todos/validators.ts` and `mappers.ts` have **per-file 100%** thresholds (statements, branches, functions, lines): a behaviour change there needs every new branch covered.
- Frontend (`frontend/vite.config.ts`): excludes `src/main.tsx`, `src/test/**`, test files, `src/design-system/**`, `types.ts`, `*.types.ts`, `index.ts`, constants, `features/todos/api/queryKeys.ts`, `lib/queryClient.ts`. The design system is excluded from coverage, but test it if the PR changed its behaviour.
- A coverage-threshold miss is reported, not treated as a test failure.

## Output of this step

A short plan in your own reasoning: per changed file, its class, the changed inputs, the contract you found (`file:line`) and the action. Then continue with the package skill.
