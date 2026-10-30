// Regression tests for scope main(), verify() and the report's bot-commit path, on small fixtures.
// verify() runs a fake vitest and tsc from the fixture's node_modules/.bin, so no real install is needed.
// Run with: node --test .github/test-agent/tests/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main as scopeMain } from '../../../.claude/skills/analyze-pr-changes/scripts/scope.mjs';
import { indexResults, verify } from '../../../.claude/skills/verify-tests/scripts/verify.mjs';
import { IsolationError, createSandbox } from '../../../.claude/skills/verify-tests/scripts/sandbox.mjs';
import { fetchBotStatus, render } from '../report.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd, author, subject) => git(cwd, '-c', `user.name=${author}`, '-c', 'user.email=x@example.com', 'commit', '-q', '--allow-empty', '-m', subject);

// --- scope main() --------------------------------------------------------------------------------

test('scope main() writes skip_kind bot-commit to scope.json when the head is a bot commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'));
  const repo = join(root, 'repo'), base = join(root, 'base');
  mkdirSync(join(repo, 'backend/src/api'), { recursive: true });
  mkdirSync(join(base, 'backend/src/api'), { recursive: true });
  writeFileSync(join(base, 'backend/src/api/health.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'backend/src/api/health.ts'), 'export const a = 2;\n');
  git(repo, 'init', '-q');
  git(repo, 'add', 'backend/src/api/health.ts');
  commit(repo, 'Adam', 'feat: change');
  const from = git(repo, 'rev-parse', 'HEAD');
  commit(repo, 'github-actions[bot]', 'test(agent): add/update unit tests for #1');
  const to = git(repo, 'rev-parse', 'HEAD');
  const out = join(root, 'out');
  const log = console.log;
  console.log = () => {};
  try { assert.equal(scopeMain(['--base', base, '--head', repo, '--out', out, '--git', repo, '--from', from, '--to', to]), 0); } finally { console.log = log; }
  const scope = JSON.parse(readFileSync(join(out, 'scope.json'), 'utf8'));
  assert.equal(scope.decision, 'skip');
  assert.equal(scope.skip_kind, 'bot-commit');
  assert.equal(scope.head_commit.bot, true);
});

test('scope main() fails closed with exit 1 when the base and head share no merge base', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-mb-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  commit(repo, 'Adam', 'base history');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '--orphan', 'other');
  commit(repo, 'Adam', 'unrelated history');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  const out = join(root, 'out');
  const log = console.log;
  console.log = () => {};
  let code;
  try { code = scopeMain(['--base', join(root, 'base'), '--head', repo, '--out', out, '--git', repo, '--base-sha', baseSha, '--head-sha', headSha]); } finally { console.log = log; }
  assert.equal(code, 1);
  const scope = JSON.parse(readFileSync(join(out, 'scope.json'), 'utf8'));
  assert.equal(scope.decision, 'error');
  assert.match(scope.reason, /^no merge base: git merge-base \S+ \S+ exited 1/);
});

test('scope main() extracts the merge base and scans from it, not from the moved base branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-mb-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'backend/src/api'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'backend/src/api/health.ts'), 'export const a = 1;\n');
  git(repo, 'add', 'backend/src/api/health.ts');
  commit(repo, 'Adam', 'base');
  const mb = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'backend/src/api/health.ts'), 'export const a = 2;\n');
  git(repo, 'add', 'backend/src/api/health.ts');
  commit(repo, 'Adam', 'feat: change');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'README.md'), 'moved on\n');
  git(repo, 'add', 'README.md');
  commit(repo, 'Adam', 'docs: base moved');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'feature');
  const out = join(root, 'out'), base = join(root, 'base');
  const log = console.log;
  console.log = () => {};
  try { assert.equal(scopeMain(['--base', base, '--head', repo, '--out', out, '--git', repo, '--base-sha', baseSha, '--head-sha', headSha]), 0); } finally { console.log = log; }
  const scope = JSON.parse(readFileSync(join(out, 'scope.json'), 'utf8'));
  assert.equal(scope.merge_base, mb);
  assert.equal(scope.decision, 'generate');
  assert.deepEqual(scope.files.map((f) => f.path), ['backend/src/api/health.ts']);
  assert.equal(readFileSync(join(base, 'backend/src/api/health.ts'), 'utf8'), 'export const a = 1;\n');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'shas.json'), 'utf8')), { merge_base: mb, base_sha: baseSha, head_sha: headSha });
});

// --- report: bot-commit runs ---------------------------------------------------------------------

test('report copies the bot commit status into the verdict', async () => {
  const scope = { decision: 'skip', skip_kind: 'bot-commit', reason: 'bot head', files: [] };
  const api = async () => ({ status: 200, json: [{ context: 'ci/other', state: 'success' }, { context: 'test-agent/verified', state: 'failure', description: 'failure: probable bug' }] });
  const botStatus = await fetchBotStatus('a'.repeat(40), api);
  assert.deepEqual(botStatus, { state: 'failure', description: 'failure: probable bug' });
  assert.equal(render({ scope, botStatus }).verdict.state, 'failure');
  assert.equal(render({ scope, botStatus: null }).verdict.state, 'failure');
  assert.equal(render({ scope, botStatus: { state: 'success', description: '' } }).verdict.state, 'success');
  assert.equal(await fetchBotStatus('a'.repeat(40), async () => ({ status: 200, json: [] })), null);
});

test('report fails with the reason when the status list cannot be read', async () => {
  const scope = { decision: 'skip', skip_kind: 'bot-commit', reason: 'bot head', files: [] };
  await assert.rejects(fetchBotStatus('a'.repeat(40), async () => ({ status: 502, json: null })), /list statuses: HTTP 502/);
  const v = render({ scope, botStatus: null, botStatusError: 'list statuses: HTTP 502' }).verdict;
  assert.equal(v.state, 'failure');
  assert.equal(v.class, 'infrastructure');
  assert.match(v.headline, /stage: report.*HTTP 502/);
});

// --- verify() ------------------------------------------------------------------------------------

const FAKE_VITEST = `#!/usr/bin/env node
// Fake vitest: passes every test file except *.probable-bug.test.ts; behaviour from fake.json in the package.
const fs = require('node:fs'), path = require('node:path');
const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fake.json'), 'utf8'));
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
const cov = args.find((a) => a.startsWith('--coverage.reportsDirectory='));
let files = args.filter((a) => a !== 'run' && !a.startsWith('-'));
const isRerun = files.length > 0;
if (!isRerun) files = fs.readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => 'tests/' + f);
const results = files.map((f) => {
  const failed = f.includes('.probable-bug.') || (cfg.failing ?? []).includes(f);
  return { name: path.join(process.cwd(), f), status: failed ? 'failed' : 'passed', message: '', assertionResults: [{ fullName: 't', status: failed ? 'failed' : 'passed', failureMessages: failed ? ['expected 1 to be 2'] : [] }] };
});
const failedN = results.filter((r) => r.status === 'failed').length;
fs.writeFileSync(out, JSON.stringify({ numTotalTests: results.length, numPassedTests: results.length - failedN, numFailedTests: failedN, numTotalTestSuites: results.length, success: failedN === 0, testResults: results }));
if (cov && cfg.coverage !== false) {
  const dir = cov.split('=')[1];
  fs.mkdirSync(dir, { recursive: true });
  const pct = { pct: 100 };
  fs.writeFileSync(path.join(dir, 'coverage-summary.json'), JSON.stringify({ total: { lines: pct, statements: pct, branches: pct, functions: pct } }));
}
// Attacks by PR code, for the isolation tests.
const FORGED = JSON.stringify({ forged: true, gate: { publish: true, reasons: [] }, trigger_attempt_2: false });
if (!isRerun && cfg.attack === 'forge-out') fs.writeFileSync(cfg.out, FORGED);
if (!isRerun && cfg.attack === 'modify-candidate') fs.writeFileSync('tests/x.test.ts', "it('a', () => { /* changed after the identity was recorded */ });\\n");
if (!isRerun && cfg.attack === 'background') {
  const out = JSON.stringify(cfg.out);
  const code = "const fs = require('node:fs'); const end = Date.now() + 4000;"
    + " const tick = () => { try { fs.writeFileSync(" + out + ", " + JSON.stringify(FORGED) + "); fs.writeFileSync(" + out + " + '.tampered', 'x'); } catch {}"
    + " if (Date.now() < end) setTimeout(tick, 20); }; setTimeout(tick, 300);";
  require('node:child_process').spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
}
if (isRerun && cfg.killRerun) process.kill(process.pid, 'SIGKILL');
if (!isRerun && cfg.killFull) process.kill(process.pid, 'SIGKILL');
process.exit(failedN ? 1 : isRerun ? (cfg.rerunExit ?? 0) : 0);
`;

// Fake tsc: prints the tscErrors lines from fake.json and exits 2 when there are any.
const FAKE_TSC = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const errs = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fake.json'), 'utf8')).tscErrors ?? [];
if (errs.length) process.stdout.write(errs.join('\\n') + '\\n');
process.exit(errs.length ? 2 : 0);
`;

const newFile = (path, lines) => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), '',
].join('\n');

// Fake npm and npx for the sandbox install: `npm ci` copies the fake vitest and tsc into node_modules/.bin.
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] !== 'ci') process.exit(0);
const src = path.join(__dirname, 'fake-bins');
fs.mkdirSync('node_modules/.bin', { recursive: true });
for (const f of fs.readdirSync(src)) { fs.copyFileSync(path.join(src, f), path.join('node_modules/.bin', f)); fs.chmodSync(path.join('node_modules/.bin', f), 0o755); }
`;

// A bin directory with npm, npx and the fake tools. npmExtra is appended to the fake npm (PR code that runs
// at install time).
function fakeBin(root, npmExtra = '') {
  const bin = join(root, 'bin');
  mkdirSync(join(bin, 'fake-bins'), { recursive: true });
  writeFileSync(join(bin, 'npm'), FAKE_NPM + npmExtra);
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'fake-bins/vitest'), FAKE_VITEST);
  writeFileSync(join(bin, 'fake-bins/tsc'), FAKE_TSC);
  for (const f of ['npm', 'npx', 'fake-bins/vitest', 'fake-bins/tsc']) chmodSync(join(bin, f), 0o755);
  return bin;
}

function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { process.env.PATH = old; console.log = log; }
}

// opts.npmExtra: PR code run by npm ci. opts.subprocess: run verify.mjs from a copy of the trusted scripts in
// a child process (returns the copy's path as v.trusted). opts.sandbox: a sandbox to use instead.
function verifyFixture(fake, { existing = [], fixture = false, baseline = null, npmExtra = '', subprocess = false, sandbox = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-'));
  const dir = join(root, 'work'), files = join(root, 'files'), work = join(root, 'scratch');
  mkdirSync(join(dir, 'backend/tests'), { recursive: true });
  writeFileSync(join(dir, 'backend/package.json'), '{}\n');
  // $OUT and $TRUSTED in the fake config: the paths an attack in PR code aims at.
  writeFileSync(join(dir, 'backend/fake.json'), JSON.stringify(fake).split('$OUT').join(join(root, 'verify.json')).split('$TRUSTED').join(join(root, 'trusted')));
  git(dir, 'init', '-q');
  for (const f of existing) writeFileSync(join(dir, 'backend', f), "it('t', () => {});\n");
  git(dir, 'add', 'backend/package.json', 'backend/fake.json', ...existing.map((f) => `backend/${f}`));
  commit(dir, 'Adam', 'base');
  const bin = fakeBin(root, npmExtra);
  const good = 'backend/tests/x.test.ts', pb = 'backend/tests/x.probable-bug.test.ts';
  mkdirSync(join(files, 'backend/tests'), { recursive: true });
  writeFileSync(join(files, good), "it('a', () => {});\n");
  writeFileSync(join(files, pb), "it('b', () => {});\n");
  let patch = newFile(good, ["it('a', () => {});"]) + newFile(pb, ["it('b', () => {});"]);
  if (fixture) {
    writeFileSync(join(files, 'backend/tests/helpers.ts'), 'export const x = 1;\n');
    patch += newFile('backend/tests/helpers.ts', ['export const x = 1;']);
  }
  writeFileSync(join(root, 'patch.diff'), patch);
  writeFileSync(join(root, 'scope.json'), JSON.stringify({ packages: ['backend'], files: [] }));
  writeFileSync(join(root, 'guard.json'), JSON.stringify({ ok: true, violations: [] }));
  writeFileSync(join(root, 'result.json'), JSON.stringify({ probable_bugs: [{ title: 'wrong comparison', test_file: pb }] }));
  const args = { dir, files, work, install: '1', patch: join(root, 'patch.diff'), scope: join(root, 'scope.json'), guard: join(root, 'guard.json'), result: join(root, 'result.json'), attempt: '1', out: join(root, 'verify.json'), feedback: join(root, 'feedback.md') };
  if (baseline) { writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline)); args.baseline = join(root, 'baseline.json'); }
  const trusted = join(root, 'trusted');
  if (subprocess) {
    cpSync(join(import.meta.dirname, '../../../.claude/skills/verify-tests/scripts'), trusted, { recursive: true });
    const argv = Object.entries(args).flatMap(([k, val]) => [`--${k}`, val]);
    const r = spawnSync(process.execPath, [join(trusted, 'verify.mjs'), 'verify', ...argv], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    if (r.status !== 0) throw new Error(`verify.mjs exited ${r.status}: ${r.stderr}`);
  } else {
    withPath(bin, () => verify(args, sandbox ? { sandbox } : {}));
  }
  const v = JSON.parse(readFileSync(args.out, 'utf8'));
  Object.defineProperty(v, 'trusted', { value: trusted });
  Object.defineProperty(v, 'dir', { value: dir });
  Object.defineProperty(v, 'feedbackText', { value: readFileSync(args.feedback, 'utf8') });
  Object.defineProperty(v, 'root', { value: root });
  return v;
}

test('verify splits off probable-bug files and opens the gate for the rest', () => {
  const v = verifyFixture({});
  assert.deepEqual(v.candidate.map((c) => c.path), ['backend/tests/x.test.ts']);
  assert.match(v.candidate_tree_sha, /^[0-9a-f]{40}$/);
  assert.equal(v.probable_bug_files[0].path, 'backend/tests/x.probable-bug.test.ts');
  assert.equal(v.probable_bug_files[0].failed_runs, 3);
  assert.deepEqual(v.classes.probable_bug, ['wrong comparison']);
  assert.equal(v.gate.publish, true, v.gate.reasons.join('; '));
});

test('verify treats a rerun that exits non-zero with every file passing as infrastructure', () => {
  const v = verifyFixture({ rerunExit: 1 });
  assert.ok(v.classes.infrastructure.some((m) => m.includes('exited 1 with every candidate file passing')));
  assert.equal(v.gate.publish, false);
});

test('verify treats a killed rerun as infrastructure and closes the gate', () => {
  const v = verifyFixture({ killRerun: true });
  assert.ok(v.classes.infrastructure.some((m) => m.includes('was killed (SIGKILL)')), v.classes.infrastructure.join('; '));
  assert.equal(v.gate.publish, false);
});

test('verify treats a killed full suite as infrastructure even with a JSON report', () => {
  const v = verifyFixture({ killFull: true });
  assert.ok(v.classes.infrastructure.some((m) => m.includes('backend: full suite was killed (SIGKILL)')), v.classes.infrastructure.join('; '));
  assert.equal(v.gate.publish, false);
  assert.equal(v.trigger_attempt_2, false);
});

test('verify puts a tsc error in a changed fixture into the attempt-2 feedback', () => {
  const v = verifyFixture({ tscErrors: ["tests/helpers.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'."] }, { fixture: true });
  assert.equal(v.gate.publish, false);
  assert.equal(v.trigger_attempt_2, true);
  assert.match(v.feedbackText, /## tsc errors in other files\nbackend\/tests\/helpers\.ts tsc TS2322 line 1: Type 'number' is not assignable/);
});

test('verify treats a missing coverage summary as infrastructure', () => {
  const v = verifyFixture({ coverage: false });
  assert.ok(v.classes.infrastructure.some((m) => m.includes('coverage-summary.json missing')));
  assert.equal(v.gate.publish, false);
});

test('verify: a test that already failed on head stays open; a new failure or a changed fixture blocks', () => {
  const old = 'tests/old.test.ts';
  const baseline = { head_failing: ['backend/tests/old.test.ts > t'], pr_induced: [], packages: { backend: { head: [{ totals: { tests: 1, passed: 0 } }] } } };
  const open = verifyFixture({ failing: [old] }, { existing: [old], baseline });
  assert.equal(open.gate.publish, true, open.gate.reasons.join('; '));
  assert.deepEqual(open.regressions, []);
  assert.deepEqual(open.packages.backend.suite_before, { tests: 1, passed: 0 });
  const regression = verifyFixture({ failing: [old] }, { existing: [old], baseline: { ...baseline, head_failing: [] } });
  assert.equal(regression.gate.publish, false);
  assert.deepEqual(regression.regressions, ['backend/tests/old.test.ts > t']);
  assert.ok(regression.classes.test_failure.includes('suite failure: backend/tests/old.test.ts'));
  const fixture = verifyFixture({ failing: [old] }, { existing: [old], baseline, fixture: true });
  assert.equal(fixture.gate.publish, false);
  assert.ok(fixture.classes.test_failure.includes('suite failure: backend/tests/old.test.ts'), fixture.classes.test_failure.join('; '));
});

test('indexResults keeps a failed file without a failed assertion as one failed entry', () => {
  const json = { testResults: [{ name: '/r/backend/tests/a.test.ts', status: 'failed', message: 'afterAll hook failed', assertionResults: [{ fullName: 't', status: 'passed', failureMessages: [] }] }] };
  const { tests, files } = indexResults(json, '/r');
  assert.equal(files['backend/tests/a.test.ts'].status, 'failed');
  assert.equal(tests['backend/tests/a.test.ts > (file failed to run)'].status, 'failed');
  assert.equal(tests['backend/tests/a.test.ts > t'].status, 'passed');
});

test('scope scans src directories named like build output, but not package build output', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-walk-'));
  const base = join(root, 'base'), head = join(root, 'head');
  for (const d of [base, head]) mkdirSync(join(d, 'frontend/src/features/coverage'), { recursive: true });
  mkdirSync(join(head, 'frontend/coverage'), { recursive: true });
  writeFileSync(join(base, 'frontend/src/features/coverage/meter.ts'), 'export const a = 1;\n');
  writeFileSync(join(head, 'frontend/src/features/coverage/meter.ts'), 'export const a = 2;\n');
  writeFileSync(join(head, 'frontend/coverage/lcov.info'), 'x\n');
  const out = join(root, 'out');
  const log = console.log;
  console.log = () => {};
  try { assert.equal(scopeMain(['--base', base, '--head', head, '--out', out]), 0); } finally { console.log = log; }
  const scope = JSON.parse(readFileSync(join(out, 'scope.json'), 'utf8'));
  assert.deepEqual(scope.files.map((f) => f.path), ['frontend/src/features/coverage/meter.ts']);
  assert.equal(scope.decision, 'generate');
});

// --- isolation: attacks by PR code (plan: J2 security follow-up) -------------------------------------
// In the workflow PR code runs as a separate OS user that cannot write the trusted scripts, out/ or the
// GITHUB_* files at all (isolate.sh checks that in the log). These tests run as one user (direct sandbox
// mode), so they show the verifier's own defences: it is loaded before PR code runs, it writes its result
// last, it kills every PR process first, and it checks the tree against the recorded identity.

const failing = { failing: ['tests/x.test.ts'] };

test('isolation (a): PR code that overwrites the trusted verifier at install time does not change the result', () => {
  const evil = `\nrequire('node:fs').writeFileSync(require(require('node:path').join(process.cwd(), 'fake.json')).trusted + '/verify.mjs', "import fs from 'node:fs'; fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1], JSON.stringify({ forged: true, gate: { publish: true } }));\\n");\n`;
  const v = verifyFixture({ ...failing, trusted: '$TRUSTED' }, { npmExtra: evil, subprocess: true });
  // The attack did write the copy (same user here); the verifier was already loaded and ignored it.
  assert.match(readFileSync(join(v.trusted, 'verify.mjs'), 'utf8'), /forged: true/);
  assert.equal(v.forged, undefined);
  assert.equal(v.gate.publish, false);
  assert.ok(v.classes.test_failure.length > 0, JSON.stringify(v.classes));
  // PR code never ran in the runner's checkout: it is clean and has no node_modules.
  assert.equal(git(v.dir, 'status', '--porcelain', '--ignored'), '');
  assert.equal(existsSync(join(v.dir, 'backend/node_modules')), false);
});

test('isolation (b): a gate result forged by PR code during the run is replaced by the verifier', () => {
  const v = verifyFixture({ ...failing, attack: 'forge-out', out: '$OUT' });
  assert.equal(v.forged, undefined);
  assert.equal(v.gate.publish, false);
});

test('isolation (c): a candidate changed after its identity was recorded closes the gate', () => {
  const v = verifyFixture({ attack: 'modify-candidate' });
  assert.equal(v.isolation.tree_check, 'changed: backend/tests/x.test.ts');
  assert.ok(v.classes.infrastructure.some((m) => m.startsWith('candidate tree changed while PR code ran (1 file(s)): backend/tests/x.test.ts')), v.classes.infrastructure.join('; '));
  assert.equal(v.gate.publish, false);
  // Without the attack the same fixture publishes.
  assert.equal(verifyFixture({}).gate.publish, true);
});

test('isolation (d): a background process left by a test is killed before the result is written', async () => {
  const v = verifyFixture({ ...failing, attack: 'background', out: '$OUT' });
  assert.equal(v.gate.publish, false);
  // The tamper loop starts 300 ms after the test command and runs for 4 s; nothing may reach the file.
  await new Promise((r) => setTimeout(r, 1500));
  const after = JSON.parse(readFileSync(join(v.root, 'verify.json'), 'utf8'));
  assert.equal(after.forged, undefined);
  assert.equal(after.gate.publish, false);
  assert.equal(existsSync(join(v.root, 'verify.json.tampered')), false);
});

test('isolation: a PR process that cannot be killed fails closed, and the result is still written', () => {
  const root = mkdtempSync(join(tmpdir(), 'stuck-'));
  const stuck = createSandbox({ root: join(root, 'sb'), listPids: () => [2 ** 30] });
  assert.throws(() => stuck.reap(), IsolationError);
  const v = verifyFixture({}, { sandbox: createSandbox({ root: join(root, 'sb2'), listPids: () => [2 ** 30] }) });
  assert.equal(v.gate.publish, false);
  assert.ok(v.classes.infrastructure.some((m) => m.startsWith('isolation failure: processes of the sandbox are still running')), v.classes.infrastructure.join('; '));
});
