---
name: verify-tests
description: The definition of "verified" for agent-written tests in this repo, and the checks the pipeline runs on your patch (guard.mjs, verify.mjs). Use before returning your result, to check your files against the bar.
---

# Verify tests

You cannot run anything. After you finish, the pipeline runs two scripts from this skill's `scripts/` folder (read them if you need exact rules). Your files are published only if they pass both.

## 1. Guard (`scripts/guard.mjs`), on your patch, fails closed

- Allowed paths only: `backend/tests/**/*.ts`, `frontend/src/**/*.test.ts(x)`, `frontend/src/test/*Fixture.ts`. Denied explicitly: `.github/**`, `.claude/**`, `package*.json`, lockfiles, `*config.ts` (config files such as `vitest.config.ts`; a test file such as `config.test.ts` is allowed), `prisma/**`, `frontend/src/test/setup.ts`, `design-system/mocks.tsx`.
- No deletes, renames, symlinks, mode changes or binary files.
- At most 400 added lines per file and 1500 in total.
- No `.only`, `.skip`, `.todo`, `.fails`, `skipIf`, `runIf`, `xit`, `fit`.
- **No weakening** in an existing (human) test file you edited: the number of test cases (`it(`, `test(`, `it.each`) and of `expect(` calls must not go down.
- In an existing test file that is not in `human_test_updates`, do not remove or change any line except: blank lines; an import line that you replace with an import from the same module that keeps every name; and a line of closing brackets that you add back unchanged (for example `});` moved below a new test). Any other removed or changed line, such as `age: 3,` inside a multi-line `toEqual`, an `it.each` row or a name inside a multi-line import, needs a `human_test_updates` entry. The existing lines must also keep their order: moving a closing bracket to another place inside an expectation is a change. If your edit removes or changes any line of an existing test file, do not add a weak matcher (`toBeDefined`, `toBeTruthy`, `toBeFalsy`, `toBeUndefined`, `expect.any`, `expect.anything`) anywhere in that file, also not in a new test. The guard refuses the whole file. Use exact matchers.
- A secret scan runs on the patch and on your result.

## 2. Verification (`scripts/verify.mjs`), keyless, per package

- Every check runs as a separate OS user without sudo, in a copy of the candidate tree. A test that changes a tracked file of that tree (a test file, a fixture, a src file) fails the whole run, so write temporary files only to a temp directory.
- `tsc --noEmit` for the package (tests are included in both tsconfigs). Any type error in your file fails it.
- The full suite with the JSON reporter, read per file.
- Each changed test file runs **3 times**. Only 3/3 counts as passing; 1/3 or 2/3 is "flaky". So no dependence on the current date, test order, real timers, randomness or the network.
- Coverage from `coverage-summary.json` with your patch, per touched src file (a missing summary is an infrastructure failure). The report compares it with the coverage of the PR head without your patch (from the baseline job).

- `*.probable-bug.test.ts(x)` files are split off **before** any check runs. The candidate tree is the PR head plus your other files; the checks run on exactly that tree, and `verify.json` records its tree id and each file's blob id. Probable-bug files run 3 times on their own, for evidence only, and are never published.

**Publish is all or nothing**: the candidate tree is published only if tsc passes, every candidate test file passes 3 of 3 runs, no test that passed on the PR head before your patch now fails (a test that already failed there stays open and is reported, but does not block; if you change a fixture, any failure blocks), the guard passes and every step wrote a valid report. One failing or flaky file means nothing is published. Publish refuses any file whose blob id differs from `verify.json`, and any tree whose id differs from the verified tree.

## Attempt 2 runs only when

- a changed test file (not a `.probable-bug.test.ts` you reported) fails, is flaky or does not typecheck; or
- a PR-induced failure from `pr-induced.md` still fails and you did not classify it as a probable bug.

It gets `feedback.md` with the assertion, the top stack frame and tsc errors per failing file, tsc errors in other files, and each PR-induced failure that is still open. There is no attempt 3, so get it right the first time.

## Checklist before you return

- [ ] Every new test fails if the PR's behaviour change were reverted (it pins the change, not just the old code).
- [ ] Imports match the package skill (`.ts` extension in backend tests; no extension in frontend tests; explicit `vitest` imports).
- [ ] Types: mock values match the real types; no new `as unknown as`.
- [ ] No `.only/.skip/.todo/.fails`; no removed tests or assertions; no loosened matchers.
- [ ] Each PR-induced failure is either updated under the rule (with the cited diff line) or reported as a probable bug.
- [ ] Probable-bug reproductions are in `*.probable-bug.test.ts` files and listed in `probable_bugs[].test_file`.
- [ ] The result lists exactly the files you wrote.
