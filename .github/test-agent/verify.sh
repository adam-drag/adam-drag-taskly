#!/usr/bin/env bash
# Keyless verification of one attempt (plan 2.8). Never give it secrets.
#
#   bash verify.sh <attempt>
#
# Layout (job working directory): trusted/ (base commit), work/ (clean PR head checkout), ctx/ (scope
# artifact), baseline/ (baseline artifact), gen/ (gen-<attempt> artifact). Output goes to out/.
#
# Order: the isolation boundary is set up and checked first (isolate.sh), then the trusted verifier loads
# and records the candidate identity, and only then does PR code run (npm ci, prisma generate, tsc,
# vitest), as the sandbox user in a copy under /srv/pr. Before the publish and attempt-2 outputs are
# written, every process of the sandbox user is killed again; a process that is left fails the step.
set -euo pipefail
n=${1:-1}
T=trusted/.github/test-agent

mkdir -p out
bash "$T/isolate.sh" setup trusted work ctx baseline gen out
node trusted/.claude/skills/verify-tests/scripts/verify.mjs verify --dir work --patch "gen/patch$n.diff" --files "gen/files$n" \
  --scope ctx/scope.json --guard "gen/guard$n.json" --result "gen/result$n.json" --baseline baseline/baseline.json \
  --head-sha "$HEAD_SHA" --attempt "$n" --out "out/verify$n.json" --feedback "out/feedback$n.md" \
  --candidate-out out/candidate --work "$RUNNER_TEMP/verify$n" --install \
  --sandbox-user "${PR_USER:-prtest}" --sandbox-root "${PR_ROOT:-/srv/pr}/verify$n"
bash "$T/isolate.sh" reap
N=$n node -e '
  const v = require(`./out/verify${process.env.N}.json`);
  console.log(`publish=${v.gate.publish === true}`);
  console.log(`attempt2=${v.trigger_attempt_2 === true}`);' >> "$GITHUB_OUTPUT"
