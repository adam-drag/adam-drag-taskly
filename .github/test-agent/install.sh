#!/usr/bin/env bash
# Install the dependencies of each package without lifecycle scripts. Runs PR code: never give it secrets.
#
#   bash install.sh <tree dir> <side label> <failures file> <package>...
#
# A failed command is recorded as one line "<package> <side>: <command> failed" in the failures file, and
# the script goes on with the next package. baseline.mjs and verify.sh turn those lines into an
# inconclusive package or an infrastructure failure. A failed install never counts as a test result.
set -uo pipefail
dir=$1 side=$2 failures=$3
shift 3
for pkg in "$@"; do
  echo "::group::$side: $pkg"
  if ! (cd "$dir/$pkg" && npm ci --ignore-scripts --no-audit --no-fund); then
    echo "$pkg $side: npm ci failed" >> "$failures"
  elif [ "$pkg" = backend ] && ! (cd "$dir/backend" && npx prisma generate); then
    echo "$pkg $side: prisma generate failed" >> "$failures"
  fi
  echo "::endgroup::"
done
exit 0
