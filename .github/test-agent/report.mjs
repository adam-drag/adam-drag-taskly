#!/usr/bin/env node
// Run metadata extraction, PR report rendering and the sticky comment. Node 22, no dependencies.
//
//   node report.mjs extract-meta --stream <stream.jsonl> --attempt <n> --out <run-meta.json> [--result-out <result.json>]
//   node report.mjs render --dir <artifacts dir> --out <report.md> --verdict-out <verdict.json>
//        artifacts dir holds scope/, baseline/, gen-1/, verify-1/, gen-2/, verify-2/, publish/ (each optional)
//        env: SCOPE_JOB, BASELINE_JOB, GEN_JOB, VERIFY_JOB, GEN2_JOB, VERIFY2_JOB, PUBLISH_JOB (job results),
//             TESTED_SHA, RUN_URL
//   node report.mjs post --body <report.md> --published-sha <sha|''>
//        env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, TESTED_SHA
//
// All numbers come from the JSON files the scripts wrote, not from model text. Model and test text is
// capped, fenced, has @-mentions neutralised and links stripped. The body passes the secret scan first.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanText, secretLiterals } from '../../.claude/skills/verify-tests/scripts/guard.mjs';
import { computeVerdict } from './verdict.mjs';

export const MARKER = '<!-- test-agent:report -->';
export const PROJECT_SKILLS = ['analyze-pr-changes', 'backend-unit-tests', 'frontend-unit-tests', 'verify-tests'];
const readJson = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function parseArgs(argv) {
  const args = { mode: argv[0] };
  for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  return args;
}

export function extractMeta(streamText) {
  const meta = { init: null, skills_invoked: [], unexpected_skills: [], tool_calls: {}, files_written: [], denied_tool_results: [], result: null };
  const pending = new Map();
  for (const line of streamText.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      meta.init = { model: ev.model, permissionMode: ev.permissionMode, tools: ev.tools, skills: ev.skills, agents: ev.agents, mcp_servers: ev.mcp_servers, claude_code_version: ev.claude_code_version, apiKeySource: ev.apiKeySource };
    }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_use') continue;
        meta.tool_calls[c.name] = (meta.tool_calls[c.name] ?? 0) + 1;
        if (c.name === 'Skill') {
          const s = String(c.input?.skill ?? c.input?.command ?? c.input?.name ?? JSON.stringify(c.input));
          meta.skills_invoked.push(s);
          if (!PROJECT_SKILLS.includes(s)) meta.unexpected_skills.push(s);
        }
        pending.set(c.id, { tool: c.name, path: c.input?.file_path ?? c.input?.path ?? null });
      }
    }
    if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const call = pending.get(c.tool_use_id);
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join(' ');
        if (call && (call.tool === 'Edit' || call.tool === 'Write')) meta.files_written.push({ ...call, ok: !c.is_error });
        if (c.is_error && /denied|not allowed|permission|outside/i.test(text)) meta.denied_tool_results.push({ tool: call?.tool, path: call?.path });
      }
    }
    if (ev.type === 'result') {
      meta.result = {
        subtype: ev.subtype, is_error: ev.is_error, total_cost_usd: ev.total_cost_usd, num_turns: ev.num_turns,
        duration_ms: ev.duration_ms, duration_api_ms: ev.duration_api_ms, usage: ev.usage, model_usage: ev.modelUsage,
        permission_denials: (ev.permission_denials ?? []).map((d) => ({ tool_name: d.tool_name, path: d.tool_input?.file_path ?? d.tool_input?.path ?? null })),
        has_structured_output: ev.structured_output != null, errors: ev.errors,
      };
      meta.structured_output = ev.structured_output ?? null;
    }
  }
  return meta;
}

// Sanitising for model- and test-authored text.
export function clean(text, cap = 1500) {
  let s = String(text ?? '');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\bhttps?:\/\/\S+/gi, '[link removed]').replace(/\bwww\.\S+/gi, '[link removed]');
  s = s.replace(/@/g, '@​').replace(/```/g, "'''").replace(/<!--/g, '<!-');
  return s.length > cap ? `${s.slice(0, cap)}… [truncated]` : s;
}
const cell = (t, cap = 300) => clean(t, cap).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fence = (t, cap) => `\`\`\`text\n${clean(t, cap)}\n\`\`\``;
const short = (s) => (s ? String(s).slice(0, 12) : 'n/a');

// The final attempt is 2 when verify-1 asked for it (trigger_attempt_2), even if the attempt-2 jobs then
// failed or wrote nothing: the verdict must then name attempt 2, not fall back to attempt 1.
export function loadInputs(dir, env = process.env) {
  const verify1 = readJson(join(dir, 'verify-1/verify1.json'));
  const attempt = verify1?.trigger_attempt_2 === true ? 2 : 1;
  const metas = [1, 2].map((n) => readJson(join(dir, `gen-${n}/run-meta-${n}.json`))).filter(Boolean);
  return {
    attempt,
    scope: readJson(join(dir, 'scope/scope.json')),
    scopeJob: env.SCOPE_JOB,
    baseline: readJson(join(dir, 'baseline/baseline.json')),
    baselineJob: env.BASELINE_JOB,
    gen: readJson(join(dir, `gen-${attempt}/gen.json`)),
    genJob: attempt === 2 ? env.GEN2_JOB : env.GEN_JOB,
    result: readJson(join(dir, `gen-${attempt}/result${attempt}.json`)),
    meta: metas.at(-1) ?? null,
    metas,
    guard: readJson(join(dir, `gen-${attempt}/guard${attempt}.json`)),
    verify: readJson(join(dir, `verify-${attempt}/verify${attempt}.json`)),
    verifyJob: attempt === 2 ? env.VERIFY2_JOB : env.VERIFY_JOB,
    verify1: attempt === 2 ? verify1 : null,
    publish: readJson(join(dir, 'publish/publish.json')),
    publishJob: env.PUBLISH_JOB,
  };
}

// Coverage rows: before = head without the candidate tests (baseline), after = the candidate tree (verify).
export function coverageDelta(before = {}, after = {}) {
  const rows = [];
  const fmt = (b, a) => (b == null && a == null ? 'n/a' : `${b == null ? 'n/a' : `${b}%`} -> ${a == null ? 'n/a' : `${a}%`}${b != null && a != null ? ` (${a - b >= 0 ? '+' : ''}${Math.round((a - b) * 100) / 100})` : ''}`);
  for (const pkg of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    const b = before?.[pkg] ?? {}, a = after?.[pkg] ?? {};
    const err = [b.error && `before: ${b.error}`, a.error && `after: ${a.error}`].filter(Boolean).join('; ');
    if (err) { rows.push({ file: `${pkg} total`, error: err }); continue; }
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort((x, y) => (x === 'total' ? -1 : y === 'total' ? 1 : x.localeCompare(y)));
    for (const k of keys) {
      const cb = b[k] ?? null, ca = a[k] ?? null;
      rows.push({ file: k === 'total' ? `${pkg} total` : k, lines: fmt(cb?.lines, ca?.lines), branches: fmt(cb?.branches, ca?.branches), functions: fmt(cb?.functions, ca?.functions) });
    }
  }
  return rows;
}

export function render(i, { testedSha, runUrl } = {}) {
  const v = computeVerdict(i);
  const out = [MARKER, '## Test agent report', ''];
  out.push(`**Verdict:** ${cell(v.headline, 500)}`);
  if (i.scope) out.push(`**Scope decision:** \`${i.scope.decision}\`: ${cell(i.scope.reason, 400)}`);
  if (i.result) out.push(`**Agent decision:** \`${cell(i.result.decision, 20)}\`: ${cell(i.result.reason, 600)}`);
  out.push('');
  if (v.notes.length > 1) out.push('**Open items:**', ...v.notes.slice(0, 20).map((n) => `- ${cell(n, 300)}`), '');

  if (i.scope && i.scope.decision !== 'generate') {
    out.push(`Changed files: ${i.scope.files.map((f) => `\`${cell(f.path, 160)}\` (${f.kind})`).join(', ') || 'none'}.`, '');
  }
  const metas = i.metas ?? (i.meta ? [i.meta] : []);
  if (metas.length) {
    out.push('### Skills invoked (from the run transcript)');
    for (const m of metas) {
      out.push(`- attempt ${m.attempt ?? 1}: ${m.skills_invoked?.length ? m.skills_invoked.map((s) => `\`${cell(s, 60)}\``).join(', ') : 'none recorded'}`);
      const wroteTests = (m.files_written ?? []).some((f) => f.ok);
      const stackSkill = (m.skills_invoked ?? []).some((s) => s === 'backend-unit-tests' || s === 'frontend-unit-tests');
      if (wroteTests && !stackSkill) out.push(`- warning: attempt ${m.attempt ?? 1} wrote test files without a stack skill call`);
    }
    out.push('');
  }
  const ver = i.verify;
  if (ver) {
    const kinds = new Map((i.result?.files ?? []).map((f) => [f.path, `${f.action}/${f.kind}`]));
    out.push('### Files', '', '| File | Agent says | Runs | tsc errors | Verdict |', '|---|---|---|---|---|');
    for (const f of ver.files) out.push(`| \`${cell(f.path, 160)}\` | ${cell(kinds.get(f.path) ?? 'n/a', 40)} | ${f.runs} | ${f.tsc_errors} | ${f.verdict} |`);
    for (const p of ver.probable_bug_files) out.push(`| \`${cell(p.path, 160)}\` | probable-bug repro | ${p.runs == null ? 'n/a' : `${p.runs - p.failed_runs}/${p.runs} passed`} | | kept off the branch |`);
    if (!ver.files.length && !ver.probable_bug_files.length) out.push('| (no files) | | | | |');
    out.push('');
  }
  const edited = (i.guard?.edited_existing ?? []).filter((e) => e.removed_lines.length);
  if (edited.length || i.result?.human_test_updates?.length) {
    out.push('### Human tests changed');
    for (const e of edited) {
      out.push(`- \`${cell(e.path, 160)}\`: test cases ${e.tests_before} -> ${e.tests_after}, \`expect(\` ${e.expects_before} -> ${e.expects_after}. Removed lines (from the patch):`);
      out.push(fence(e.removed_lines.join('\n'), 800));
    }
    for (const u of i.result?.human_test_updates ?? []) {
      out.push(`- agent: \`${cell(u.path, 120)}\` "${cell(u.test_name, 120)}" cites ${cell(u.diff_citation, 120)}`);
      out.push(fence(`before: ${u.before}\nafter:  ${u.after}`, 800));
    }
    out.push('');
  }
  const bl = i.baseline;
  if (bl) {
    out.push('### Baseline (existing tests on the PR head and on the merge base)');
    for (const [pkg, p] of Object.entries(bl.packages ?? {})) {
      const t = (x) => (x?.totals ? `${x.totals.passed}/${x.totals.tests} passed` : `no report (exit ${x?.exit ?? 'n/a'}${x?.signal ? `, ${x.signal}` : ''})`);
      out.push(`- ${pkg}: merge base ${p.base ? t(p.base) : 'not run'}; head ${p.head?.length ? t(p.head[0]) : 'not run'}${p.head?.length > 1 ? `, failing files rerun ${p.head.length - 1} more time(s)` : ''}${p.inconclusive ? `; inconclusive: ${cell(p.inconclusive, 200)}` : ''}`);
    }
    const lines = [
      ...(bl.pr_induced ?? []).map((x) => `PR-induced (fails 3/3 on head, passes on merge base): \`${cell(x.id, 200)}\``),
      ...(bl.pre_existing ?? []).map((x) => `pre-existing (fails on both sides): \`${cell(x.id, 200)}\``),
      ...(bl.flaky ?? []).map((x) => `flaky on head (${cell(x.head_runs, 20)}): \`${cell(x.id, 200)}\``),
      ...(bl.new_in_pr ?? []).map((x) => `new in PR, fails on head: \`${cell(x.id, 200)}\``),
    ];
    out.push(...(lines.length ? lines.slice(0, 20).map((l) => `- ${l}`) : ['- no failing test on head']), '');
  }
  if (ver || i.guard) {
    out.push('### Verification');
    if (i.guard) out.push(`- Guard: ${i.guard.ok ? 'OK' : `FAILED: ${(i.guard.violations ?? []).map((x) => cell(x, 160)).join('; ')}`}`);
    for (const [pkg, p] of Object.entries(ver?.packages ?? {})) {
      const t = p.suite.totals;
      out.push(`- ${pkg}: tsc ${p.tsc.ok ? 'OK' : `FAIL (${p.tsc.errors} errors)`}; suite with the candidate tests ${t ? `${t.passed}/${t.tests} passed` : 'no report'}; each candidate file ran 3 times${p.threshold_miss ? '; coverage threshold missed' : ''}`);
    }
    for (const p of ver?.pr_induced_status ?? []) out.push(`- PR-induced \`${cell(p.id, 200)}\`: now ${cell(p.now, 20)}, agent action ${cell(p.agent_action ?? 'none', 20)}${p.open ? ' (still open)' : ''}`);
    if (ver?.regressions?.length) out.push(`- Tests that passed in the head baseline and fail with the candidate tests: ${ver.regressions.slice(0, 10).map((r) => `\`${cell(r, 160)}\``).join(', ')}`);
    if (ver) out.push(`- Publish gate: ${ver.gate.publish ? 'holds' : `closed (${ver.gate.reasons.map((r) => cell(r, 160)).join('; ')})`}`);
    out.push('');
    const rows = coverageDelta(i.baseline?.coverage_before, ver?.coverage_after);
    if (rows.length) {
      out.push('### Coverage of the touched files (before -> after the candidate tests)', '', '| File | Lines | Branches | Functions |', '|---|---|---|---|');
      for (const r of rows) out.push(r.error ? `| ${cell(r.file, 160)} | ${cell(r.error, 160)} | | |` : `| ${r.file.endsWith(' total') ? r.file : `\`${cell(r.file, 160)}\``} | ${r.lines} | ${r.branches} | ${r.functions} |`);
      out.push('');
    }
  }
  const bugs = i.result?.probable_bugs ?? [];
  if (bugs.length) {
    out.push('### Probable bugs (reproductions kept off the branch)', '', 'The `file:line` citations come from the agent and are not checked.', '');
    for (const b of bugs) {
      out.push(`- **${cell(b.title, 200)}** (confidence: ${cell(b.confidence, 10)}), code ${cell(b.code_location, 120)}, contract ${cell(b.contract_location, 160)}, test \`${cell(b.test_file, 160)}\``);
      out.push(fence(`input:    ${b.input}\npath:     ${b.code_path}\nobserved: ${b.observed}\nexpected: ${b.expected}`, 1200));
    }
    out.push('');
  }
  out.push('### Run');
  let cost = 0;
  for (const m of metas) {
    const r = m.result;
    if (!r) { out.push(`- attempt ${m.attempt ?? 1}: no result event in the transcript`); continue; }
    cost += Number(r.total_cost_usd ?? 0);
    out.push(`- attempt ${m.attempt ?? 1}: model \`${cell(m.init?.model ?? 'n/a', 60)}\`, cost $${Number(r.total_cost_usd ?? 0).toFixed(4)}, turns ${r.num_turns}, duration ${(Number(r.duration_ms ?? 0) / 1000).toFixed(1)} s, result \`${cell(r.subtype, 40)}\`${r.permission_denials?.length ? `, permission denials ${r.permission_denials.length}` : ''}`);
  }
  if (metas.length > 1) out.push(`- total agent cost: $${cost.toFixed(4)}`);
  if (i.attempt === 2) out.push(`- attempt 2 ran because verify-1 found: ${cell([...(i.verify1?.classes?.test_failure ?? []), ...(i.verify1?.classes?.tsc ?? []), ...(i.verify1?.classes?.open_failure ?? [])].slice(0, 3).join('; ') || 'n/a', 400)}`);
  const pub = i.publish;
  out.push(`- tested SHA \`${short(testedSha)}\`; verified tree \`${short(ver?.candidate_tree_sha)}\`; pushed SHA \`${short(pub?.commit_sha && pub.status === 'published' ? pub.commit_sha : null)}\`; publish ${pub ? cell(pub.status, 20) : 'not run'}${pub?.reason ? ` (${cell(pub.reason, 200)})` : ''}${pub?.status_error ? `; ${cell(pub.status_error, 120)}` : ''}; final attempt ${i.attempt ?? 1} of 2`);
  if (i.scope?.merge_base) out.push(`- merge base \`${short(i.scope.merge_base)}\``);
  if (runUrl) out.push(`- run: ${runUrl}`);
  out.push('');
  return { verdict: v, body: `${out.join('\n')}\n` };
}

export function withheldIfSecret(body) {
  const hits = scanText(body, secretLiterals());
  if (!hits.length) return { body, hits };
  return { body: `${MARKER}\n## Test agent report\n\n**Verdict:** failure (stage: report secret scan: ${hits.join(', ')}). Report withheld.\n`, hits };
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'taskly-test-agent' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// The test-agent/verified status of a commit (newest first), or null when it has none.
export async function fetchBotStatus(sha, apiImpl = api) {
  const res = await apiImpl('GET', `/commits/${sha}/statuses?per_page=100`);
  if (res.status !== 200) throw new Error(`list statuses: HTTP ${res.status}`);
  const s = (res.json ?? []).find((x) => x.context === 'test-agent/verified');
  return s ? { state: s.state, description: s.description ?? '' } : null;
}

// Sticky comment: edit ours in place, create it once. Only when the live head is the tested or the
// just-published SHA, so an old run never overwrites a newer report.
export async function post({ body, publishedSha }) {
  const n = process.env.PR_NUMBER, tested = process.env.TESTED_SHA;
  const pr = await api('GET', `/pulls/${n}`);
  if (pr.status !== 200) return { posted: false, reason: `GET pull: HTTP ${pr.status}` };
  const live = pr.json.head.sha;
  if (live !== tested && live !== publishedSha) return { posted: false, reason: `stale: live head ${live.slice(0, 12)} is neither tested ${tested.slice(0, 12)} nor published ${String(publishedSha || 'n/a').slice(0, 12)}` };
  let existing = null;
  for (let page = 1; page <= 20 && !existing; page++) {
    const list = await api('GET', `/issues/${n}/comments?per_page=100&page=${page}`);
    if (list.status !== 200) return { posted: false, reason: `list comments: HTTP ${list.status}` };
    existing = list.json.find((c) => c.user?.login === 'github-actions[bot]' && String(c.body ?? '').startsWith(MARKER)) ?? null;
    if (list.json.length < 100) break;
  }
  const res = existing ? await api('PATCH', `/issues/comments/${existing.id}`, { body }) : await api('POST', `/issues/${n}/comments`, { body });
  const ok = res.status === 200 || res.status === 201;
  return { posted: ok, action: existing ? 'updated' : 'created', comment_id: res.json?.id ?? existing?.id ?? null, url: res.json?.html_url ?? null, http: res.status, reason: ok ? null : res.json?.message };
}

export async function main(argv) {
  const a = parseArgs(argv);
  if (a.mode === 'extract-meta') {
    const meta = extractMeta(readFileSync(a.stream, 'utf8'));
    meta.attempt = Number(a.attempt || 1);
    if (a['result-out']) writeFileSync(a['result-out'], `${JSON.stringify(meta.structured_output, null, 2)}\n`);
    const { structured_output, ...rest } = meta;
    writeFileSync(a.out, `${JSON.stringify(rest, null, 2)}\n`);
    // Model-controlled text (skill names outside the project list, paths) is not printed: this runs before the secret scan.
    console.log(JSON.stringify({ skills_invoked: rest.skills_invoked.filter((n) => PROJECT_SKILLS.includes(n)), unexpected_skills: rest.unexpected_skills.length, files_written: rest.files_written.length, cost: rest.result?.total_cost_usd, turns: rest.result?.num_turns, subtype: rest.result?.subtype, structured: structured_output != null, model: rest.init?.model, apiKeySource: rest.init?.apiKeySource, cli: rest.init?.claude_code_version }));
    return 0;
  }
  if (a.mode === 'render') {
    const inputs = loadInputs(a.dir);
    if (inputs.scope?.decision === 'skip' && inputs.scope?.skip_kind === 'bot-commit') {
      try { inputs.botStatus = await fetchBotStatus(process.env.TESTED_SHA); } catch (e) { inputs.botStatus = null; inputs.botStatusError = String(e?.message ?? e).slice(0, 200); console.error(inputs.botStatusError); }
    }
    const { verdict, body } = render(inputs, { testedSha: process.env.TESTED_SHA, runUrl: process.env.RUN_URL });
    const safe = withheldIfSecret(body);
    writeFileSync(a.out, safe.body);
    const final = safe.hits.length ? { ...verdict, state: 'failure', headline: 'failure: report secret scan hit' } : verdict;
    writeFileSync(a['verdict-out'], `${JSON.stringify(final, null, 2)}\n`);
    console.log(JSON.stringify({ state: final.state, headline: final.headline, secret_scan_ok: !safe.hits.length }));
    return 0;
  }
  if (a.mode === 'post') {
    const body = readFileSync(a.body, 'utf8');
    if (scanText(body, secretLiterals()).length) { console.log(JSON.stringify({ posted: false, reason: 'secret scan hit' })); return 1; }
    const r = await post({ body, publishedSha: a['published-sha'] || null });
    console.log(JSON.stringify(r));
    return r.posted || String(r.reason ?? '').startsWith('stale') ? 0 : 1;
  }
  console.error('usage: report.mjs extract-meta|render|post ...');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
