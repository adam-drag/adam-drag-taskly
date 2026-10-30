#!/usr/bin/env bash
# The isolation boundary for PR code in the keyless jobs (baseline, verify-1, verify-2).
#
#   bash isolate.sh setup <protected path>...   create the sandbox user and check the boundary
#   bash isolate.sh reap                       kill every process of the sandbox user; fail if one is left
#
# PR code (npm ci, prisma generate, tsc, vitest, agent tests) runs only as PR_USER (default prtest), a new
# system user with no sudo rights and no groups but its own, in copies under PR_ROOT (default /srv/pr).
# The runner user keeps the trusted scripts, the checkouts, the results and the CI control files. Setup
# runs before any PR code, logs what the boundary rests on, and exits 1 (fail closed) when the sandbox
# user can write a protected path, a PATH directory or a binary the trusted steps run, can use sudo or
# docker, or can read the runner's environment.
set -euo pipefail
PR_USER=${PR_USER:-prtest}
PR_ROOT=${PR_ROOT:-/srv/pr}
cmd=${1:-}
shift || true

as_user() { sudo -n -u "$PR_USER" -- /usr/bin/env -i PATH=/usr/bin:/bin HOME="$PR_ROOT/home" "$@"; }
fail() { echo "::error::isolation: $*"; exit 1; }

reap() {
  for _ in $(seq 1 20); do
    sudo -n pkill -KILL -u "$PR_USER" || true
    if ! pgrep -u "$PR_USER" > /dev/null; then echo "isolation: no process of $PR_USER is running"; return 0; fi
    sleep 0.2
  done
  pgrep -a -u "$PR_USER" || true
  fail "processes of $PR_USER are still running after 20 kill rounds"
}

setup() {
  echo "::group::isolation setup (user $PR_USER, root $PR_ROOT)"
  sudo -n true || fail "the runner user has no passwordless sudo, so no separate user can be created"
  echo "runner: $(id)"
  sudo -n useradd --system --user-group --no-create-home --home-dir "$PR_ROOT/home" --shell /usr/sbin/nologin "$PR_USER"
  # PR_ROOT holds only PR-controlled copies and results, so the sandbox user owns it.
  sudo -n install -d -o "$PR_USER" -g "$PR_USER" -m 755 "$PR_ROOT"
  sudo -n install -d -o "$PR_USER" -g "$PR_USER" -m 700 "$PR_ROOT/home"
  # No cron or at jobs: a sandbox process must not come back after reap.
  echo "$PR_USER" | sudo -n tee -a /etc/cron.deny /etc/at.deny > /dev/null

  # Places the trusted steps execute from that the image leaves world-writable (the node tool cache,
  # /usr/local/bin and other PATH directories): no write for group or others from here on.
  local node_bin node_home d
  node_bin=$(readlink -f "$(command -v node)")
  node_home=$(dirname "$(dirname "$node_bin")")
  # Only a node from the runner tool cache (setup-node) is changed; a system node (/usr) is refused.
  case "$node_home" in "${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"/*) ;; *) fail "node $node_bin is not in the runner tool cache" ;; esac
  sudo -n chmod -R go-w "$node_home"
  d=$node_home
  while [ "$d" != "/" ]; do sudo -n chmod go-w "$d"; d=$(dirname "$d"); done
  IFS=: read -r -a path_dirs <<< "$PATH"
  for d in "${path_dirs[@]}"; do
    [ -d "$d" ] || continue
    sudo -n chmod go-w "$d"
    sudo -n find "$d" -maxdepth 1 ! -type l -perm /022 -exec chmod go-w {} +
  done

  echo "sandbox user: $(id "$PR_USER")"
  [ "$(id -nG "$PR_USER")" = "$PR_USER" ] || fail "$PR_USER is in other groups: $(id -nG "$PR_USER")"
  echo "as $PR_USER: $(as_user id)"
  local l
  l=$(sudo -n -l -U "$PR_USER" 2>&1 || true)
  echo "sudo -l -U $PR_USER: $l"
  case "$l" in *"not allowed to run sudo"*) ;; *) fail "$PR_USER may run sudo" ;; esac
  if as_user sudo -n true 2> /dev/null; then fail "$PR_USER ran sudo"; fi
  echo "as $PR_USER: sudo -n true refused (expected)"
  if as_user /bin/sh -c 'cat "/proc/$1/environ"' sh "$$" > /dev/null 2>&1; then fail "$PR_USER can read the runner's environment"; fi
  echo "as $PR_USER: reading /proc/$$/environ of the runner shell refused (expected)"
  if [ -S /var/run/docker.sock ] && as_user /usr/bin/test -w /var/run/docker.sock; then fail "$PR_USER can use the docker socket"; fi

  # Write checks. A file must not be appendable, a directory must not take a new entry.
  local targets=("$@" "$GITHUB_WORKSPACE" "$RUNNER_TEMP" "$GITHUB_OUTPUT" "$GITHUB_ENV" "$GITHUB_PATH" "$GITHUB_STEP_SUMMARY" "$node_bin" "$(dirname "$node_bin")" "$node_home")
  for b in node npm npx git tar bash sh env sudo pkill pgrep mkdir tee rm chmod; do
    targets+=("$(readlink -f "$(command -v "$b")")")
  done
  for d in "${path_dirs[@]}"; do [ -d "$d" ] && targets+=("$d"); done
  local t
  for t in "${targets[@]}"; do
    [ -e "$t" ] || fail "protected path $t does not exist"
    t=$(readlink -f "$t")
    stat -c '%A %U:%G %n' "$t"
    if [ -d "$t" ]; then
      if as_user /bin/sh -c 'mkdir "$1/.isolation-probe"' sh "$t" 2> /dev/null; then sudo -n rmdir "$t/.isolation-probe"; fail "$PR_USER can write in $t"; fi
    elif as_user /bin/sh -c ': >> "$1"' sh "$t" 2> /dev/null; then
      fail "$PR_USER can write $t"
    fi
  done
  echo "as $PR_USER: every write above was refused (expected)"
  sysctl fs.protected_symlinks fs.protected_hardlinks fs.protected_regular fs.protected_fifos
  stat -c '%A %U:%G %n' "$PR_ROOT" "$PR_ROOT/home" "$HOME"
  echo "::endgroup::"
}

case "$cmd" in
  setup) setup "$@" ;;
  reap) reap ;;
  *) echo "usage: isolate.sh setup <protected path>... | reap" >&2; exit 2 ;;
esac
