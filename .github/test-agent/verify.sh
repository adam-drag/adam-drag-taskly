#!/usr/bin/env bash
# Keyless verification of one attempt (plan 2.8). Runs PR code: never give it secrets.
#
#   bash verify.sh <attempt>
#
# Layout (job working directory): trusted/ (base commit), work/ (clean PR head checkout), ctx/ (scope
# artifact), baseline/ (baseline artifact), gen/ (gen-<attempt> artifact). Output goes to out/.
set -euo pipefail
n=${1:-1}

pkgs=()
for pkg in backend frontend; do
  if grep -q "^diff --git a/$pkg/" "gen/patch$n.diff" || node -e "process.exit(require('./ctx/scope.json').packages.includes('$pkg') ? 0 : 1)"; then
    pkgs+=("$pkg")
  fi
done
bash trusted/.github/test-agent/install.sh work head install-failures.txt "${pkgs[@]}"

mkdir -p out
node trusted/.claude/skills/verify-tests/scripts/verify.mjs verify --dir work --patch "gen/patch$n.diff" --files "gen/files$n" \
  --scope ctx/scope.json --guard "gen/guard$n.json" --result "gen/result$n.json" --baseline baseline/baseline.json \
  --head-sha "$HEAD_SHA" --attempt "$n" --out "out/verify$n.json" --feedback "out/feedback$n.md" \
  --candidate-out out/candidate --work "$RUNNER_TEMP/verify$n"
if [ -f install-failures.txt ]; then
  N=$n node -e '
    const fs = require("fs"); const p = `out/verify${process.env.N}.json`; const v = JSON.parse(fs.readFileSync(p, "utf8"));
    const f = fs.readFileSync("install-failures.txt", "utf8").trim().split("\n");
    v.classes.infrastructure.push(...f); v.gate.reasons.push(...f); v.gate.publish = false; v.trigger_attempt_2 = false;
    fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");'
fi
N=$n node -e '
  const v = require(`./out/verify${process.env.N}.json`);
  console.log(`publish=${v.gate.publish}`);
  console.log(`attempt2=${v.trigger_attempt_2 === true}`);' >> "$GITHUB_OUTPUT"
