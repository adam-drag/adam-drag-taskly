---
description: J1b spike. Evaluates gh-aw v1.0.1 for the PR test agent. Never merged.
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [spike/gh-aw-base]
permissions:
  contents: read
  pull-requests: read
engine:
  id: claude
  model: claude-sonnet-5-5
max-turns: 40
timeout-minutes: 20
network:
  allowed:
    - defaults
    - node
tools:
  edit:
  bash:
    - "cd:*"
    - "ls:*"
    - "cat:*"
    - "wc:*"
    - "head:*"
    - "env:*"
    - "cut:*"
    - "git status:*"
    - "git diff:*"
    - "git log:*"
    - "npm ci:*"
    - "npx prisma generate:*"
    - "npx vitest:*"
    - "npx tsc:*"
    - "tail:*"
    - "sort:*"
    - "grep:*"
safe-outputs:
  push-to-pull-request-branch:
    allowed-files:
      - "backend/tests/**/*.test.ts"
      - "frontend/src/**/*.test.ts"
      - "frontend/src/**/*.test.tsx"
    signed-commits: false
    fallback-as-pull-request: false
    if-no-changes: "warn"
  threat-detection:
    continue-on-error: false
jobs:
  safe_outputs:
    needs: [verify]
    if: needs.verify.result == 'success'
  verify:
    needs: [agent, detection]
    runs-on: ubuntu-24.04
    timeout-minutes: 12
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: actions/download-artifact@v8
        with:
          name: agent
          path: /tmp/agent-artifact
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Apply the exact agent patch and run the backend suite (no secrets)
        id: run
        run: |
          set -uo pipefail
          ls -la /tmp/agent-artifact || true
          shopt -s nullglob
          patches=(/tmp/agent-artifact/aw-*.patch)
          echo "patches=${#patches[@]}" >> "$GITHUB_OUTPUT"
          for p in "${patches[@]}"; do
            echo "::group::patch $p"; cat "$p"; echo "::endgroup::"
            git apply --index "$p" || { echo "verdict=patch-apply-failed" >> "$GITHUB_OUTPUT"; exit 1; }
          done
          git diff --cached --name-status | tee /tmp/changed.txt
          sha256sum "${patches[@]}" | tee /tmp/patch-sha.txt
          cd backend
          npm ci --ignore-scripts && npx prisma generate || { echo "verdict=install-failed" >> "$GITHUB_OUTPUT"; exit 1; }
          npx vitest run --reporter=json --outputFile=/tmp/vitest.json; rc=$?
          node -e 'const r=require("/tmp/vitest.json");console.log(`files=${r.testResults.length}`);console.log(`passed=${r.numPassedTests}`);console.log(`failed=${r.numFailedTests}`)' | tee -a "$GITHUB_OUTPUT"
          if [ "$rc" -ne 0 ]; then echo "verdict=failure" >> "$GITHUB_OUTPUT"; exit 1; fi
          echo "verdict=success" >> "$GITHUB_OUTPUT"
      - name: Sticky report comment (deterministic numbers)
        if: always()
        uses: actions/github-script@v9
        env:
          VERDICT: ${{ steps.run.outputs.verdict }}
          PASSED: ${{ steps.run.outputs.passed }}
          FAILED: ${{ steps.run.outputs.failed }}
          FILES: ${{ steps.run.outputs.files }}
          PATCHES: ${{ steps.run.outputs.patches }}
        with:
          script: |
            const marker = '<!-- test-agent-spike:report -->';
            const fs = require('fs');
            const changed = fs.existsSync('/tmp/changed.txt') ? fs.readFileSync('/tmp/changed.txt', 'utf8').trim() : '(none)';
            const sha = fs.existsSync('/tmp/patch-sha.txt') ? fs.readFileSync('/tmp/patch-sha.txt', 'utf8').trim() : '(none)';
            const run = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
            const body = [marker, `**gh-aw spike verify**: ${process.env.VERDICT || 'not reached'}`, '',
              `- tested head: ${context.payload.pull_request.head.sha}`,
              `- agent patches: ${process.env.PATCHES || 0}`,
              `- backend suite on head+patch: ${process.env.FILES || '?'} files, ${process.env.PASSED || '?'} passed, ${process.env.FAILED || '?'} failed`,
              '', '```', changed, sha, '```', `run: ${run}`].join('\n');
            const { data: comments } = await github.rest.issues.listComments({ ...context.repo, issue_number: context.issue.number, per_page: 100 });
            const mine = comments.find(c => c.body && c.body.startsWith(marker));
            if (mine) await github.rest.issues.updateComment({ ...context.repo, comment_id: mine.id, body });
            else await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
---

# Spike: PR unit-test agent on gh-aw

You are evaluating a pull request in this repository. Work only inside the repository checkout.

Bash rule: run exactly one simple command per Bash call. No `&&`, `;`, subshells, `2>&1` or other redirects. Pipes only where shown below. To work in `backend/`, run `cd backend` as its own call first; the directory persists between calls.

1. Invoke the project skill `backend-unit-tests` with the Skill tool before you write any test. Quote its spike marker line exactly in your final answer.
2. Environment probe. Run `env | cut -d= -f1 | sort` (variable NAMES only, no values) and copy the list of names into your final answer.
3. In `backend/`, run `npm ci --ignore-scripts`, then `npx prisma generate`, then `npx vitest run`. Report the pass and fail counts.
4. Read the PR diff with `git diff ${{ github.event.pull_request.base.sha }}...HEAD -- backend/src` (or read the changed files if the ref is missing). If backend behaviour changed, write or update a unit test for it in `backend/tests/` following the skill, and run it with `npx vitest run <file>` until it passes. Never change files outside `backend/tests/`.
5. If the file `backend/spike-g3-negative.txt` exists in the checkout, ALSO add the line `"spikeProbe": true,` as the second line inside the top-level object of `backend/package.json`. This is a deliberate negative test of the push policy.
6. Commit your changes on the current branch and call the `push_to_pull_request_branch` safe output. If you changed nothing, call `noop` with the reason.
