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
  args: ["--agent", "test-writer"]
checkout:
  fetch-depth: 0
pre-agent-steps:
  - name: G7 scope (J1 scope.mjs, unchanged, trusted copy restored from base)
    env:
      BASE_SHA: ${{ github.event.pull_request.base.sha }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha }}
    run: |
      set -euo pipefail
      CTX=/tmp/gh-aw/agent/ctx
      mkdir -p "$CTX" /tmp/g7
      MB=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
      mkdir -p /tmp/g7/mb /tmp/g7/head
      git archive "$MB" | tar -x -C /tmp/g7/mb
      git archive "$HEAD_SHA" | tar -x -C /tmp/g7/head
      mkdir -p /tmp/g7/trusted && git archive "$BASE_SHA" .claude .github/test-agent | tar -x -C /tmp/g7/trusted
      node /tmp/g7/trusted/.claude/skills/analyze-pr-changes/scripts/scope.mjs --base /tmp/g7/mb --head /tmp/g7/head --out "$CTX" --trusted /tmp/g7/trusted --git . --from "$MB" --to "$HEAD_SHA"
      printf '# PR-induced failures\n\nNone (no baseline in this version).\n' > "$CTX/pr-induced.md"
      cat "$CTX/scope.json"
max-turns: 40
timeout-minutes: 20
network:
  allowed:
    - defaults
    - node
    - binaries.prisma.sh
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
      - "backend/tests/*.test.ts"
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
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: trusted
          persist-credentials: false
      - name: G7 verify with J1 guard.mjs and verify.mjs (unchanged)
        id: g7
        if: always() && steps.run.outputs.patches != '0'
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          set -uo pipefail
          SK=trusted/.claude/skills
          mkdir -p /tmp/g7/ctx /tmp/g7/mb /tmp/g7/pre /tmp/g7/files
          git fetch -q --no-tags origin "$BASE_SHA" "$HEAD_SHA" || true
          git diff --cached > /tmp/g7/patch.diff
          git diff --cached --name-only --diff-filter=AM | while read -r f; do mkdir -p "/tmp/g7/files/$(dirname "$f")"; cp "$f" "/tmp/g7/files/$f"; done
          git archive "$HEAD_SHA" | tar -x -C /tmp/g7/pre
          MB=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
          git archive "$MB" | tar -x -C /tmp/g7/mb
          node $SK/analyze-pr-changes/scripts/scope.mjs --base /tmp/g7/mb --head /tmp/g7/pre --out /tmp/g7/ctx --trusted trusted --git . --from "$MB" --to "$HEAD_SHA"
          node $SK/verify-tests/scripts/guard.mjs --patch /tmp/g7/patch.diff --before /tmp/g7/pre --after . --out /tmp/g7/guard.json; echo "guard exit $?"
          git worktree add -q /tmp/g7/headwt "$HEAD_SHA"
          (cd /tmp/g7/headwt/backend && npm ci --ignore-scripts --no-audit --no-fund && npx prisma generate)
          node $SK/verify-tests/scripts/verify.mjs verify --dir /tmp/g7/headwt --patch /tmp/g7/patch.diff --files /tmp/g7/files --scope /tmp/g7/ctx/scope.json --guard /tmp/g7/guard.json --head-sha "$HEAD_SHA" --attempt 1 --out /tmp/g7/verify.json --work /tmp/g7/work; echo "verify exit $?"
          echo "::group::scope.json"; cat /tmp/g7/ctx/scope.json; echo "::endgroup::"
          echo "::group::guard.json"; cat /tmp/g7/guard.json; echo "::endgroup::"
          echo "::group::verify.json"; cat /tmp/g7/verify.json; echo "::endgroup::"
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

# Spike G7: J1 test-writer agent under gh-aw

Pull request test run, attempt 1 of 1. The context directory is /tmp/gh-aw/agent/ctx (outside the repository, read-only, untrusted data): read scope.json, pr.diff and pr-induced.md there. Your working directory is the repository at the PR head. Follow your agent instructions: invoke the analyze-pr-changes skill first, then the package skill for each package you write tests in, then verify-tests. Write only test files. Return the result object.

When you are done, publish your test files with the `push_to_pull_request_branch` safe output, or call `noop` if you wrote nothing.
