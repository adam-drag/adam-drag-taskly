// Regression tests for the out-of-model gates: guard, scope decision, verdict and publish.
// Run with: node --test .github/test-agent/tests/*.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPatch } from '../../../.claude/skills/verify-tests/scripts/guard.mjs';
import { decide, isBotCommit } from '../../../.claude/skills/analyze-pr-changes/scripts/scope.mjs';
import { computeVerdict, statusDescription } from '../verdict.mjs';
import { checkCandidate, gitBlobSha, publish } from '../publish.mjs';

const newFile = (path, lines) => [
  `diff --git a/${path} b/${path}`,
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((l) => `+${l}`),
  '',
].join('\n');

const modified = (path, removed, added) => [
  `diff --git a/${path} b/${path}`,
  'index 1111111..2222222 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -1,${removed.length} +1,${added.length} @@`,
  ...removed.map((l) => `-${l}`),
  ...added.map((l) => `+${l}`),
  '',
].join('\n');

// --- guard ---------------------------------------------------------------------------------------

test('guard accepts a new backend test file', () => {
  const r = checkPatch(newFile('backend/tests/x.test.ts', ["import { it } from 'vitest';", "it('a', () => {});"]));
  assert.equal(r.ok, true, r.violations.join('; '));
});

test('guard refuses paths outside the allow-list and denied paths', () => {
  assert.equal(checkPatch(newFile('backend/src/api/health.ts', ['x'])).ok, false);
  assert.equal(checkPatch(newFile('.github/workflows/x.yml', ['x'])).ok, false);
  assert.equal(checkPatch(newFile('backend/tests/vitest.config.ts', ['x'])).ok, false);
  assert.equal(checkPatch(newFile('backend/vitest.config.ts', ['x'])).ok, false);
  assert.equal(checkPatch(newFile('frontend/src/app.config.ts', ['x'])).ok, false);
});

test('guard accepts a test file for a config module', () => {
  for (const p of ['backend/tests/config.test.ts', 'frontend/src/lib/config.test.tsx']) {
    const r = checkPatch(newFile(p, ["it('a', () => {});"]));
    assert.equal(r.ok, true, `${p}: ${r.violations.join('; ')}`);
  }
});

test('guard sees a banned modifier on a content line that starts with +++', () => {
  // The diff line is "+++counter; it.skip(...)": a content line, not a file header.
  const r = checkPatch(newFile('backend/tests/x.test.ts', ["++counter; it.skip('a', () => {});"]));
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('banned modifier')));
  assert.equal(r.totals.added, 1);
});

function existingFile(beforeText, afterText) {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  const before = join(root, 'before'), after = join(root, 'after');
  mkdirSync(join(before, 'backend/tests'), { recursive: true });
  mkdirSync(join(after, 'backend/tests'), { recursive: true });
  writeFileSync(join(before, 'backend/tests/x.test.ts'), beforeText);
  writeFileSync(join(after, 'backend/tests/x.test.ts'), afterText);
  return { before, after };
}

test('guard refuses a weakened assertion in an existing test file, declared or not', () => {
  const p = 'backend/tests/x.test.ts';
  const { before, after } = existingFile("it('a', () => { expect(f()).toBe(3); });\n", "it('a', () => { expect(f()).toBeDefined(); });\n");
  const patch = modified(p, ["it('a', () => { expect(f()).toBe(3); });"], ["it('a', () => { expect(f()).toBeDefined(); });"]);
  const undeclared = checkPatch(patch, before, after);
  assert.ok(undeclared.violations.some((v) => v.includes('not in human_test_updates')));
  assert.ok(undeclared.violations.some((v) => v.includes('weak matcher')));
  const declared = checkPatch(patch, before, after, { humanUpdates: [p] });
  assert.ok(!declared.violations.some((v) => v.includes('not in human_test_updates')));
  assert.ok(declared.violations.some((v) => v.includes('weak matcher')));
});

test('guard accepts new tests appended to an existing file, weak matchers included', () => {
  const old = "it('a', () => { expect(f()).toBe(3); });";
  const add = "it('b', () => { expect(g()).toBeUndefined(); });";
  const { before, after } = existingFile(`${old}\n`, `${old}\n${add}\n`);
  const patch = [
    'diff --git a/backend/tests/x.test.ts b/backend/tests/x.test.ts',
    'index 1111111..2222222 100644',
    '--- a/backend/tests/x.test.ts',
    '+++ b/backend/tests/x.test.ts',
    '@@ -1 +1,2 @@',
    ` ${old}`,
    `+${add}`,
    '',
  ].join('\n');
  const r = checkPatch(patch, before, after);
  assert.equal(r.ok, true, r.violations.join('; '));
});

const hunkPatch = (hunks) => [
  'diff --git a/backend/tests/x.test.ts b/backend/tests/x.test.ts', 'index 1111111..2222222 100644',
  '--- a/backend/tests/x.test.ts', '+++ b/backend/tests/x.test.ts', ...hunks.flat(), '',
].join('\n');

test('guard refuses a weak matcher that replaces a property line inside a multi-line toEqual', () => {
  const beforeText = "it('a', () => {\n  expect(f()).toEqual({\n    name: 'Ada',\n  });\n});\n";
  const afterText = "it('a', () => {\n  expect(f()).toEqual({\n    name: expect.any(String),\n  });\n});\n";
  const { before, after } = existingFile(beforeText, afterText);
  const patch = hunkPatch([['@@ -2,3 +2,3 @@', '   expect(f()).toEqual({', "-    name: 'Ada',", '+    name: expect.any(String),', '   });']]);
  for (const humanUpdates of [[], ['backend/tests/x.test.ts']]) {
    const r = checkPatch(patch, before, after, { humanUpdates });
    assert.ok(r.violations.some((v) => v.includes('weak matcher')), r.violations.join('; '));
  }
});

test('guard accepts a declared edit plus a weak-matcher test appended in its own hunk', () => {
  const lines = ["it('a', () => { expect(f()).toBe(3); });", ...Array.from({ length: 8 }, (_, i) => `// ${i}`)];
  const add = "it('b', () => { expect(g()).toBeUndefined(); });";
  const afterLines = ["it('a', () => { expect(f()).toBe(4); });", ...lines.slice(1), add];
  const { before, after } = existingFile(`${lines.join('\n')}\n`, `${afterLines.join('\n')}\n`);
  const patch = hunkPatch([
    ['@@ -1,2 +1,2 @@', `-${lines[0]}`, `+${afterLines[0]}`, ` ${lines[1]}`],
    ['@@ -9 +9,2 @@', ` ${lines[8]}`, `+${add}`],
  ]);
  const r = checkPatch(patch, before, after, { humanUpdates: ['backend/tests/x.test.ts'] });
  assert.equal(r.ok, true, r.violations.join('; '));
});

// --- scope ---------------------------------------------------------------------------------------

const src = { path: 'backend/src/api/health.ts', kind: 'backend-src', added: 3, removed: 1 };
const human = { sha: 'a'.repeat(40), author: 'Adam', subject: 'feat: x' };
const bot = { sha: 'b'.repeat(40), author: 'github-actions[bot]', subject: 'test(agent): add/update unit tests for #2' };

test('scope detects the bot by author and subject prefix', () => {
  assert.equal(isBotCommit(bot), true);
  assert.equal(isBotCommit({ ...bot, author: 'Adam' }), false);
  assert.equal(isBotCommit({ ...bot, subject: 'test: x' }), false);
});

test('scope decisions', () => {
  assert.equal(decide({ files: [src], fork: false, headCommit: human, trustedMissing: [] }).decision, 'generate');
  const b = decide({ files: [src], fork: false, headCommit: bot, trustedMissing: [] });
  assert.equal(b.decision, 'skip');
  assert.equal(b.skip_kind, 'bot-commit');
  assert.equal(decide({ files: [src], fork: true, headCommit: human, trustedMissing: [] }).decision, 'skip');
  assert.match(decide({ files: [src], fork: false, headCommit: human, trustedMissing: ['x'] }).reason, /^bootstrap/);
  assert.equal(decide({ files: [{ path: 'README.md', kind: 'other', added: 1, removed: 0 }], fork: false, headCommit: human, trustedMissing: [] }).decision, 'no-op');
  assert.equal(decide({ files: [src, { path: '.claude/x', kind: 'agent-infra', added: 1, removed: 0 }], fork: false, headCommit: human, trustedMissing: [] }).decision, 'skip');
});

// --- verdict -------------------------------------------------------------------------------------

const gen = { status: 'patch' };
const verifyOk = { gate: { publish: true, reasons: [] }, classes: {}, candidate: [{ path: 'backend/tests/x.test.ts' }], candidate_tree_sha: 'f'.repeat(40) };
const scopeGen = { decision: 'generate' };

test('verdict: published success and probable bug with published tests', () => {
  assert.equal(computeVerdict({ scope: scopeGen, gen, verify: verifyOk, publish: { status: 'published' } }).state, 'success');
  const pb = computeVerdict({ scope: scopeGen, gen, verify: { ...verifyOk, classes: { probable_bug: ['bug'] } }, publish: { status: 'published' } });
  assert.equal(pb.state, 'failure');
  assert.equal(pb.class, 'probable_bug');
  assert.equal(pb.published, true);
});

test('verdict: closed gate, superseded, status write failure', () => {
  const closed = computeVerdict({ scope: scopeGen, gen, verify: { ...verifyOk, gate: { publish: false, reasons: [] }, classes: { test_failure: ['x: fail'] } } });
  assert.equal(closed.class, 'test_failure');
  assert.equal(computeVerdict({ scope: scopeGen, gen, verify: verifyOk, publish: { status: 'superseded' } }).state, 'success');
  const st = computeVerdict({ scope: scopeGen, gen, verify: verifyOk, publish: { status: 'published', status_error: 'set status: HTTP 500' } });
  assert.equal(st.state, 'failure');
  assert.equal(st.class, 'infrastructure');
});

test('verdict: agent no-op with a probable bug is a failure', () => {
  assert.equal(computeVerdict({ scope: scopeGen, gen: { status: 'no-op' } }).state, 'success');
  const v = computeVerdict({ scope: scopeGen, gen: { status: 'no-op', probable_bugs: ['wrong comparison'] } });
  assert.equal(v.state, 'failure');
  assert.equal(v.class, 'probable_bug');
});

test('verdict: a bot-commit run copies the commit status and fails without one', () => {
  const scope = { decision: 'skip', skip_kind: 'bot-commit', reason: 'bot' };
  assert.equal(computeVerdict({ scope, botStatus: { state: 'success', description: 'ok' } }).state, 'success');
  assert.equal(computeVerdict({ scope, botStatus: { state: 'failure', description: 'probable bug' } }).state, 'failure');
  assert.equal(computeVerdict({ scope, botStatus: null }).state, 'failure');
  assert.equal(computeVerdict({ scope: { decision: 'skip', reason: 'fork' } }).state, 'success');
});

test('verdict: missing reports are infrastructure failures', () => {
  assert.equal(computeVerdict({}).class, 'infrastructure');
  assert.equal(computeVerdict({ scope: scopeGen }).class, 'infrastructure');
  assert.equal(computeVerdict({ scope: scopeGen, gen }).class, 'infrastructure');
  assert.equal(computeVerdict({ scope: scopeGen, gen, verify: verifyOk }).class, 'infrastructure');
});

test('status description stays within 140 characters', () => {
  const d = statusDescription({ headline: `failure: probable bug: ${'x'.repeat(300)}` });
  assert.ok(d.length <= 140);
  assert.ok(d.endsWith('(run executed PR code)'));
});

// --- publish -------------------------------------------------------------------------------------

const TESTED = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const PATH = 'backend/tests/x.test.ts';
const BYTES = Buffer.from("import { it } from 'vitest';\nit('a', () => {});\n");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  mkdirSync(join(dir, 'backend/tests'), { recursive: true });
  writeFileSync(join(dir, PATH), BYTES);
  const verify = { gate: { publish: true }, tested_head_sha: TESTED, candidate_tree_sha: TREE, candidate: [{ path: PATH, mode: '100644', blob_sha: gitBlobSha(BYTES), size: BYTES.length }], classes: {} };
  const patchText = newFile(PATH, ["import { it } from 'vitest';", "it('a', () => {});"]) + newFile('backend/tests/x.probable-bug.test.ts', ["it('b', () => {});"]);
  return { dir, verify, patchText };
}

test('checkCandidate accepts the verified candidate and leaves probable-bug files out', () => {
  const { dir, verify, patchText } = fixture();
  const r = checkCandidate({ verify, candidateDir: dir, patchText, testedSha: TESTED });
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.files.map((f) => f.path), [PATH]);
});

test('checkCandidate refuses changed bytes, a stale tested SHA, extra paths and symlinks', () => {
  const { dir, verify, patchText } = fixture();
  writeFileSync(join(dir, PATH), Buffer.concat([BYTES, Buffer.from('// changed\n')]));
  assert.ok(checkCandidate({ verify, candidateDir: dir, patchText, testedSha: TESTED }).reasons.some((r) => r.includes('differs from verified blob')));
  assert.ok(checkCandidate({ verify, candidateDir: dir, patchText, testedSha: 'e'.repeat(40) }).reasons.some((r) => r.includes('this run tests')));
  const extra = structuredClone(verify);
  extra.candidate.push({ path: 'backend/tests/y.test.ts', mode: '100644', blob_sha: '0'.repeat(40) });
  assert.ok(checkCandidate({ verify: extra, candidateDir: dir, patchText, testedSha: TESTED }).reasons.some((r) => r.includes('differs from the agent patch')));
  const link = fixture();
  writeFileSync(join(link.dir, 'target.ts'), BYTES);
  rmSync(join(link.dir, PATH));
  symlinkSync(join(link.dir, 'target.ts'), join(link.dir, PATH));
  assert.ok(checkCandidate({ verify: link.verify, candidateDir: link.dir, patchText: link.patchText, testedSha: TESTED }).reasons.some((r) => r.includes('symlinks are refused')));
});

function mockApi({ head = TESTED, tree = TREE, refStatus = 200, statusHttp = 201 } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/pulls/')) return { status: 200, json: { head: { sha: head, ref: 'feat/x' } } };
    if (path.startsWith('/git/commits/')) return { status: 200, json: { tree: { sha: 'base' } } };
    if (path === '/git/blobs') return { status: 201, json: { sha: gitBlobSha(Buffer.from(body.content, 'base64')) } };
    if (path === '/git/trees') return { status: 201, json: { sha: tree } };
    if (path === '/git/commits') return { status: 201, json: { sha: '9'.repeat(40), tree: { sha: body.tree }, parents: body.parents.map((sha) => ({ sha })), author: body.author, message: body.message } };
    if (path.startsWith('/git/refs/heads/')) return refStatus === 200 ? { status: 200, json: {} } : { status: refStatus, json: { message: 'Update is not a fast forward' } };
    if (path.startsWith('/statuses/')) return { status: statusHttp, json: {} };
    return { status: 404, json: null };
  };
  return { api, calls };
}

async function runPublish(opts) {
  const { dir, verify, patchText } = fixture();
  const { files } = checkCandidate({ verify, candidateDir: dir, patchText, testedSha: TESTED });
  const { api, calls } = mockApi(opts);
  const out = await publish({ api, verify, files, testedSha: TESTED, branch: 'feat/x', prNumber: '8', runUrl: 'https://example/run', verdictInputs: { scope: scopeGen, gen, verify } });
  return { out, calls };
}

test('publish writes one bot commit on the tested SHA with force false and sets the status', async () => {
  const { out, calls } = await runPublish();
  assert.equal(out.status, 'published');
  const commit = calls.find((c) => c.method === 'POST' && c.path === '/git/commits');
  assert.deepEqual(commit.body.parents, [TESTED]);
  assert.equal(commit.body.author.name, 'github-actions[bot]');
  assert.equal(commit.body.message, 'test(agent): add/update unit tests for #8');
  assert.equal(calls.find((c) => c.method === 'PATCH').body.force, false);
  assert.equal(out.commit_status.state, 'success');
});

test('publish stops when the head moved, when the tree differs, and on a refused ref update', async () => {
  assert.equal((await runPublish({ head: 'e'.repeat(40) })).out.status, 'superseded');
  const tree = await runPublish({ tree: 'a'.repeat(40) });
  assert.equal(tree.out.status, 'error');
  assert.ok(!tree.calls.some((c) => c.path === '/git/commits' && c.method === 'POST'));
  assert.equal((await runPublish({ refStatus: 422 })).out.status, 'superseded');
});

test('publish records a failed status write', async () => {
  const { out } = await runPublish({ statusHttp: 500 });
  assert.equal(out.status, 'published');
  assert.match(out.status_error, /HTTP 500/);
});

test('publish records a status write that throws after the ref moved', async () => {
  const { dir, verify, patchText } = fixture();
  const { files } = checkCandidate({ verify, candidateDir: dir, patchText, testedSha: TESTED });
  const { api } = mockApi();
  const throwing = async (method, path, body) => {
    if (path.startsWith('/statuses/')) throw new Error('network down');
    return api(method, path, body);
  };
  const out = await publish({ api: throwing, verify, files, testedSha: TESTED, branch: 'feat/x', prNumber: '8', runUrl: 'u', verdictInputs: { scope: scopeGen, gen, verify } });
  assert.equal(out.status, 'published');
  assert.match(out.status_error, /network down/);
});
