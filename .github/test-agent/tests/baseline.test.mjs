// Tests for the baseline classifier (plan 2.7) and the full verdict table (plan 2.10).
// Run with: node --test .github/test-agent/tests/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPackage, prInducedMarkdown, runProblem } from '../baseline.mjs';
import { computeVerdict } from '../verdict.mjs';

const T = (status, failure = '') => ({ status, failure });
const ok = (tests) => ({ problem: null, tests });

// --- classifier ----------------------------------------------------------------------------------

test('baseline classes: PR-induced, pre-existing, flaky, new in PR', () => {
  const base = ok({ 'a > induced': T('passed'), 'a > pre': T('failed'), 'a > flaky': T('passed'), 'a > ok': T('passed') });
  const head = [
    ok({ 'a > induced': T('failed', 'expected 1'), 'a > pre': T('failed'), 'a > flaky': T('failed'), 'a > new': T('failed'), 'a > ok': T('passed') }),
    ok({ 'a > induced': T('failed'), 'a > pre': T('failed'), 'a > flaky': T('passed'), 'a > new': T('failed') }),
    ok({ 'a > induced': T('failed'), 'a > pre': T('failed'), 'a > flaky': T('failed'), 'a > new': T('failed') }),
  ];
  const c = classifyPackage({ pkg: 'backend', base, head });
  assert.equal(c.inconclusive, null);
  assert.deepEqual(c.pr_induced.map((t) => t.id), ['a > induced']);
  assert.equal(c.pr_induced[0].head_runs, '3/3 failed');
  assert.deepEqual(c.pre_existing.map((t) => t.id), ['a > pre']);
  assert.deepEqual(c.flaky.map((t) => t.id), ['a > flaky']);
  assert.deepEqual(c.new_in_pr.map((t) => t.id), ['a > new']);
  assert.deepEqual(c.head_failing.sort(), ['a > flaky', 'a > induced', 'a > new', 'a > pre']);
});

test('baseline: a test missing from a head rerun is not PR-induced', () => {
  const c = classifyPackage({ pkg: 'backend', base: ok({ 'a > t': T('passed') }), head: [ok({ 'a > t': T('failed') }), ok({}), ok({ 'a > t': T('failed') })] });
  assert.deepEqual(c.pr_induced, []);
  assert.equal(c.flaky.length, 1);
  assert.match(c.flaky[0].note, /2 of 3 results/);
});

test('baseline: a failed install makes the package inconclusive and classifies nothing', () => {
  const c = classifyPackage({ pkg: 'frontend', base: null, head: [], installProblem: 'frontend merge base: npm ci failed' });
  assert.match(c.inconclusive, /frontend: frontend merge base: npm ci failed/);
  assert.deepEqual([...c.pr_induced, ...c.pre_existing, ...c.flaky, ...c.new_in_pr], []);
});

test('baseline: a missing report or a killed run on either side is inconclusive', () => {
  assert.equal(runProblem({ status: 1, signal: null, json: null }), 'wrote no JSON report (exit 1)');
  assert.equal(runProblem({ status: null, signal: 'SIGTERM', json: { testResults: [] } }), 'killed (SIGTERM)');
  assert.equal(runProblem({ status: 1, signal: null, json: { testResults: [] } }), null);
  const missing = classifyPackage({ pkg: 'backend', base: { problem: 'wrote no JSON report (exit 1)', tests: {} }, head: [ok({ 'a > t': T('failed') }), ok({ 'a > t': T('failed') }), ok({ 'a > t': T('failed') })] });
  assert.match(missing.inconclusive, /merge base suite wrote no JSON report/);
  assert.deepEqual(missing.pr_induced, []);
  const killed = classifyPackage({ pkg: 'backend', base: ok({ 'a > t': T('passed') }), head: [ok({ 'a > t': T('failed') }), { problem: 'killed (SIGKILL)', tests: {} }] });
  assert.match(killed.inconclusive, /head run 2 killed/);
});

test('pr-induced.md marks the content as untrusted data and caps it', () => {
  const md = prInducedMarkdown([{ id: 'backend/tests/a.test.ts > t', package: 'backend', on_base: 'passed', failure: `AssertionError: ${'x'.repeat(20000)}\n    at backend/tests/a.test.ts:3:1` }]);
  assert.match(md, /UNTRUSTED DATA/);
  assert.ok(md.length < 4 * 1024, `length ${md.length}`);
  assert.match(prInducedMarkdown([]), /None\./);
});

// --- verdict table -------------------------------------------------------------------------------

const B0 = { pr_induced: [], pre_existing: [], flaky: [], new_in_pr: [], inconclusive: [], head_failing: [] };
const gen = { status: 'patch' };
const scopeGen = { decision: 'generate', reason: 'src changed' };
const verifyOk = { gate: { publish: true, reasons: [] }, classes: {}, candidate: [{ path: 'backend/tests/x.test.ts' }], candidate_tree_sha: 'f'.repeat(40) };
const published = { status: 'published' };

test('verdict: policy skips are success and assert nothing about tests', () => {
  for (const kind of ['bootstrap', 'infra-edit', 'size-cap']) {
    const v = computeVerdict({ scope: { decision: 'skip', skip_kind: kind, reason: kind } });
    assert.equal(v.state, 'success', kind);
    assert.match(v.headline, /nothing is asserted about tests/);
  }
  assert.equal(computeVerdict({ scope: { decision: 'no-op', reason: 'docs only' } }).state, 'success');
});

test('verdict: a fork PR runs the baseline; failures on head make it a failure', () => {
  const scope = { decision: 'skip', skip_kind: 'fork', reason: 'fork PR' };
  assert.equal(computeVerdict({ scope, baseline: B0 }).state, 'success');
  const v = computeVerdict({ scope, baseline: { ...B0, pre_existing: [{ id: 'a > t' }] } });
  assert.equal(v.state, 'failure');
  assert.match(v.headline, /fork PR, generation skipped; pre-existing failure on head: a > t/);
  assert.equal(computeVerdict({ scope }).class, 'infrastructure');
});

test('verdict: no merge base fails closed with the reason', () => {
  const v = computeVerdict({ scope: { decision: 'error', reason: 'no merge base: git merge-base exited 1' } });
  assert.equal(v.state, 'failure');
  assert.equal(v.stage, 'scope');
  assert.match(v.headline, /git merge-base exited 1/);
});

test('verdict: an inconclusive or missing baseline is an infrastructure failure with the stage', () => {
  const v = computeVerdict({ scope: scopeGen, baseline: { ...B0, inconclusive: ['backend: backend head: npm ci failed'] }, gen, verify: verifyOk, publish: published });
  assert.equal(v.class, 'infrastructure');
  assert.equal(v.stage, 'baseline');
  assert.match(v.headline, /npm ci failed/);
  const missing = computeVerdict({ scope: scopeGen, baselineJob: 'failure', gen, verify: verifyOk, publish: published });
  assert.match(missing.headline, /baseline job failure and wrote no baseline.json/);
});

test('verdict: published tests with open failures on head are a failure', () => {
  const pre = computeVerdict({ scope: scopeGen, baseline: { ...B0, pre_existing: [{ id: 'a > t' }] }, gen, verify: verifyOk, publish: published });
  assert.equal(pre.state, 'failure');
  assert.equal(pre.class, 'open_failure');
  assert.equal(pre.published, true);
  const induced = computeVerdict({ scope: scopeGen, baseline: { ...B0, pr_induced: [{ id: 'a > t' }] }, gen, verify: { ...verifyOk, classes: { open_failure: ['PR-induced failure still open: a > t'] } }, publish: published });
  assert.equal(induced.class, 'open_failure');
  // A PR-induced failure that verify saw fixed (no open_failure entry) does not stay open.
  assert.equal(computeVerdict({ scope: scopeGen, baseline: { ...B0, pr_induced: [{ id: 'a > t' }] }, gen, verify: verifyOk, publish: published }).state, 'success');
});

test('verdict: agent no-op is a failure when tests fail on head', () => {
  const v = computeVerdict({ scope: scopeGen, baseline: { ...B0, pr_induced: [{ id: 'a > t' }] }, gen: { status: 'no-op' } });
  assert.equal(v.state, 'failure');
  assert.match(v.headline, /agent wrote no tests; PR-induced failure on head: a > t/);
});

test('verdict: the headline follows the 2.10 order', () => {
  const classes = { threshold_miss: ['coverage threshold missed in backend'], probable_bug: ['bug'], tsc: ['tsc fails in backend'], infrastructure: [], guard: [] };
  const v = computeVerdict({ scope: scopeGen, baseline: B0, gen, verify: { ...verifyOk, gate: { publish: false, reasons: ['tsc'] }, classes } });
  assert.equal(v.class, 'tsc');
  assert.equal(v.notes.length, 3);
  const t = computeVerdict({ scope: scopeGen, baseline: B0, gen, verify: { ...verifyOk, classes: { threshold_miss: ['coverage threshold missed in backend'] } }, publish: published });
  assert.equal(t.class, 'threshold_miss');
  assert.equal(t.published, true);
  assert.match(t.headline, /^failure: coverage threshold/);
});

test('verdict: generation failures name the stage', () => {
  for (const [g, cls] of [[{ status: 'agent-error', detail: 'exit 1, result error_max_budget_usd' }, 'infrastructure'], [{ status: 'secret-hit' }, 'guard'], [{ status: 'guard-fail', violations: ['x'] }, 'guard'], [{ status: 'skill-violation', unexpected_skills: ['design'] }, 'guard']]) {
    const v = computeVerdict({ scope: scopeGen, baseline: B0, gen: g });
    assert.equal(v.class, cls, g.status);
    assert.equal(v.stage, 'generate');
  }
});
