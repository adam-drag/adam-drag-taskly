#!/usr/bin/env node
// One verdict per run. The same verdict is the workflow conclusion (report job), the state of the
// test-agent/verified status on a bot commit (publish job) and the first line of the PR comment.
// Node 22, no dependencies.
//
// Classes: success (published, no-op, policy skip, superseded, a bot commit's own verified status),
// test failure (tsc, a failing or flaky test file, a suite failure), probable bug, coverage-threshold
// miss, guard or secret hit, and infrastructure (a job or step that failed or wrote no valid report, a
// generation failure, a publish error, a status write that failed).

// Order used for the headline when several classes apply.
export const ORDER = ['infrastructure', 'guard', 'tsc', 'test_failure', 'probable_bug', 'threshold_miss'];
const LABEL = {
  infrastructure: 'infrastructure',
  guard: 'guard or secret scan',
  tsc: 'type check',
  test_failure: 'test failure',
  probable_bug: 'probable bug',
  threshold_miss: 'coverage threshold',
};

// inputs: { scope, scopeJob, gen, genJob, verify, verifyJob, publish, publishJob, botStatus }
//   *Job: the GitHub job result ('success' | 'failure' | 'cancelled' | 'skipped' | undefined)
//   gen:  gen.json from the generate job; verify: verify.json; publish: publish.json
// publish may be { status: 'pending' } when the publish job asks which status to set.
// botStatus: the test-agent/verified status ({ state, description }) of the head commit when the scope
//   skipped because the head is a bot commit; null when it has none.
export function computeVerdict(i) {
  const notes = [];
  const fail = (cls, stage, detail) => ({ state: 'failure', class: cls, stage, headline: `failure: ${LABEL[cls] ?? cls}${stage ? ` (stage: ${stage})` : ''}${detail ? `: ${detail}` : ''}`, notes, published: false });
  const ok = (cls, detail) => ({ state: 'success', class: cls, stage: null, headline: `success: ${detail}`, notes, published: cls === 'published' });

  if (!i.scope) return fail('infrastructure', 'scope', `scope job ${i.scopeJob ?? 'did not run'} and wrote no scope.json`);
  if (i.scope.decision === 'no-op') return ok('no-op', `no-op, no LLM call (${i.scope.reason})`);
  if (i.scope.decision === 'skip' && i.scope.skip_kind === 'bot-commit') {
    // An approved run on a bot commit takes the state of that commit's own status, or fails without one.
    const s = i.botStatus;
    if (!s) return fail('infrastructure', 'scope', 'head is a test-agent bot commit without a test-agent/verified status');
    const text = `head is a test-agent bot commit; its test-agent/verified status is ${s.state}${s.description ? ` (${s.description})` : ''}`;
    if (s.state === 'success') return ok('bot-commit', text);
    return { state: 'failure', class: 'bot-commit', stage: 'scope', headline: `failure: ${text}`, notes, published: false };
  }
  if (i.scope.decision === 'skip') return ok('skip', `skipped by policy (${i.scope.reason}); nothing is asserted about tests`);
  if (i.scope.decision !== 'generate') return fail('infrastructure', 'scope', `unknown scope decision ${i.scope.decision}`);

  if (!i.gen) return fail('infrastructure', 'generate', `generate job ${i.genJob ?? 'did not run'} and wrote no gen.json`);
  if (i.gen.status === 'secret-hit') return fail('guard', 'generate', 'secret scan hit; outputs withheld');
  if (i.gen.status === 'skill-violation') return fail('guard', 'generate', `Skill call outside the 4 project skills (${(i.gen.unexpected_skills ?? []).join(', ')})`);
  if (i.gen.status === 'agent-error') return fail('infrastructure', 'generate', `agent run failed (${i.gen.detail ?? 'unknown'})`);
  if (i.gen.status === 'guard-fail') return fail('guard', 'generate', (i.gen.violations ?? []).slice(0, 3).join('; '));
  if (i.gen.status === 'no-op' && (i.gen.probable_bugs ?? []).length) return fail('probable_bug', null, `${i.gen.probable_bugs[0]} (no test files written)`);
  if (i.gen.status === 'no-op') return ok('agent-no-op', `agent decided no tests are needed (${i.gen.reason ?? 'no reason given'})`);
  if (i.gen.status !== 'patch') return fail('infrastructure', 'generate', `unexpected generate status ${i.gen.status}`);

  if (!i.verify) return fail('infrastructure', 'verify', `verify job ${i.verifyJob ?? 'did not run'} and wrote no verify.json`);
  const classes = i.verify.classes ?? {};
  const open = ORDER.filter((c) => (classes[c] ?? []).length);
  for (const c of open) notes.push(...classes[c].map((m) => `${LABEL[c]}: ${m}`));

  const gate = i.verify.gate?.publish === true;
  const p = i.publish;
  if (gate) {
    if (!p) return fail('infrastructure', 'publish', `publish job ${i.publishJob ?? 'did not run'} and wrote no publish.json`);
    if (p.status === 'superseded') return { ...ok('superseded', `superseded: the PR head moved (${p.reason ?? 'head changed'}); the newer run reports`), published: false };
    if (p.status !== 'published' && p.status !== 'pending') return fail('infrastructure', 'publish', p.reason ?? p.status);
    if (p.status_error) return { ...fail('infrastructure', 'publish', `tests published, but ${p.status_error}`), published: true };
  }
  if (open.length) {
    const first = open[0];
    const v = fail(first, null, classes[first][0]);
    v.published = gate && p?.status === 'published';
    return v;
  }
  if (!gate) return fail('infrastructure', 'verify', (i.verify.gate?.reasons ?? []).join('; ') || 'publish gate closed without a reason');
  return ok('published', `verified tests published (${i.verify.candidate.length} file(s), tree ${String(i.verify.candidate_tree_sha).slice(0, 12)})`);
}

// Commit status description: at most 140 characters, says the run executed PR code.
export function statusDescription(v) {
  const suffix = ' (run executed PR code)';
  const text = v.headline.replace(/\s+/g, ' ');
  return text.length + suffix.length <= 140 ? `${text}${suffix}` : `${text.slice(0, 140 - suffix.length - 1)}…${suffix}`;
}
