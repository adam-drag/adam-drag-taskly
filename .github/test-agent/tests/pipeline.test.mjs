// Regression tests for scope main(), verify() and the report's bot-commit path, on small fixtures.
// verify() runs a fake vitest and tsc from the fixture's node_modules/.bin, so no real install is needed.
// Run with: node --test .github/test-agent/tests/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main as scopeMain } from '../../../.claude/skills/analyze-pr-changes/scripts/scope.mjs';
import { verify } from '../../../.claude/skills/verify-tests/scripts/verify.mjs';
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
  const failed = f.includes('.probable-bug.');
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
if (isRerun && cfg.killRerun) process.kill(process.pid, 'SIGKILL');
process.exit(failedN ? 1 : isRerun ? (cfg.rerunExit ?? 0) : 0);
`;

const newFile = (path, lines) => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), '',
].join('\n');

function verifyFixture(fake) {
  const root = mkdtempSync(join(tmpdir(), 'verify-'));
  const dir = join(root, 'work'), files = join(root, 'files'), work = join(root, 'scratch');
  mkdirSync(join(dir, 'backend/tests'), { recursive: true });
  mkdirSync(join(dir, 'backend/node_modules/.bin'), { recursive: true });
  writeFileSync(join(dir, 'backend/package.json'), '{}\n');
  git(dir, 'init', '-q');
  git(dir, 'add', 'backend/package.json');
  commit(dir, 'Adam', 'base');
  writeFileSync(join(dir, 'backend/fake.json'), JSON.stringify(fake));
  writeFileSync(join(dir, 'backend/node_modules/.bin/vitest'), FAKE_VITEST);
  writeFileSync(join(dir, 'backend/node_modules/.bin/tsc'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'backend/node_modules/.bin/vitest'), 0o755);
  chmodSync(join(dir, 'backend/node_modules/.bin/tsc'), 0o755);
  const good = 'backend/tests/x.test.ts', pb = 'backend/tests/x.probable-bug.test.ts';
  mkdirSync(join(files, 'backend/tests'), { recursive: true });
  writeFileSync(join(files, good), "it('a', () => {});\n");
  writeFileSync(join(files, pb), "it('b', () => {});\n");
  writeFileSync(join(root, 'patch.diff'), newFile(good, ["it('a', () => {});"]) + newFile(pb, ["it('b', () => {});"]));
  writeFileSync(join(root, 'scope.json'), JSON.stringify({ packages: ['backend'], files: [] }));
  writeFileSync(join(root, 'guard.json'), JSON.stringify({ ok: true, violations: [] }));
  writeFileSync(join(root, 'result.json'), JSON.stringify({ probable_bugs: [{ title: 'wrong comparison', test_file: pb }] }));
  const args = { dir, files, work, patch: join(root, 'patch.diff'), scope: join(root, 'scope.json'), guard: join(root, 'guard.json'), result: join(root, 'result.json'), attempt: '1', out: join(root, 'verify.json') };
  const log = console.log;
  console.log = () => {};
  try { verify(args); } finally { console.log = log; }
  return JSON.parse(readFileSync(args.out, 'utf8'));
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

test('verify treats a missing coverage summary as infrastructure', () => {
  const v = verifyFixture({ coverage: false });
  assert.ok(v.classes.infrastructure.some((m) => m.includes('coverage-summary.json missing')));
  assert.equal(v.gate.publish, false);
});
