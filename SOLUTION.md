# Taskly PR test agent

This repository adds a PR workflow to the Taskly app. On every PR to `main` the workflow decides whether the change needs unit tests, lets the `test-writer` agent write or update them, runs them and reports. The same agent also wrote the coverage tests for the existing code.

Details: [SOLUTION_DETAILS.md](SOLUTION_DETAILS.md). Main pieces: the [workflow](.github/workflows/pr-test-agent.yml), the [agent](.claude/agents/test-writer.md), the [skills](.claude/skills), and the [scripts](.github/test-agent).

## Technical decisions

**GitHub Actions with a pinned Claude Code CLI.** The version is 2.1.304, fixed in the lockfile. The `claude-code-action` (from version 1.0.74) restores agent configuration from the base branch tip. This solution restores it from the base SHA of the event. I tested gh-aw v1.0.1 in a time-boxed spike. There the agent's push call failed with "No such tool available", because the setup publishes through gh-aw's own MCP tools. Making it work needs MCP tools and Bash in the agent file, and the same file wrote the coverage tests, so that change would alter the agent. I did not adopt it and tested no other gh-aw setup ([details](SOLUTION_DETAILS.md#7-gh-aw-comparison)).

**Separate jobs.** Only the generate jobs hold the API key, and they run no PR code. Baseline and verify run PR code as an unprivileged user with no secret and a read-only token. Publish holds the write token and no PR code ([details](SOLUTION_DETAILS.md#1-design-decisions)).

**Scripts from the base commit.** Every job runs scripts from the base SHA of the PR event, and the PR head is sanitized before the agent starts. In a test run without the sanitize step, an agent planted in the PR took effect. With the step, none did ([details](SOLUTION_DETAILS.md#3-the-agent-and-the-skills)).

**Two attempts.** Attempt 2 runs when the guard passes, verify finds no infrastructure problem, and it finds a failing or flaky test file, a failing type check or an open PR-induced failure. It starts from the attempt-1 patch and reads the verify feedback. Only the final verified tree is published.

**The published tree is the verified tree.** Publish writes the tree that verify recorded, through the Git Data API. It refuses a different tree and updates the branch without force, so GitHub refuses a moved head.

**Roles of the agent and the scripts.** The agent decides whether behaviour changed, what to test, and whether a failing test is wrong or the code has a probable bug. Scripts run the baseline, so the agent sees only PR-induced failures. They also handle scope, paths, test runs and publishing.

## How to run

Prerequisites: a GitHub repository with Actions enabled and a read-only default token, the secret `ANTHROPIC_API_KEY`, and a PR from the same repository. The workflow, agent, skills and scripts must be on `main`, because every job runs them from the base SHA. The workflow runs on `ubuntu-24.04` with Node 22.

```bash
gh secret set ANTHROPIC_API_KEY
git switch -c my-change main
# edit one file under backend/src or frontend/src and add no tests
git add <the edited file>
git commit -m "my change"
git push -u origin my-change
gh pr create --base main --draft --title "my change" --body "test"
gh pr checks
```

Read the PR comment headed `## Test agent report`. The bot commit with the test files carries the status `test-agent/verified`.

The local checks need no key. Their commands are in [details](SOLUTION_DETAILS.md#2-how-to-run).

## Agent and skills

The agent is `.claude/agents/test-writer.md`. Its four skills in `.claude/skills/` are `analyze-pr-changes`, `backend-unit-tests`, `frontend-unit-tests` and `verify-tests`. The coverage tests came from the agent at `8a7393ddaa8e490fab67702cf751cc056536c7b2`. The agent file has not changed since. Six other `.claude` files changed: three scripts, a new `sandbox.mjs` and two skill documents ([diff table](SOLUTION_DETAILS.md#3-the-agent-and-the-skills)).

**Instructed.** The agent file tells the agent to call `analyze-pr-changes` first, the package skill before it writes tests, and `verify-tests` before it returns. It also tells the agent to write test files only and keep every assertion. No script enforces the call order. The report warns when an attempt wrote tests without a stack skill call.

**Enforced.** The agent has no Bash tool. The settings allow Edit on test paths only. `guard.mjs` refuses other paths, deletes, `.only` and `.skip`, and any drop in the number of test cases or `expect(` calls in a file.

**Observed.** In the example run the agent called all four skills.

## Example run

[PR 30](https://github.com/adam-drag/adam-drag-taskly/pull/30) adds a `completed` filter to the todo API and a completed count to the page header, in 12 source files. Run [40997344886](https://github.com/adam-drag/adam-drag-taskly/actions/runs/40997344886).

- Baseline: frontend 89/98 on the head and 98/98 on the merge base. The 9 failing tests in `TodosPage.test.tsx` are PR-induced.
- Agent: attempt 1, 37 turns, 48 s, $0.1897. It decided `generate`, fixed those 9 tests, and changed 8 test files.
- Skills used: `analyze-pr-changes`, `backend-unit-tests`, `frontend-unit-tests` and `verify-tests`.
- Verify: type checks pass, backend 101/101, frontend 104/104.
- Publish: bot commit [`521193d`](https://github.com/adam-drag/adam-drag-taskly/commit/521193d510fc96a49da2f70bf9c09daa327a7de9), status success. Its tree equals the verified tree.

Other demo PRs cover no-ops, a probable bug, a failed generation and a prompt injection (the agent followed none of the injected instructions) ([details](SOLUTION_DETAILS.md#4-example-run-and-scenarios)).

## Coverage

Measured on `main` (`a20b82b`). The "before" values are from the first commit.

| Package | Lines before | Lines after | Branches before | Branches after | Tests |
|---|---|---|---|---|---|
| Backend | 33.02% | 97.24% | 33.33% | 95.83% | 48 to 93 |
| Frontend | 47.68% | 93.37% | 43.79% | 89.05% | 18 to 98 |

The agent wrote the coverage tests, except one frontend fixture. I reviewed every file. A few needed hand edits. Five application issues were reported, none fixed here ([details](SOLUTION_DETAILS.md#5-coverage-work-and-findings)).

## Assumptions

- The application is small enough for the diff caps (20 source files, 800 changed source lines).
- I did not verify that the Anthropic Console can set a spend limit on the key ([details](SOLUTION_DETAILS.md#8-assumptions)).

## Limitations

The most important limits come first ([all limits](SOLUTION_DETAILS.md#9-limitations)).

1. **A same-repo author can edit the workflow in the PR.** Under `pull_request` the workflow runs from the PR merge ref, so a malicious collaborator can change it. The job split covers injected or generated code only. A ruleset on `.github` closes this, and only the repository owner can set it ([threat model](SOLUTION_DETAILS.md#6-threat-model)).
2. **The verifier does not prove honest test tooling.** Vitest and its config come from the PR, so a PR can forge a clean report and a green status.
3. **Attempt 2 has no live run.** Two tries did not trigger it. Node tests cover the scripts, and nothing tests the attempt choice in the workflow.
4. **The guard refuses some legitimate edits.** It refuses an undeclared update of a test that the agent wrote earlier in the same PR, and an undeclared growth of a single-line import. Both stopped live runs. The weakening check is a heuristic and can miss a loosened matcher.
5. **Bot commits get no executed CI.** Commits pushed with `GITHUB_TOKEN` start no normal runs, so the `test-agent/verified` status holds the result.

## Changes for a production version

1. **Protect `.github` and `.claude` with a ruleset.** It closes limitation 1.
2. **Limit the key and the runner.** If the Console offers a spend limit, a dedicated key with one caps the cost. An egress restriction (for example `harden-runner`) limits which hosts the runner can reach.
3. **Fix the two guard refusals and run attempt 2 live.**
4. **Add an evaluation set of golden PRs.** It measures the agent's decisions over time ([details](SOLUTION_DETAILS.md#10-changes-for-a-production-version)).
