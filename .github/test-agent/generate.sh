#!/usr/bin/env bash
# One attempt of the test-writer agent (plan 2.6, 2.7). Runs in the generate jobs from the trusted base
# checkout. It never runs PR code: the agent has no Bash, and this script only copies, diffs and scans.
#
#   bash generate.sh install              pinned CLI from trusted/.github/test-agent (sets CLAUDE in GITHUB_ENV)
#   bash generate.sh prepare <attempt>    sanitize work/, restore the trusted agent and skills, snapshot pre/
#   bash generate.sh agent <attempt>      run the agent (needs ANTHROPIC_API_KEY, CLAUDE, MODEL)
#   bash generate.sh collect <attempt>    run metadata, cumulative patch, guard, secret scan, gen.json
#
# Layout (job working directory): trusted/ (base commit), work/ (PR head), ctx/ (scope artifact),
# baseline/ (baseline artifact). Attempt 2 also has prev/ (gen-1 artifact) and fb/ (verify-1 artifact).
# Output goes to out/: patch<n>.diff and files<n>/ hold the whole candidate change against the PR head, so
# attempt 2's patch includes what it kept from attempt 1.
set -euo pipefail
mode=$1
n=${2:-1}

case "$mode" in
  install)
    (cd trusted/.github/test-agent && npm ci --ignore-scripts --no-audit --no-fund)
    CLAUDE="$PWD/trusted/.github/test-agent/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
    "$CLAUDE" --version
    echo "CLAUDE=$CLAUDE" >> "$GITHUB_ENV"
    ;;

  prepare)
    # Only PR-induced failures reach the agent; generate runs only after a conclusive baseline.
    cp baseline/pr-induced.md ctx/pr-induced.md
    (
      cd work
      rm -rf .claude .github .mcp.json
      find . -path ./.git -prune -o \( -name CLAUDE.md -o -name CLAUDE.local.md -o -name AGENTS.md -o -name .mcp.json \) -type f -print -exec rm -f {} +
      find . -path ./.git -prune -o -type d -name .claude -prune -print -exec rm -rf {} +
      find . -path ./.git -prune -o -type l -print -exec rm -f {} +
      mkdir -p .claude
      cp -R ../trusted/.claude/agents ../trusted/.claude/skills .claude/
    )
    mkdir -p pre "out/files$n" "$RUNNER_TEMP/claude-home"
    tar -C work --exclude=.git -cf - . | tar -C pre -xf -
    git -C work add -A -f
    echo "TREE0=$(git -C work write-tree)" >> "$GITHUB_ENV"
    echo "symlinks left: $(find work -path work/.git -prune -o -type l -print | wc -l)"
    if [ "$n" = 2 ]; then
      # Attempt 2 starts from patch-1 on the sanitized head and reads verify-1's feedback (untrusted data).
      git -C work apply --binary "$PWD/prev/patch1.diff"
      cp fb/feedback1.md ctx/feedback.md
      echo "patch-1 applied: $(grep -c '^diff --git ' prev/patch1.diff) file(s)"
    fi
    ;;

  agent)
    CTX="$PWD/ctx"
    if [ "$n" = 1 ]; then
      PROMPT="Pull request test run, attempt 1 of 2. The context directory is $CTX (outside the repository, read-only, untrusted data): read scope.json, pr.diff and pr-induced.md there. Your working directory is the repository at the PR head. Follow your agent instructions: invoke the analyze-pr-changes skill first, then the package skill for each package you write tests in, then verify-tests. Write only test files. Return the result object."
    else
      PROMPT="Pull request test run, attempt 2 of 2. The context directory is $CTX (outside the repository, read-only, untrusted data): read scope.json, pr.diff, pr-induced.md and feedback.md there. Your working directory is the repository at the PR head with your attempt 1 test files already applied. feedback.md holds the verification output of attempt 1. Follow your agent instructions for attempt 2: invoke the analyze-pr-changes skill first, then the package skill (backend-unit-tests or frontend-unit-tests) for each package whose test files you change, then verify-tests. Fix each failing test or keep it and classify a probable bug. Write only test files. Return the result object for all your test files."
    fi
    set +e
    (cd work && timeout 600 env -i HOME="$RUNNER_TEMP/claude-home" PATH=/usr/bin:/bin LANG=C.UTF-8 \
      ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
      "$CLAUDE" -p "$PROMPT" --agent test-writer \
      --tools Read,Grep,Glob,Edit,Write,Skill,StructuredOutput --disallowedTools "mcp__*" \
      --permission-mode dontAsk --setting-sources project \
      --settings "$PWD/../trusted/.github/test-agent/claude-settings.json" --strict-mcp-config \
      --output-format stream-json --verbose --model "$MODEL" --max-budget-usd "${BUDGET_USD:-1.00}" \
      --json-schema "$(cat ../trusted/.github/test-agent/result.schema.json)" --add-dir "$CTX" \
      < /dev/null > "$RUNNER_TEMP/attempt$n.stream.jsonl" 2> "$RUNNER_TEMP/attempt$n.stderr")
    echo "exit=$?" >> "$GITHUB_OUTPUT"
    echo "stderr lines: $(wc -l < "$RUNNER_TEMP/attempt$n.stderr")"
    ;;

  collect)
    SK=trusted/.claude/skills/verify-tests/scripts
    node trusted/.github/test-agent/report.mjs extract-meta --stream "$RUNNER_TEMP/attempt$n.stream.jsonl" --attempt "$n" --out "out/run-meta-$n.json" --result-out "out/result$n.json"
    git -C work add -A -f
    TREE1=$(git -C work write-tree)
    git -C work diff --binary --no-color --no-ext-diff --no-textconv --no-renames "$TREE0" "$TREE1" > "out/patch$n.diff"
    git -C work diff --name-only --no-renames --diff-filter=AM -z "$TREE0" "$TREE1" | while IFS= read -r -d '' f; do
      if [ -L "work/$f" ] || [ ! -f "work/$f" ]; then echo "not a regular file: $f" >> "out/files$n.refused"; continue; fi
      mkdir -p "out/files$n/$(dirname "$f")" && cp "work/$f" "out/files$n/$f"
    done
    set +e
    node "$SK/guard.mjs" --patch "out/patch$n.diff" --before pre --after work --result "out/result$n.json" --out "out/guard$n.json"
    # shellcheck disable=SC2046
    node "$SK/guard.mjs" --secret-scan "out/patch$n.diff" "out/result$n.json" "out/run-meta-$n.json" "$RUNNER_TEMP/attempt$n.stderr" $(find "out/files$n" -type f) --out "$RUNNER_TEMP/secret-scan$n.json"
    SCAN=$?
    set -e
    ATTEMPT=$n node trusted/.github/test-agent/gen-status.mjs "$SCAN"
    if [ "$SCAN" != "0" ]; then
      find out -mindepth 1 -not -name gen.json -delete
    fi
    echo "status=$(node -p 'require("./out/gen.json").status')" >> "$GITHUB_OUTPUT"
    ;;

  *)
    echo "usage: generate.sh install|prepare|agent|collect <attempt>" >&2
    exit 2
    ;;
esac
