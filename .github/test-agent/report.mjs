#!/usr/bin/env node
// Run metadata extraction, PR report rendering and the sticky comment. Node 22, no dependencies.
//
//   node report.mjs extract-meta --stream <stream.jsonl> --attempt <n> --out <run-meta.json> [--result-out <result.json>]
//   node report.mjs render --dir <artifacts dir> --out <report.md> --verdict-out <verdict.json>
//        artifacts dir holds scope/, gen-1/, verify-1/, publish/ (each optional)
//        env: SCOPE_JOB, GEN_JOB, VERIFY_JOB, PUBLISH_JOB (job results), TESTED_SHA, RUN_URL
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
const pct = (v) => (v == null ? 'n/a' : `${v}%`);
const short = (s) => (s ? String(s).slice(0, 12) : 'n/a');

export function loadInputs(dir, env = process.env) {
  return {
    scope: readJson(join(dir, 'scope/scope.json')),
    scopeJob: env.SCOPE_JOB,
    gen: readJson(join(dir, 'gen-1/gen.json')),
    genJob: env.GEN_JOB,
    result: readJson(join(dir, 'gen-1/result1.json')),
    meta: readJson(join(dir, 'gen-1/run-meta-1.json')),
    guard: readJson(join(dir, 'gen-1/guard1.json')),
    verify: readJson(join(dir, 'verify-1/verify1.json')),
    verifyJob: env.VERIFY_JOB,
    publish: readJson(join(dir, 'publish/publish.json')),
    publishJob: env.PUBLISH_JOB,
  };
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
  if (i.meta) {
    out.push('### Skills invoked (from the run transcript)');
    out.push(`- attempt 1: ${i.meta.skills_invoked?.length ? i.meta.skills_invoked.map((s) => `\`${cell(s, 60)}\``).join(', ') : 'none recorded'}`);
    const wroteTests = (i.meta.files_written ?? []).some((f) => f.ok);
    const stackSkill = (i.meta.skills_invoked ?? []).some((s) => s === 'backend-unit-tests' || s === 'frontend-unit-tests');
    if (wroteTests && !stackSkill) out.push('- warning: test files were written without a stack skill call');
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
  if (ver || i.guard) {
    out.push('### Verification');
    if (i.guard) out.push(`- Guard: ${i.guard.ok ? 'OK' : `FAILED: ${(i.guard.violations ?? []).map((x) => cell(x, 160)).join('; ')}`}`);
    for (const [pkg, p] of Object.entries(ver?.packages ?? {})) {
      const t = p.suite.totals;
      out.push(`- ${pkg}: tsc ${p.tsc.ok ? 'OK' : `FAIL (${p.tsc.errors} errors)`}; suite with the candidate tests ${t ? `${t.passed}/${t.tests} passed` : 'no report'}; each candidate file ran 3 times${p.threshold_miss ? '; coverage threshold missed' : ''}`);
    }
    if (ver) out.push(`- Publish gate: ${ver.gate.publish ? 'holds' : `closed (${ver.gate.reasons.map((r) => cell(r, 160)).join('; ')})`}`);
    out.push('');
    const covRows = [];
    for (const [pkg, cov] of Object.entries(ver?.coverage_after ?? {})) {
      if (cov.error) { covRows.push(`| ${pkg} | ${cell(cov.error, 80)} | | |`); continue; }
      for (const [k, c] of Object.entries(cov)) if (c) covRows.push(`| ${k === 'total' ? `${pkg} total` : `\`${cell(k, 160)}\``} | ${pct(c.lines)} | ${pct(c.branches)} | ${pct(c.functions)} |`);
    }
    if (covRows.length) out.push('### Coverage with the candidate tests', '', '| File | Lines | Branches | Functions |', '|---|---|---|---|', ...covRows, '');
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
  const r = i.meta?.result;
  if (r) out.push(`- attempt 1: model \`${cell(i.meta.init?.model ?? 'n/a', 60)}\`, cost $${Number(r.total_cost_usd ?? 0).toFixed(4)}, turns ${r.num_turns}, duration ${(Number(r.duration_ms ?? 0) / 1000).toFixed(1)} s, result \`${cell(r.subtype, 40)}\`${r.permission_denials?.length ? `, permission denials ${r.permission_denials.length}` : ''}`);
  const pub = i.publish;
  out.push(`- tested SHA \`${short(testedSha)}\`; verified tree \`${short(ver?.candidate_tree_sha)}\`; pushed SHA \`${short(pub?.commit_sha && pub.status === 'published' ? pub.commit_sha : null)}\`; publish ${pub ? cell(pub.status, 20) : 'not run'}${pub?.reason ? ` (${cell(pub.reason, 200)})` : ''}${pub?.status_error ? `; ${cell(pub.status_error, 120)}` : ''}; attempt 1 of 1`);
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
      try { inputs.botStatus = await fetchBotStatus(process.env.TESTED_SHA); } catch (e) { inputs.botStatus = null; console.error(String(e?.message ?? e)); }
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
