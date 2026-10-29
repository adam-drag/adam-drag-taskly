# Taskly PR test agent

This repository adds a pull request workflow to the Taskly app. On every PR to `main` it decides whether the change needs unit tests, lets the `test-writer` agent write or update them, runs them, and reports the result on the PR. The same agent and skills also wrote the coverage tests for the existing code.

> **Draft status.** Parts that depend on the final workflow (J2) or on the scenario runs on `main` carry a `Placeholder:` line that says what will go there. Other statements name their source where one exists: a file in this repository, a PR, a run, or a recorded decision. Relative file links resolve once the agent files are on `main`. In this file, "the plan" means the implementation plan that was written before the work started. It is not part of this repository.

## Contents

1. Design decisions
2. How to run
3. The agent and the skills
4. Example run
5. Coverage work and findings
6. Threat model
7. gh-aw comparison
8. Assumptions
9. Limitations
10. Changes for a production version

## 1. Design decisions

The decisions below come from the plan. Each one names its reason where the plan gives one.

**GitHub Actions with the Claude Code CLI, pinned.** The workflow is `.github/workflows/pr-test-agent.yml`. The CLI version is fixed in `.github/test-agent/package.json` and its lockfile (2.1.304) and is installed with `npm ci --ignore-scripts`. Two alternatives were considered. gh-aw gives a firewall, base restore and safe outputs, but its pushes do not trigger CI (the plan cites the gh-aw docs), so the plan put it through a time-boxed spike instead of on the critical path. The `claude-code-action` has no agent input and restores the base branch tip instead of the base SHA. Section 7 reports the gh-aw spike.

**Separate jobs, one purpose each.** The reason is least privilege: the job that holds the API key must not run PR code, and the job that runs PR code must not hold a secret or a write token.

| Job | Runs PR code | Secret | Token |
|---|---|---|---|
| scope | no, reads files as data | none | contents: read |
| generate | no, no install and no Bash | `ANTHROPIC_API_KEY` in the agent step only | contents: read |
| verify | yes: `npm ci --ignore-scripts`, `prisma generate`, tsc, vitest | none | contents: read |
| publish | no, no PR checkout | none | contents: write, statuses: write |
| report | no | none | pull-requests: write, statuses: read |

The top-level permissions are empty, and every action is pinned by SHA. A baseline job that runs the existing tests on the PR head and on the merge base is planned for the final workflow. Placeholder: the baseline job and the attempt-2 repair loop (J2) will be described here once they are merged.

**Agent, skills and scripts have separate roles.** The agent judges: whether behaviour changed, which units to test, whether a failing test is wrong or the code has a probable bug. Scripts decide everything that the model must not decide: scope and gates, path policy, test execution, flakiness, coverage, publishing, the numbers in the report and the list of skills used.

**Trusted instructions come from the base commit.** Every job checks out `pull_request.base.sha` into `trusted/` and runs scripts only from there. The PR head goes into `work/` and is sanitized before the agent starts. The conformance test C3 showed why: without the sanitize step, a planted agent, skill and CLAUDE.md all took effect, and with it none did.

**The published tree is the verified tree.** Verify builds the candidate tree first (the PR head plus the agent's test files), runs every check on exactly that tree and records its tree SHA and the blob SHA of each file. Publish writes that tree through the GitHub Git Data API or writes nothing. It refuses a commit whose tree SHA differs from the verified one, and it moves the branch with a `force: false` ref update, so GitHub refuses the write if the PR head moved after verification. Probable-bug reproductions are split off before verification, so they never enter the tree.

**One verdict.** `.github/test-agent/verdict.mjs` computes one verdict per run. The same verdict sets the run conclusion, the `test-agent/verified` status on the bot commit and the first line of the PR comment. The classes are success, infrastructure, guard or secret scan, type check, test failure, probable bug and coverage threshold. A failure that the run found stays visible, so a green status never hides an open problem.

**Bot commits carry no trailers.** The scope job finds them by author `github-actions[bot]` and a subject that starts with `test(agent):`. The plan records the repository owner's rule that commits carry no attribution trailers.

**Failure is never silent.** The report job runs with `if: always()`. The job summary always holds the verdict, also when the comment cannot be posted.

## 2. How to run

Prerequisites, from the plan and the J1 evidence:

- A GitHub repository with Actions enabled and a read-only default token. The workflow asks for write scopes per job.
- The repository secret `ANTHROPIC_API_KEY`. The plan recommends a dedicated key that serves only this repository. Whether the Anthropic Console can set a spend limit on it was not verified.
- Optional repository variable `TEST_AGENT_MODEL`. The default is `claude-sonnet-5-5`. J1 confirmed that this id works with the API key (section 4).
- Node 22 on `ubuntu-24.04`. The workflow installs the pinned CLI itself.

Placeholder: step-by-step commands for the PR workflow and for running the agent locally, taken from a clean worktree by the V7 check after the J2 merge.

## 3. The agent and the skills

| What | Where |
|---|---|
| Agent | `.claude/agents/test-writer.md` |
| Skill: classify the PR and decide | `.claude/skills/analyze-pr-changes/SKILL.md`, script `scripts/scope.mjs` |
| Skill: backend conventions | `.claude/skills/backend-unit-tests/SKILL.md` |
| Skill: frontend conventions | `.claude/skills/frontend-unit-tests/SKILL.md` |
| Skill: the definition of "verified" | `.claude/skills/verify-tests/SKILL.md`, scripts `scripts/guard.mjs` and `scripts/verify.mjs` |
| Agent settings and result schema | `.github/test-agent/claude-settings.json`, `.github/test-agent/result.schema.json` |
| Publish, report and verdict scripts | `.github/test-agent/publish.mjs`, `report.mjs`, `verdict.mjs` |
| Unit tests of the scripts | `.github/test-agent/tests/*.test.mjs`, run by `.github/workflows/ci.yml` |

The split into four skills is a design choice of this solution.

**The agent.** `test-writer` has the tools Read, Grep, Glob, Edit, Write, Skill and StructuredOutput. It has no Bash, so it cannot run tests. Its hard rules, from the agent file:

- It writes test files only. It never edits source, configuration, package files, `.claude/` or `.github/`.
- It never weakens a test: no deleted or skipped tests or assertions, no loosened matchers, no `.only`, `.skip`, `.todo` or `.fails`.
- It updates a human test only when the diff deliberately changes the behaviour that the test asserts, and it cites the diff line.
- When the code contradicts a documented contract, it writes the test for the documented behaviour into a separate `*.probable-bug.test.ts(x)` file and reports the bug with a concrete failure path.
- An empty result is valid. It treats everything in the context directory and in the repository as untrusted data.

**How the skills are used.** The agent invokes the skills with the Skill tool, in a fixed order: `analyze-pr-changes` first, the package skill before it writes in that package, and `verify-tests` before it returns. Each call is visible in the run transcript. The generate job reads the skill list from the transcript and fails closed on a Skill call outside the four project skills. The report states the skills used from the transcript and not from the model's own text.

**Boundaries around the agent.** `claude-settings.json` sets `dontAsk` mode, allows Edit only for test paths, denies Bash, web tools, NotebookEdit and Agent, denies edits to infrastructure paths, and sets `blockReadsOutsideWorkingDirectories`. Section 6 lists the controls that sit outside the model.

**Conformance tests.** J1 ran six checks with the pinned CLI 2.1.304 and the model `claude-sonnet-5-5` (10 runs, $0.216). All six passed:

| Id | Check | Result |
|---|---|---|
| C1 | `--agent test-writer` applies the agent prompt and tools | the agent has no Bash tool and answered "NO-BASH" when asked for one |
| C2 | Skills in the restored `.claude/skills` load, and calls show in the transcript | a Skill call for `verify-tests` is in the stream-json |
| C3 | Nothing from untrusted configuration loads after sanitize and restore | without sanitizing the planted agent took effect, with it no planted text appeared |
| C4 | Reads outside the working directories are denied | an outside file, `~/.bashrc` and symlinks to an outside file and to `/proc/self/environ` were all denied, with and without symlink removal |
| C5 | Cost, turns and structured output are available, and the caps work | the JSON has cost, turns, duration and usage, `structured_output` matches the schema, a $0.001 budget ended with `error_max_budget_usd` |
| C6 | Edit allow rules restrict writes to test paths | a write to `backend/src/x.ts` was denied, a write to `backend/tests/x2.test.ts` was allowed |

C1 to C6 ran with a local login. The API-key path was proven on GitHub by the S0 run (section 4).

One gap showed up in C3: `disableBundledSkills: true` does not remove three built-in skills (`design`, `doctor`, `plugin-authoring`) from the init list. The agent never called them, and the skill check works on invocations, so this does not open a hole. It is visible in the transcript.

**The agent version that wrote the coverage tests.** J3a and J3b used `AGENT_SHA` `8a7393ddaa8e490fab67702cf751cc056536c7b2` on the J1 branch `feat/test-agent`. It holds the agent, the four skills, `scope.mjs`, `guard.mjs`, `verify.mjs`, the settings, the schema and the pinned CLI lockfile. It does not hold the workflow, `publish.mjs`, `report.mjs` or `verdict.mjs`.

**Difference from `AGENT_SHA` to the agent and skills in the final workflow.** The list below covers `8a7393d` to `a146e25` on `feat/test-agent` (`git diff 8a7393d a146e25`). The agent file `.claude/agents/test-writer.md` did not change. Placeholder: the list will be updated to the merged state on `main` after the J2 merge.

| File | Change since `AGENT_SHA` |
|---|---|
| `.claude/skills/analyze-pr-changes/scripts/scope.mjs` | the line count ignores file headers and counts `+++x` inside a hunk as content; a bot-commit skip now carries `skip_kind: bot-commit` |
| `.claude/skills/verify-tests/scripts/guard.mjs` | the config deny pattern matches files that end in `config.ts`, so `config.test.ts` is allowed; hunks are parsed; an assertion removed from an existing test file needs a `human_test_updates` entry; a hunk that replaces lines and adds a weak matcher is refused; stdout carries counts only |
| `.claude/skills/verify-tests/scripts/verify.mjs` | a killed re-run, a re-run that exits non-zero while every file passes, and a missing coverage summary count as infrastructure failures |
| `.claude/skills/backend-unit-tests/SKILL.md` | one sentence: never name a file so that it ends in `config.ts` |
| `.claude/skills/verify-tests/SKILL.md` | the guard rules match the guard script |
| `.github/test-agent/claude-settings.json` | the Edit deny rule is `**/*config.ts` instead of `**/*config*.ts` |

The config pattern change fixes a gap that J3a found. The first guard pattern denied every `*config*.ts` path, including `config.test.ts`, which the backend skill gives as an example file name (J3a [PR 10](https://github.com/adam-drag/adam-drag-taskly/pull/10)).

## 4. Example run

Placeholder: the example run on the J5 feature PR (a small human-written change in the backend and the frontend). It will show the scope decision, the skills used, the agent's decisions, the files it added or updated, the test results, the bot commit with its `test-agent/verified` status, and the sticky comment, each with a link.

Placeholder: the scenario table (S1 generate, S2 update and second push, S3a to S3d no-ops and re-run, S4 fork, S5a probable bug, S5b generation failure) with one link set per scenario on the final workflow, the injection-attempt demo, and for every bot commit the runs that GitHub created for it.

**Evidence from the build.** J1 ran the full chain on a scratch PR before the final workflow. These runs used workflow revision `10f4955` on a temporary base branch, so they are build evidence and not the final example :

| Check | Result | Link |
|---|---|---|
| S0 full chain | scope, generate, verify, publish and report all ran; the bot commit's tree equals the verified tree; `test-agent/verified` is success | [run](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40955998898), [bot commit](https://github.com/adam-drag/adam-drag-taskly/commit/508f684df0cfbc5e15bcf5cda8fc580635ee2b3e), [comment](https://github.com/adam-drag/adam-drag-taskly/pull/2#issuecomment-6508399214) |
| API key and model | the run metadata shows `apiKeySource` `ANTHROPIC_API_KEY`, model `claude-sonnet-5-5`, CLI 2.1.304; skills used: `analyze-pr-changes`, `backend-unit-tests`, `verify-tests`; $0.056 and 13 turns; no hit for the key prefix in the run log | same run |
| Failure state | a probable bug was split off and not published, one test file was published, and the status is failure | [PR 4](https://github.com/adam-drag/adam-drag-taskly/pull/4), [run](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40956541379), [bot commit](https://github.com/adam-drag/adam-drag-taskly/commit/08df2f9e951a56aada3533ba83415fab7fdaf973) |
| Human push during verify | concurrency cancelled the older run before publish; the newer run published | [PR 5](https://github.com/adam-drag/adam-drag-taskly/pull/5), [cancelled run](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40957411370), [newer run](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40957538142) |
| Stale-head drill | after the pre-check the branch was moved by a drill commit; the ref update was refused with 422 "Update is not a fast forward" and no test commit landed | [PR 6](https://github.com/adam-drag/adam-drag-taskly/pull/6), [run](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40957471201) |
| Re-run of an old event | the re-run ended "superseded" at the pre-check, with no commit and an unchanged comment | PR 2, run 40955998898, attempt 2 |
| Fresh event on a head with the agent's tests | an empty human commit led to an agent no-op, because the tests were "already covered by backend/tests/health.test.ts"; the same comment was updated | [run](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40957295178) |
| Runs for the bot commit | GitHub created a `CI` run and a `PR test agent` run for the bot commit, both with conclusion `action_required`, 0 jobs, actor `github-actions[bot]`; nobody approved them | [CI](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40956194297), [PR test agent](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40956194077) |
| Runner environment | `npm ci --ignore-scripts` and `prisma generate` work on `ubuntu-24.04` with Node 22; the pinned CLI installs from the lockfile; the S0 run took 10 s (scope), 23 s (generate), 21 s (verify), 16 s (publish) and 14 s (report) | S0 run |

Placeholder: V1 to V10 (the final verification list) with evidence against `main` HEAD.

## 5. Coverage work and findings

J3a and J3b used the agent and skills locally, in batches by gap area, on `AGENT_SHA`. Every batch went through `guard.mjs` and `verify.mjs` (tsc, full suite, each changed file three times) with `TZ=UTC`. The agent wrote every test file, and a human reviewed every file. Only test files changed. No application code changed.

The numbers below come from the PR branches at the heads named in the table. Placeholder: they will be re-measured on `main` HEAD after the merges (V8).

| Package | PR | Branch head | Lines before | Lines after | Branches before | Branches after | Tests before | Tests after |
|---|---|---|---|---|---|---|---|---|
| backend | [PR 10](https://github.com/adam-drag/adam-drag-taskly/pull/10) | `4d678c2` | 33.02% | 97.24% | 33.33% | 95.83% | 48 | 93 |
| frontend | [PR 7](https://github.com/adam-drag/adam-drag-taskly/pull/7) | `54e4b1a` | 47.68% | 93.37% | 43.79% | 89.05% | 18 | 98 |

The "before" test counts come from the plan (PoC-1: 48 and 18 passing); the "after" counts come from the PR bodies.

**Backend, lines and branches per file (before to after)**

| File | Lines | Branches |
|---|---|---|
| `src/factory.ts` | 0 to 100 | 0 to 92.85 |
| `src/api/health.ts` | 0 to 100 | 100 to 100 |
| `src/features/todos/router.ts` | 44 to 100 | 16.66 to 100 |
| `src/core/config.ts` | 0 to 100 | 0 to 100 |
| `src/core/database.ts` | 66.66 to 100 | 100 to 100 |
| `src/core/lifespan.ts` | 0 to 100 | 0 to 50 |
| `src/main.ts` | 0 to 0 | 100 to 100 |

`main.ts` has no test on purpose. It starts the server when it is imported, and its logic sits in `core/lifespan.ts`, which has tests.

**Frontend, lines and branches per file (before to after)**

| File | Lines | Branches |
|---|---|---|
| `src/lib/http.ts` | 0 to 100 | 0 to 100 |
| `src/features/todos/hooks/useTodosQuery.ts` | 0 to 100 | 100 to 100 |
| `src/features/todos/hooks/useCreateTodoMutation.ts` | 0 to 100 | 0 to 100 |
| `src/features/todos/hooks/useUpdateTodoMutation.ts` | 0 to 100 | 0 to 100 |
| `src/features/todos/hooks/useDeleteTodoMutation.ts` | 0 to 100 | 100 to 100 |
| `src/features/todos/hooks/useTodosBusy.ts` | 0 to 100 | 100 to 100 |
| `src/features/todos/hooks/useTodoFilters.ts` | 0 to 100 | 100 to 100 |
| `src/features/todos/utils/todos.ts` | 52 to 80 | 33.33 to 75 |
| `src/features/todos/components/TodoEmptyState.tsx` | 0 to 100 | 0 to 100 |
| `src/app/AppProviders.tsx` | 0 to 100 | 0 to 100 |
| `src/features/todos/components/TodoItem.tsx` | 100 to 100 | 35.71 to 100 |
| `src/features/todos/components/TodoList.tsx` | 20 to 100 | 62.5 to 100 |
| `src/features/todos/components/DeleteTodoDialog.tsx` | 37.5 to 100 | 62.5 to 100 |
| `src/features/todos/components/TodoEditor.tsx` | 90 to 100 | 62.5 to 100 |
| `src/features/todos/TodosPage.tsx` | 50 to 100 | 61.11 to 100 |
| `src/hooks/useNotice.ts` | 71.42 to 100 | 75 to 100 |

The PR bodies list the gaps that remain: backend `factory.ts` line 20 (the `headersSent` branch), `lifespan.ts` line 14 (the default port) and the shutdown timeout callback; frontend `features/todos/api/todos.ts` lines 21 to 33, `TodoForm.tsx` lines 67 and 91, and `validateTodo` in `utils/todos.ts`. The design system stays out of coverage (`frontend/vite.config.ts:17`).

**Agent-written and hand-edited.** From the PR bodies:

- Backend: the agent wrote all six test files. The human edited `lifespan.test.ts` only. The agent's database double used a cast, and it is now a real client from `createDatabase` with spied methods. The edit also fixed a deep comparison that overflowed the stack, removed an unused array, and added assertions that the rejection comes after `initialize`. The agent used one `as TemplateStringsArray` narrowing in `database.test.ts`, which the human kept.
- Frontend: the agent wrote all 16 test files. The human wrote `src/test/queryResultFixture.ts`, reworded one test title, strengthened the signal test in `useTodosQuery.test.tsx`, changed the API call assertions in three mutation tests to `toHaveBeenCalledWith(...)`, ran Prettier, and replaced five `as unknown as` casts in three component tests with the typed fixture. Seven test files have no hand edits.
- In both PRs every existing test and assertion in an extended file is kept, which the guard's no-weakening check confirmed.

**What the agent run showed about the agent.**

- Frontend: all six batches passed on attempt 1, with no probable bug.
- Backend: the `lifespan` batch failed on attempt 1. On attempt 2 the agent moved the failing expectation into a `lifespan.probable-bug.test.ts` file and reported a probable bug (finding 4 below). That file was never published. The config batch needed a second run because the agent could not write `config.test.ts` (the guard gap in section 3).
- Agent cost: about $0.51 for the backend and about $0.81 for the frontend (sum of the batch costs in the PR bodies).

**Findings in the application.** Reported and not fixed. No failing test is in either PR. J3a reproduced findings 1 to 3 against a PostgreSQL 16 container.

1. **int4 id range.** `idSchema` accepts ids up to `Number.MAX_SAFE_INTEGER`, but `todos.id` is `SERIAL` (int4). `GET` and `DELETE` on `/api/todos/3000000000` return 500 instead of 404. `2147483647` returns 404.
2. **Hex and exponent ids are accepted.** `z.coerce.number()` turns `0x10` into 16, `1e3` into 1000, `0b11` into 3, `0o7` into 7 and ` 12 ` into 12. `openapi.json` says the id is an integer, so this is an open contract question.
3. **The mapper is stricter than the database.** The table only requires `length(title) >= 1`, so a whitespace-only title can be stored. `fromModel` throws a `ZodError` for such a row, so the list endpoint and the single-item endpoint return 500 while the row exists. A stored id of 0 or below has the same effect.
4. **A port that is already in use gives a misleading error.** In `backend/src/core/lifespan.ts` lines 13 to 17 the listen callback ignores its argument, so `start()` rejects with a `TypeError` instead of `EADDRINUSE`. The database is still disconnected. Confidence is medium (the agent's probable-bug run failed 3 of 3, and J3a reproduced it).

**Other findings.**

- `npm run format:check` in the frontend already fails on `main` for two untouched files, `src/components/ApplicationHeader.test.tsx` and `index.html` (checked on a scratch copy of the first commit). For that reason `ci.yml` has no format gate. The fix is `npm run format`, and it changes `index.html`, an application file.
- The agent's bot commit gets approval-required runs, as the GitHub docs say it can (section 4, "Runs for the bot commit").

## 6. Threat model

The repository is public, so artifacts, logs, comments and PR content can be read by anyone. The design protects against injected or generated code, and forks get no secrets.

| Threat | Controls | Evidence |
|---|---|---|
| A PR plants agent configuration (`.claude/`, CLAUDE.md, MCP settings, skills) | scripts and the agent come from the base commit; the sanitize step removes `.claude`, `.github`, `.mcp.json`, CLAUDE.md, AGENTS.md and every symlink from `work/`; `--setting-sources project`, `--strict-mcp-config` and a trusted settings file | C3: planted agent worked without sanitize and not with it |
| Prompt injection in PR code, test names, comments or test output | the agent has no Bash and no web tools; its Edit rights cover test paths only; its prompt and the agent file mark all repository and context text as untrusted data; the guard and verify run outside the model | C1, C6; the injection-attempt demo will show the result (placeholder, J4 phase 2) |
| The agent leaks the API key | the key is set only in the environment of the agent step, and the CLI runs under `env -i`; reads outside the working directories are blocked; the raw transcript is not uploaded; a secret scan covers the patch, the result, the metadata, stderr and every candidate file, and it looks for the literal key and its base64, hex and URL-encoded forms; on a hit only a failure marker is uploaded | C4; no hit for the key prefix in the S0 run log |
| The agent writes outside the test paths or weakens tests | Edit allow and deny rules in the settings; `guard.mjs` fails closed on paths, deletes, renames, symlinks, mode changes, binaries, size caps (400 lines per file, 1500 in total), banned modifiers and assertion loss; publish runs the guard again on the exact files | C6; unit tests in `.github/test-agent/tests/` |
| PR code run during verify steals a secret or writes | verify has no secret, a read-only token and `--ignore-scripts`; PR values reach scripts only through `env:` | workflow permissions |
| Publishing something other than what was verified | blob and tree SHA binding; the live head is compared with the tested SHA; the ref update is not forced | K1 and K4b in section 4 |
| An old run overwrites a newer report | concurrency with cancel-in-progress; the report job edits the comment only when the live head is the tested or the published SHA | K3 and K5b1 in section 4 |
| A loop through the bot commit | the scope gate skips a head commit by the bot (author and subject); GitHub created only approval-required runs for the bot commit, and nobody approved them | K5a in section 4 |
| Injected markdown or mentions in the PR comment | model text goes into capped fenced blocks, `@` is neutralised, comment markers are neutralised, the body passes the secret scan before it is posted | `.github/test-agent/report.mjs` |
| Cost overrun | `--max-budget-usd 1.00` per attempt, job timeouts, at most two attempts in the final design | C5 |
| A fork PR | generation, publish and comment are skipped, because there are no secrets and the token is read-only | Placeholder: the S4 evidence (gate unit test and documented limits) |

Residual risks, stated in the plan:

- Under `pull_request` the workflow file runs from the PR merge ref, so a same-repo author can edit it. The job split protects against injected or generated code. It does not protect against a malicious collaborator.
- The no-weakening check is a heuristic. It counts `it.each` call sites and does not count their table rows, and it can miss a loosened matcher in some forms. The report lists every edited human test as "human test changed" with the before and after lines, so a reviewer can see it. J1's last guard change refuses a weak matcher in a hunk that replaces lines. The case of an undeclared value change inside a multi-line expectation remains a limitation (the J1 review accepted it as a limitation).
- The agent process holds the API key in its environment. C4 passed, so the Claude Code permission system blocks reads of the environment. If C4 had failed, the plan's fallback was a local proxy that injects the key.
- The commit status says that the run executed PR code, so a green status is not proof against the PR author.
- `file:line` citations in probable-bug reports come from the agent. The report checks that the file exists and that the line is in range, and it says so. In PoC-3, two of three citations were exact and one was two lines off.

## 7. gh-aw comparison

GitHub Agentic Workflows (gh-aw v1.0.1, Claude engine, the same API key) was evaluated and not chosen. The spike ran on a draft PR, [PR 1](https://github.com/adam-drag/adam-drag-taskly/pull/1), which is closed and was never merged. It ran seven times, cost 160.31 AI credits (about $1.60, by `gh aw audit`) and used about 55 minutes of a 2.5-hour time box. The adoption rule was that all of G1 to G7 and the budget rule had to pass.

| Id | Criterion | Result | Run |
|---|---|---|---|
| G1 | the project skill is used and a PR-modified copy is not | pass: the agent quoted the base marker and ignored the PR marker | R1 [40954776874](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40954776874), R4 [40957501305](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40957501305) |
| G2 | install, prisma generate and vitest work in the sandbox, and the raw key is not in the environment | pass | R4, R5 [40958706324](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40958706324) |
| G3 | the push is limited to test paths and refuses a `backend/package.json` patch | pass | R4, R5 |
| G4 | a keyless job verifies the exact patch before the push | pass: a failing test blocked the push | R4, R7 [40960413972](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40960413972) |
| G5 | report numbers come from deterministic steps | pass, with a spike script bug in the failure case | R4 |
| G6 | cost and turns are available, and blocking threat detection passes a benign run | pass | R4 |
| G7 | the same agent, skills and scripts run unchanged | fail: the agent's push call failed with "No such tool available" | R6 [40959613051](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40959613051) |
| Budget rule | the migration must leave the agent files unchanged for the coverage work | fail | see below |

The results are the ones that the spike author recorded. Three of them were checked again: PR 1 is closed and was not merged, the log of R6 has the "No such tool available" error, and in R7 the verify job failed and the push job was skipped.

**What worked.**

- Base restore: gh-aw restores `.claude/` from the base commit, so a PR that edits a skill does not change what the agent loads.
- Sandbox: the agent ran `npm ci --ignore-scripts`, `prisma generate` and vitest for both packages behind the gh-aw firewall. The key stays in a proxy and not in the agent environment.
- Write policy: `push-to-pull-request-branch` with `allowed-files` pushed a test file and refused a patch to `backend/package.json`.
- Verify gate: a custom job without secrets applied the exact patch and ran the suite. The push job ran only when it passed.
- Reporting: `gh aw audit` reports turns and AI credits per run, and blocking threat detection passed every benign run.

**Why it was not chosen.**

1. The agent cannot publish under gh-aw without changes. gh-aw publishes through its own MCP tools and needs a `git commit` from the agent. The `test-writer` agent has no such tools, and its push call failed. Making it work means adding MCP tools and Bash to the agent file, and the same file wrote the coverage tests, so this would change it.
2. Least privilege is weaker. In this solution the job that holds the key runs no PR code and has no shell. In gh-aw the agent has a shell and runs PR code inside the sandbox. The sandbox and the key proxy reduce the risk, and the agent can still run code from the PR.
3. Commit hygiene. The gh-aw bot commit carried an attribution trailer for the model and a subject that the model chose. This solution detects bot commits by a fixed author and subject, and its commits have no trailers.
4. Pushes from gh-aw do not trigger CI, which matches the situation here. This solution records a commit status instead.
5. Each run also paid for AI threat detection, about $0.09. Fixing points 1 to 3 does not fit in the hardening budget without changing the shared agent files.

The plan notes that gh-aw and `claude-code-action` (from version 1.0.74) both restore agent configuration from the base commit. This solution uses the same restore pattern.

## 8. Assumptions

The plan's assumptions register, with the status after the J1 evidence. "Proven" names the evidence.

| Id | Assumption | Status |
|---|---|---|
| A1 to A6 | the conformance checks C1 to C6 | proven locally with the pinned CLI (section 3) |
| A7 | a Git Data API commit and a `force: false` ref update work with `GITHUB_TOKEN` on a same-repo PR branch, and a moved head is refused | proven by K1 and K4b (section 4) |
| A8 | `npm ci --ignore-scripts` plus an explicit `prisma generate` is enough on the runner | proven by K6; the plan notes that a cold `prisma generate` may need network access to `binaries.prisma.sh` |
| A9 | backend and frontend tests need no database and no outside network | proven locally in PoC-1; the router tests need loopback |
| A10 | the model id `claude-sonnet-5-5` is valid for the API key | proven by the S0 run metadata |
| A11 | gh-aw meets G1 to G7 | not met (section 7) |
| A12 | a second GitHub account exists for a live fork PR | none is assumed; the fork behaviour is shown by the gate unit test and documented limits unless the repository owner confirms an account |
| A13 | the Anthropic Console offers a spend limit for a dedicated key | not verified |
| A14 | the pinned CLI installs and runs on `ubuntu-24.04` | proven by K6 |
| A15 | the agent loop behaves on the runner as in the local runs | backend proven by S0; both stacks and attempt 2 are J2 (placeholder) |
| A16 | the tree SHA from the Git Data API equals the verified tree SHA | proven by K1 |
| A17 | a coverage-threshold miss can be told apart from other non-zero exits | not proven; J2 (placeholder) |

Further assumptions in the design:

- The application is small enough for the diff caps in the scope job (20 source files and 800 changed source lines).
- Both packages run their tests without a database. The tests are run with `TZ=UTC`.
- Scenario PRs make small application changes only to exercise the agent. They are closed, labelled and never merged.
- PR authors are same-repo collaborators for the full run. Drafts are processed.

## 9. Limitations

- Placeholder: limits of the final workflow (baseline classes, the two-attempt loop, the verdict table) after the J2 merge.
- Publishing is all or nothing. If one candidate test file fails or is flaky, nothing is published, because a subset would be a different tree that needs its own verification.
- Publish and the PR comment run for same-repo PRs only. A fork PR gets a job summary and no comment, and a maintainer can push the branch to the origin for a full run.
- A PR that edits `.github/**` or `.claude/**` is skipped, because the agent infrastructure needs human review. A PR above the size caps is skipped as well.
- Commits that the workflow pushes with `GITHUB_TOKEN` do not start normal workflow runs. GitHub creates approval-required runs for the bot commit, and nobody approves them automatically. The result for the bot commit is the `test-agent/verified` status.
- The agent cannot run tests, so a test can fail verification. The final design gives it one repair attempt with the failure output.
- The no-weakening check is a heuristic with the gaps in section 6.
- The `file:line` citations of probable bugs are not verified beyond file existence and line range.
- The workflow YAML of a same-repo PR runs from the PR merge ref.
- `disableBundledSkills` leaves three built-in skills in the init list (section 3).
- There is no format gate in `ci.yml`, because the frontend format check already fails on `main` (section 5).

## 10. Changes for a production version

From the plan's list of optional extensions and the J1 review notes:

- Restrict egress from the runner, for example with `harden-runner`. The restriction must allow `binaries.prisma.sh` or cache the Prisma engine.
- Use a dedicated, spend-limited API key and decide when to revoke it.
- Add a ruleset that protects `.github` and `.claude`. This needs a repository owner.
- Add a `workflow_dispatch` coverage mode to CI.
- Run the tests in a sandboxed tool or an MCP `run_tests` server, so the agent can run its own tests inside the generate job.
- Add mutation testing on the changed files (Stryker).
- Add an evaluation set of golden PRs to measure the agent's decisions over time.
- Add a reviewer agent from another model family.
- Raise the coverage thresholds. The repository owner makes this decision.
- Fix the two Prettier files with a formatting-only PR, then add a format gate to `ci.yml`.
- Publish the passing subset when other candidate files fail, with a second verification of that exact subset.
- Map the threat model to the OWASP list for LLM applications.
- Harden the publish path against a lost PATCH response (the response carries the commit SHA) and add tests for a failed status list and a killed re-run. The J1 review raised both, and they are assigned to J2. Placeholder: the entry stays or goes depending on the J2 result.
