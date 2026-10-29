// Tests for report.mjs (final report format, plan 2.11) and gen-status.mjs.
// Run with: node --test .github/test-agent/tests/*.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clean, coverageDelta, loadInputs, render } from '../report.mjs';
import { genStatus } from '../gen-status.mjs';

const B0 = { version: 2, packages: { backend: { base: { exit: 0, totals: { tests: 48, passed: 48 } }, head: [{ exit: 0, totals: { tests: 48, passed: 48 } }], inconclusive: null } }, pr_induced: [], pre_existing: [], flaky: [], new_in_pr: [], inconclusive: [], head_failing: [], coverage_before: { backend: { total: { lines: 80, branches: 70, functions: 90 }, 'backend/src/api/health.ts': { lines: 50, branches: 0, functions: 100 } } } };
const scope = { decision: 'generate', reason: '1 src file(s) changed', merge_base: 'c'.repeat(40), files: [] };
const meta = (attempt, cost) => ({ attempt, init: { model: 'claude-sonnet-5-5' }, skills_invoked: ['analyze-pr-changes', 'backend-unit-tests', 'verify-tests'], files_written: [{ ok: true }], result: { subtype: 'success', total_cost_usd: cost, num_turns: 9, duration_ms: 20000 } });
const verify = (over = {}) => ({
  attempt: 2, gate: { publish: true, reasons: [] }, classes: {}, candidate: [{ path: 'backend/tests/health.test.ts' }], candidate_tree_sha: 'f'.repeat(40),
  files: [{ path: 'backend/tests/health.test.ts', runs: '3/3', tsc_errors: 0, verdict: 'pass' }], probable_bug_files: [],
  packages: { backend: { tsc: { ok: true }, suite: { totals: { tests: 50, passed: 50 } } } }, pr_induced_status: [], regressions: [],
  coverage_after: { backend: { total: { lines: 82.5, branches: 70, functions: 90 }, 'backend/src/api/health.ts': { lines: 100, branches: 100, functions: 100 } } },
  ...over,
});

test('coverage delta compares the baseline with the candidate tree per touched file', () => {
  const rows = coverageDelta(B0.coverage_before, verify().coverage_after);
  assert.deepEqual(rows.map((r) => r.file), ['backend total', 'backend/src/api/health.ts']);
  assert.equal(rows[0].lines, '80% -> 82.5% (+2.5)');
  assert.equal(rows[1].branches, '0% -> 100% (+100)');
  assert.equal(coverageDelta({ backend: { error: 'baseline inconclusive' } }, {})[0].error, 'before: baseline inconclusive');
});

test('report has the 2.11 sections: verdict, skills, files, baseline, verification, coverage delta, cost, SHAs, attempts', () => {
  const { verdict, body } = render({
    attempt: 2, scope, baseline: B0, gen: { status: 'patch' }, metas: [meta(1, 0.05), meta(2, 0.04)],
    result: { decision: 'tests', reason: 'covers the health change', files: [{ path: 'backend/tests/health.test.ts', action: 'added', kind: 'unit' }] },
    guard: { ok: true, edited_existing: [] }, verify: verify(), verify1: { classes: { test_failure: ['backend/tests/health.test.ts: fail (0/3)'] } },
    publish: { status: 'published', commit_sha: 'd'.repeat(40) },
  }, { testedSha: 'e'.repeat(40), runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.equal(verdict.state, 'success');
  for (const s of ['**Verdict:** success', '### Skills invoked', '- attempt 1:', '- attempt 2:', '### Files', '### Baseline', 'merge base 48/48 passed', '### Verification',
    '### Coverage of the touched files (before -> after the candidate tests)', '| `backend/src/api/health.ts` | 50% -> 100% (+50)', '- total agent cost: $0.0900',
    'attempt 2 ran because verify-1 found: backend/tests/health.test.ts: fail (0/3)', 'final attempt 2 of 2', `merge base \`${'c'.repeat(12)}\``, `pushed SHA \`${'d'.repeat(12)}\``]) {
    assert.ok(body.includes(s), `missing: ${s}`);
  }
});

test('report lists open baseline failures and human tests changed', () => {
  const baseline = { ...B0, pre_existing: [{ id: 'backend/tests/a.test.ts > old' }], flaky: [{ id: 'backend/tests/b.test.ts > flaky', head_runs: '2/3 failed' }] };
  const guard = { ok: true, edited_existing: [{ path: 'backend/tests/todos.test.ts', tests_before: 4, tests_after: 4, expects_before: 9, expects_after: 9, removed_lines: ['expect(r.status).toBe(200);'] }] };
  const result = { decision: 'tests', reason: 'r', files: [], human_test_updates: [{ path: 'backend/tests/todos.test.ts', test_name: 'creates', diff_citation: 'backend/src/x.ts:12', before: 'toBe(200)', after: 'toBe(201)' }] };
  const { verdict, body } = render({ attempt: 1, scope, baseline, gen: { status: 'patch' }, metas: [meta(1, 0.05)], result, guard, verify: verify({ attempt: 1 }), publish: { status: 'published', commit_sha: 'd'.repeat(40) } });
  assert.equal(verdict.state, 'failure');
  assert.equal(verdict.class, 'open_failure');
  assert.equal(verdict.published, true);
  assert.ok(body.includes('pre-existing (fails on both sides): `backend/tests/a.test.ts > old`'));
  assert.ok(body.includes('flaky on head (2/3 failed)'));
  assert.ok(body.includes('### Human tests changed'));
  assert.ok(body.includes('test cases 4 -> 4'));
  assert.ok(body.includes('final attempt 1 of 2'));
});

test('report text from the model and tests is neutralised', () => {
  const s = clean('@octocat see [here](https://evil.example) ```x``` <!-- marker');
  assert.ok(!s.includes('@octocat'));
  assert.ok(!s.includes('https://'));
  assert.ok(!s.includes('```'));
  assert.ok(!s.includes('<!--'));
});

test('loadInputs takes attempt 2 when verify-1 asked for it, and names a missing attempt 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  const put = (p, v) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), JSON.stringify(v)); };
  put('scope/scope.json', scope);
  put('baseline/baseline.json', B0);
  put('gen-1/gen.json', { status: 'patch' });
  put('gen-1/run-meta-1.json', meta(1, 0.05));
  put('verify-1/verify1.json', { ...verify({ attempt: 1 }), trigger_attempt_2: true, gate: { publish: false, reasons: ['x'] } });
  const env = { GEN2_JOB: 'failure', VERIFY2_JOB: 'skipped' };
  const missing = loadInputs(dir, env);
  assert.equal(missing.attempt, 2);
  assert.equal(missing.gen, null);
  const v = render(missing).verdict;
  assert.equal(v.class, 'infrastructure');
  assert.match(v.headline, /generate job failure and wrote no gen.json/);
  put('gen-2/gen.json', { status: 'patch' });
  put('gen-2/run-meta-2.json', meta(2, 0.04));
  put('verify-2/verify2.json', verify());
  const full = loadInputs(dir, env);
  assert.equal(full.metas.length, 2);
  assert.equal(full.verify.attempt, 2);
  assert.equal(full.verify1.trigger_attempt_2, true);
});

test('gen-status: order of the generate outcomes', () => {
  const okMeta = { unexpected_skills: [], result: { is_error: false, subtype: 'success' } };
  const result = { decision: 'tests', reason: 'r', probable_bugs: [{ title: 'wrong comparison' }] };
  const base = { scan: 0, agentExit: '0', meta: okMeta, result, guard: { ok: true }, patch: 'diff --git a/x b/x\n', refused: [] };
  assert.equal(genStatus(base).status, 'patch');
  assert.deepEqual(genStatus(base).probable_bugs, ['wrong comparison']);
  assert.deepEqual(genStatus({ ...base, scan: 1 }), { status: 'secret-hit' });
  assert.equal(genStatus({ ...base, meta: { ...okMeta, unexpected_skills: ['design'] } }).status, 'skill-violation');
  assert.match(genStatus({ ...base, agentExit: '124' }).detail, /exit 124/);
  assert.match(genStatus({ ...base, result: null }).detail, /no structured output/);
  assert.equal(genStatus({ ...base, meta: { ...okMeta, result: { is_error: true, subtype: 'error_max_budget_usd' } } }).detail, 'exit 0, result error_max_budget_usd');
  assert.deepEqual(genStatus({ ...base, refused: ['not a regular file: x'] }).violations, ['not a regular file: x']);
  assert.deepEqual(genStatus({ ...base, guard: { ok: false, violations: ['v'] } }).violations, ['v']);
  assert.deepEqual(genStatus({ ...base, guard: null }).violations, ['guard wrote no report']);
  assert.equal(genStatus({ ...base, patch: '' }).status, 'no-op');
});
