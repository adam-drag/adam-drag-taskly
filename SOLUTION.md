# Taskly PR test agent

This repository adds a pull request workflow to the Taskly app. On every PR to `main` the workflow decides whether the change needs unit tests, lets the `test-writer` agent write or update them, runs them, and reports the result on the PR. The same agent and skills also wrote the coverage tests for the existing code.

Evidence and implementation details are in [SOLUTION_DETAILS.md](SOLUTION_DETAILS.md). Main pieces: the [workflow](.github/workflows/pr-test-agent.yml), the [agent](.claude/agents/test-writer.md), the [skills](.claude/skills), the [scripts and their tests](.github/test-agent) and the example run [PR 30](https://github.com/adam-drag/adam-drag-taskly/pull/30).

## Design

**GitHub Actions with a pinned Claude Code CLI.** A lockfile fixes the CLI version (2.1.304). I tested gh-aw v1.0.1 in a time-boxed spike. In that setup the agent's push call failed with "No such tool available", because the setup publishes through gh-aw's own MCP tools. Making it work meant adding MCP tools and Bash to the agent file, which also wrote the coverage tests, so I did not adopt it. I did not test other gh-aw setups ([details](SOLUTION_DETAILS.md#7-gh-aw-comparison)).

**Separate jobs.** Only the generate jobs hold the API key, and they run no PR code. The baseline and verify jobs run PR code as an unprivileged user, with no secret and a read-only token. Publish holds the write token and checks out no PR code ([details](SOLUTION_DETAILS.md#1-design-decisions)).

**Scripts from the base commit.** Every job runs scripts from the base SHA of the PR event, and the PR head is sanitized before the agent starts.

**Baseline first.** Existing suites run on the merge base and the PR head, and only failures that the PR caused go to the agent.

**The published tree is the verified tree.** Verify records the SHA of the candidate tree. Publish writes that tree through the Git Data API, refuses a different tree, and updates the branch without force, so GitHub refuses the write when the head moved after verification.

**Roles of the agent and the scripts.** The agent decides whether behaviour changed, what to test, and whether a failing test is wrong or the code has a probable bug. Scripts handle scope, paths, test runs, coverage, publishing and the report numbers.

## How to run

Prerequisites: a GitHub repository with Actions enabled and a read-only default token, the secret `ANTHROPIC_API_KEY`, and a PR from the same repository. The optional variable `TEST_AGENT_MODEL` defaults to `claude-sonnet-5-5`. It runs on `ubuntu-24.04` with Node 22.

```bash
gh secret set ANTHROPIC_API_KEY
git switch -c my-change   # change a file under backend/src or frontend/src, add no tests
git push -u origin my-change
gh pr create --base main --draft --title "my change" --body "test"
gh pr checks
```

Read the PR comment headed `## Test agent report`. The bot commit with the test files carries the status `test-agent/verified`.

The local checks need no key, only Node 22.12 or later in the 22 line, or Node 24. The commands are in [details](SOLUTION_DETAILS.md#2-how-to-run).

## Agent and skills

The agent file is `.claude/agents/test-writer.md`. The four skills in `.claude/skills/` are `analyze-pr-changes`, `backend-unit-tests`, `frontend-unit-tests` and `verify-tests`. ([details](SOLUTION_DETAILS.md#3-the-agent-and-the-skills)).

**Instructed.** The agent file tells the agent to call `analyze-pr-changes` first, the package skill before it writes tests, and `verify-tests` before it returns. It also tells the agent to write test files only and to keep every assertion. No script enforces the call order. The report warns when an attempt wrote tests without a stack skill call.

**Enforced.** The agent has no Bash tool. The settings allow Edit on test paths only. `guard.mjs` refuses other paths, deletes, `.only` and `.skip`, and any drop in the number of test cases or `expect(` calls in a file. The generate job fails closed on a Skill call outside the four project skills.

**Observed.** In the example run the agent called all four skills.

## Example run

[PR 30](https://github.com/adam-drag/adam-drag-taskly/pull/30) adds a `completed` filter to the todo list API and a completed count in the page header, in 12 source files without tests. Run [40997344886](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40997344886).

- Baseline: frontend 89/98 on the head and 98/98 on the merge base. The 9 failing tests in `TodosPage.test.tsx` are PR-induced.
- Agent: attempt 1, 37 turns, 48 s, $0.1897. It decided `generate`, fixed those 9 tests, and wrote or updated 8 test files.
- Guard OK. Verify: type checks pass, backend 101/101, frontend 104/104.
- Publish: bot commit [`521193d`](https://github.com/adam-drag/adam-drag-taskly/commit/521193d510fc96a49da2f70bf9c09daa327a7de9), status success. Its tree equals the verified tree.

Its own CI is red before the agent commit, as expected. Other demo PRs cover no-ops, a probable bug, a failed generation and a prompt injection (the agent followed none of the injected instructions) ([details](SOLUTION_DETAILS.md#4-example-run-and-scenarios)).

## Coverage

Measured on `main` (`a20b82b`). The "before" values come from the first commit.

| Package | Lines before | Lines after | Branches before | Branches after | Tests |
|---|---|---|---|---|---|
| Backend | 33.02% | 97.24% | 33.33% | 95.83% | 48 to 93 |
| Frontend | 47.68% | 93.37% | 43.79% | 89.05% | 18 to 98 |

The agent wrote the coverage tests, except one frontend fixture that a human wrote. I reviewed every file, and a few needed hand edits. Five application issues were reported and none is fixed here ([details](SOLUTION_DETAILS.md#5-coverage-work-and-findings)).

## Limitations

The material ones, most important first ([all limits](SOLUTION_DETAILS.md#9-limitations)).

1. **A same-repo author can edit the workflow in the PR.** Under `pull_request` the workflow runs from the PR merge ref, so a malicious collaborator can change the workflow that checks the PR. The job split covers injected or generated code only. A ruleset on `.github` closes this, and only the repository owner can set it ([threat model](SOLUTION_DETAILS.md#6-threat-model)).
2. **The verifier does not prove honest test tooling.** Vitest and its config come from the PR, so a PR can forge a clean test report. A green status is no proof against the PR author.
3. **Attempt 2 has no live run.** Two tries did not trigger it. Node tests cover the loop.
4. **The guard refuses some legitimate edits.** It refuses an undeclared update of a test that the agent wrote earlier in the same PR, and an undeclared growth of a single-line import. Both stopped live runs with nothing published.
5. **The weakening check is a heuristic.** It can miss a loosened matcher. The report lists every edited human test.
6. **There is no live fork run.** I have no second account, so unit tests cover the fork gate.
7. **Bot commits get no executed CI.** Commits pushed with `GITHUB_TOKEN` start no normal runs, so the `test-agent/verified` status holds the result.

## Assumptions

- The application is small enough for the diff caps (20 source files, 800 changed source lines).
- PR authors are same-repo collaborators.
- I did not verify whether the Anthropic Console can set a spend limit on the key ([details](SOLUTION_DETAILS.md#8-assumptions)).

## Production priorities

1. **Protect `.github` and `.claude` with a ruleset.** The owner sets it, and it closes limitation 1.
2. **Limit the key and the runner.** Use a dedicated key with a spend limit, and restrict egress (for example with `harden-runner`). This limits spend and the hosts the runner can reach.
3. **Fix the two guard refusals and run attempt 2 live.** Both refusals blocked live runs.
4. **Add an evaluation set of golden PRs.** It measures the agent's decisions over time ([details](SOLUTION_DETAILS.md#10-changes-for-a-production-version)).
