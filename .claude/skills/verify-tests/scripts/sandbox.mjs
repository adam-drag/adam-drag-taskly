// Runs PR-controlled commands (npm ci, prisma generate, tsc, vitest) apart from the trusted verifier.
// Node 22, no dependencies.
//
// Two modes:
// - user: every command runs as a separate unprivileged OS user, through
//   `sudo -n -u <user> -- /usr/bin/env -i PATH=... HOME=... <cmd>`. The trees it runs in are copies owned by
//   that user under the sandbox root. The trusted scripts, the git checkout, the results and the CI control
//   files stay owned by the runner user, which the sandbox user cannot write (isolate.sh checks and logs
//   that before any PR code runs). After every command all processes of the sandbox user are killed, and a
//   remaining process is an isolation failure.
// - direct: same user, for local runs and the node tests. Processes started by a command carry a tag in
//   their environment, and reap() kills every process with that tag.
//
// Results that PR code writes (vitest JSON, coverage) are untrusted data. They are read only after reap(),
// as regular files with a size cap.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class IsolationError extends Error {}

const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const blobSha = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

// Every file of a tree (not following symlinks) as { path: 'file:<blob sha>' | 'link:<target>' }.
export function manifest(root) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, p));
      if (st.isSymbolicLink()) out[p] = `link:${readlinkSync(join(root, p))}`;
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[p] = `file:${blobSha(readFileSync(join(root, p)))}`;
      else out[p] = 'other';
    }
  };
  walk('');
  return out;
}

// The paths of `expected` whose content or type differs in root now. Files added since are not listed.
export function manifestChanges(root, expected) {
  const changed = [];
  for (const [p, want] of Object.entries(expected)) {
    const full = join(root, p);
    let now = 'missing';
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) now = `link:${readlinkSync(full)}`;
      else if (st.isFile()) now = `file:${blobSha(readFileSync(full))}`;
      else now = 'other';
    } catch { now = 'missing'; }
    if (now !== want) changed.push(p);
  }
  return changed;
}

// Tagged processes of this user (direct mode): pids whose environment holds SANDBOX_TAG=<tag>.
function taggedPids(tag) {
  if (!existsSync('/proc')) return [];
  const pids = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try { if (readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').includes(`SANDBOX_TAG=${tag}`)) pids.push(Number(d)); } catch { /* gone or not ours */ }
  }
  return pids;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// opts: { user, root } for user mode; { root } alone for direct mode. listPids replaces the /proc scan of
// direct mode in tests.
export function createSandbox({ user = null, root, lang = 'C.UTF-8', listPids = taggedPids } = {}) {
  if (!root) throw new Error('sandbox root missing');
  const tag = randomBytes(8).toString('hex');
  const home = join(root, 'home');
  const asUser = (args, opts = {}) => sh('sudo', ['-n', '-u', user, '--', ...args], opts);
  let homeReady = !user;
  const box = {
    mode: user ? 'user' : 'direct', user, root, home, reaps: 0,

    // Creates a directory the sandbox user owns.
    mkdir(dir) {
      if (!user) { mkdirSync(dir, { recursive: true }); return; }
      const r = asUser(['/usr/bin/mkdir', '-p', '--', dir]);
      if (r.status !== 0) throw new IsolationError(`mkdir ${dir} as ${user} failed: ${r.stderr}`);
    },

    // Copies a runner-owned directory into a new directory the sandbox user owns.
    stage(from, to) {
      if (!user) { cpSync(from, to, { recursive: true, verbatimSymlinks: true }); return; }
      box.mkdir(to);
      const pack = spawnSync('tar', ['-C', from, '-cf', '-', '.'], { maxBuffer: 2 * 1024 * 1024 * 1024 });
      if (pack.status !== 0) throw new IsolationError(`tar of ${from} failed`);
      const r = spawnSync('sudo', ['-n', '-u', user, '--', '/usr/bin/tar', '--no-same-owner', '-C', to, '-xf', '-'], { input: pack.stdout, encoding: 'utf8' });
      if (r.status !== 0) throw new IsolationError(`unpack into ${to} as ${user} failed: ${r.stderr}`);
    },

    // Writes or removes one file inside a sandbox tree, as the sandbox user.
    writeFile(path, bytes) {
      if (!user) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return; }
      box.mkdir(dirname(path));
      const r = spawnSync('sudo', ['-n', '-u', user, '--', '/usr/bin/tee', '--', path], { input: bytes, stdio: ['pipe', 'ignore', 'pipe'] });
      if (r.status !== 0) throw new IsolationError(`write ${path} as ${user} failed`);
    },
    remove(path) {
      if (!user) { rmSync(path, { force: true }); return; }
      const r = asUser(['/usr/bin/rm', '-f', '--', path]);
      if (r.status !== 0) throw new IsolationError(`rm ${path} as ${user} failed: ${r.stderr}`);
    },

    // Runs one PR-controlled command, then kills every process it left behind.
    exec(cmd, args, cwd, { timeout = 10 * 60 * 1000 } = {}) {
      if (!homeReady) { box.mkdir(home); homeReady = true; }
      const env = { PATH: process.env.PATH, HOME: user ? home : process.env.HOME, LANG: lang, TZ: 'UTC' };
      const t0 = Date.now();
      let r;
      if (user) {
        const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
        r = spawnSync('sudo', ['-n', '-u', user, '--', '/usr/bin/env', '-i', ...envArgs, cmd, ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout });
      } else {
        r = spawnSync(cmd, args, { cwd, env: { ...env, SANDBOX_TAG: tag }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout });
      }
      const ms = Date.now() - t0;
      box.reap();
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms, error: r.error ? String(r.error.message) : null };
    },

    // Kills every process of the sandbox, then checks that none is left. Throws IsolationError otherwise.
    reap() {
      box.reaps++;
      for (let i = 0; i < 20; i++) {
        if (user) {
          const k = sh('sudo', ['-n', 'pkill', '-KILL', '-u', user]);
          if (k.status !== 0 && k.status !== 1) throw new IsolationError(`pkill -u ${user} exited ${k.status}: ${k.stderr}`);
          const g = sh('pgrep', ['-u', user]);
          if (g.status === 1) return;
          if (g.status !== 0) throw new IsolationError(`pgrep -u ${user} exited ${g.status}: ${g.stderr}`);
        } else {
          const pids = listPids(tag);
          if (!pids.length) return;
          for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        }
        pause(100);
      }
      throw new IsolationError(`processes of the sandbox${user ? ` user ${user}` : ''} are still running after 20 kill rounds`);
    },

    // Reads a result file that PR code wrote: only a regular file, at most 64 MB. Call after reap().
    read(path) {
      let st;
      try { st = lstatSync(path); } catch { return null; }
      if (!st.isFile() || st.size > MAX_RESULT_BYTES) return null;
      let bytes;
      try { bytes = readFileSync(path); } catch { return null; }
      return bytes.length > MAX_RESULT_BYTES ? null : bytes;
    },
    readJson(path) {
      const b = box.read(path);
      if (!b) return null;
      try { return JSON.parse(b.toString('utf8')); } catch { return null; }
    },
  };
  return box;
}

// A git tree (a commit plus extra blobs from a prepared index) written out as plain files, without .git.
// indexFile must already hold the tree (git read-tree / update-index). The checkout runs as the runner in
// the runner-owned repository and target; nothing in it is PR-writable yet.
export function checkoutIndex(repo, indexFile, target) {
  mkdirSync(target, { recursive: true });
  const r = sh('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'checkout-index', '-a', '-f', `--prefix=${target.replace(/\/?$/, '/')}`], { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  if (r.status !== 0) throw new Error(`git checkout-index into ${target} failed: ${r.stderr}`);
}
