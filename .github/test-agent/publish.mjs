#!/usr/bin/env node
// Publish job of the PR test agent: the only job that writes. Node 22, no dependencies.
// It never checks out PR code and never runs git on the PR tree. It writes the verified candidate tree
// through the GitHub Git Data API, or nothing.
//
//   node publish.mjs --verify <verify.json> --candidate <dir> --patch <agent patch> --scope <scope.json>
//                    --gen <gen.json> --out <publish.json>
// env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_REF, TESTED_SHA, RUN_URL
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPatch, scanText } from '../../.claude/skills/verify-tests/scripts/guard.mjs';
import { computeVerdict, statusDescription } from './verdict.mjs';

export const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
export const STATUS_CONTEXT = 'test-agent/verified';
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export const gitBlobSha = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

// The part of the agent patch that touches the given paths.
export function patchSubset(patchText, paths) {
  const keep = new Set(paths);
  return patchText.split(/^(?=diff --git )/m).filter((c) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(c);
    return m && keep.has(m[2]);
  }).join('');
}

// Checks done outside the model before any write. Returns a list of reasons; empty means OK.
export function checkCandidate({ verify, candidateDir, patchText, testedSha }) {
  const reasons = [];
  if (verify.gate?.publish !== true) reasons.push('verify gate is closed');
  if (verify.tested_head_sha !== testedSha) reasons.push(`verify.json tested ${verify.tested_head_sha}, this run tests ${testedSha}`);
  if (!/^[0-9a-f]{40}$/.test(String(verify.candidate_tree_sha))) reasons.push('verify.json has no candidate tree id');
  const paths = (verify.candidate ?? []).map((c) => c.path);
  if (!paths.length) reasons.push('no candidate files');
  if (new Set(paths).size !== paths.length) reasons.push('duplicate candidate paths');
  const patchPaths = [...patchText.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((m) => m[1]).filter((p) => !/\.probable-bug\.test\.tsx?$/.test(p));
  const missing = patchPaths.filter((p) => !paths.includes(p)), extra = paths.filter((p) => !patchPaths.includes(p));
  if (missing.length || extra.length) reasons.push(`candidate list differs from the agent patch (missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'})`);
  // Path, size and modifier rules only: the no-weakening check needs the before/after trees, and publish
  // never checks out the PR. The generate job ran the full guard on the same patch.
  const guard = checkPatch(patchSubset(patchText, paths));
  if (!guard.ok) reasons.push(...guard.violations.map((v) => `guard: ${v}`));
  const files = [];
  for (const c of verify.candidate ?? []) {
    if (/\.probable-bug\.test\.tsx?$/.test(c.path)) reasons.push(`${c.path}: probable-bug file in the candidate set`);
    if (c.mode !== '100644') reasons.push(`${c.path}: mode ${c.mode}`);
    const abs = join(candidateDir, c.path);
    if (!existsSync(abs)) { reasons.push(`${c.path}: missing from the artifact`); continue; }
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) { reasons.push(`${c.path}: not a regular file (symlinks are refused)`); continue; }
    const bytes = readFileSync(abs);
    const sha = gitBlobSha(bytes);
    if (sha !== c.blob_sha) reasons.push(`${c.path}: blob ${sha} differs from verified blob ${c.blob_sha}`);
    const hits = scanText(bytes.toString('utf8'));
    if (hits.length) reasons.push(`${c.path}: secret pattern ${hits.join(', ')}`);
    files.push({ ...c, bytes });
  }
  return { reasons, files };
}

export function makeApi({ token, repo, fetchImpl = fetch }) {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'taskly-test-agent' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    return { status: res.status, json };
  };
}

const refPath = (branch) => `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

// out is filled in place, so a caller that catches a throw still has every step recorded so far.
export async function publish({ api, verify, files, testedSha, branch, prNumber, runUrl, verdictInputs, out = {} }) {
  Object.assign(out, { status: 'error', tested_sha: testedSha, verified_tree_sha: verify.candidate_tree_sha, steps: [] });
  const step = (name, data) => out.steps.push({ name, ...data });

  // 1. Stale-head pre-check.
  const pr = await api('GET', `/pulls/${prNumber}`);
  if (pr.status !== 200) { out.reason = `GET pull ${prNumber}: HTTP ${pr.status}`; return out; }
  step('live-head', { sha: pr.json.head.sha });
  if (pr.json.head.sha !== testedSha) { out.status = 'superseded'; out.reason = `head is ${pr.json.head.sha.slice(0, 12)}, tested ${testedSha.slice(0, 12)}`; return out; }
  if (pr.json.head.ref !== branch) { out.reason = `PR head ref is ${pr.json.head.ref}, expected ${branch}`; return out; }

  // 2. Blobs, then a tree on top of the tested commit's tree. GitHub's ids must equal the verified ids.
  const tested = await api('GET', `/git/commits/${testedSha}`);
  if (tested.status !== 200) { out.reason = `GET commit ${testedSha}: HTTP ${tested.status}`; return out; }
  for (const f of files) {
    const b = await api('POST', '/git/blobs', { content: f.bytes.toString('base64'), encoding: 'base64' });
    if (b.status !== 201 || b.json.sha !== f.blob_sha) { out.reason = `blob for ${f.path}: HTTP ${b.status}, id ${b.json?.sha} vs verified ${f.blob_sha}`; return out; }
  }
  step('blobs', { count: files.length });
  const tree = await api('POST', '/git/trees', { base_tree: tested.json.tree.sha, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: f.blob_sha })) });
  if (tree.status !== 201) { out.reason = `create tree: HTTP ${tree.status}`; return out; }
  out.github_tree_sha = tree.json.sha;
  step('tree', { github: tree.json.sha, verified: verify.candidate_tree_sha, equal: tree.json.sha === verify.candidate_tree_sha });
  if (tree.json.sha !== verify.candidate_tree_sha) { out.reason = `GitHub tree ${tree.json.sha} differs from the verified tree ${verify.candidate_tree_sha}`; return out; }

  // 3. Commit: parent = tested SHA, author github-actions[bot], one-line message, no trailers.
  const message = `test(agent): add/update unit tests for #${prNumber}`;
  if (scanText(message).length) { out.reason = 'secret pattern in the commit message'; return out; }
  const commit = await api('POST', '/git/commits', { message, tree: tree.json.sha, parents: [testedSha], author: { ...BOT, date: new Date().toISOString() } });
  if (commit.status !== 201) { out.reason = `create commit: HTTP ${commit.status}`; return out; }
  out.commit_sha = commit.json.sha;
  step('commit', { sha: commit.json.sha, tree: commit.json.tree?.sha, parents: commit.json.parents?.map((p) => p.sha), author: commit.json.author?.name, message: commit.json.message });

  // 4. Fast-forward-only ref update. A moved head makes GitHub refuse it. If the request throws (the
  // response is lost), read the ref back: it either points at our commit (published) or it does not.
  let ref;
  try { ref = await api('PATCH', refPath(branch), { sha: commit.json.sha, force: false }); }
  catch (e) {
    const lost = String(e?.message ?? e).slice(0, 200);
    let live = null;
    try { live = await api('GET', refPath(branch).replace('/git/refs/', '/git/ref/')); } catch { live = null; }
    const liveSha = live?.status === 200 ? live.json?.object?.sha : null;
    out.ref_update = { status: 0, message: `request failed (${lost}); ref read back: ${liveSha ?? 'unknown'}` };
    step('ref-update', out.ref_update);
    if (liveSha !== commit.json.sha) { out.reason = `ref update: ${out.ref_update.message}; commit ${commit.json.sha} is not on the branch`; return out; }
    ref = { status: 200, json: null };
  }
  if (!out.ref_update) { out.ref_update = { status: ref.status, message: ref.json?.message ?? null }; step('ref-update', out.ref_update); }
  if (ref.status === 422) { out.status = 'superseded'; out.reason = `ref update refused: ${ref.json?.message ?? 'not a fast forward'}`; return out; }
  if (ref.status !== 200) { out.reason = `ref update: HTTP ${ref.status}`; return out; }
  out.status = 'published';

  // 5. Commit status from the verdict, with the run link.
  const v = computeVerdict({ ...verdictInputs, publish: { status: 'published' } });
  // The ref has moved: from here on a failure is recorded as status_error, never as a lost publish.
  let st;
  try { st = await api('POST', `/statuses/${commit.json.sha}`, { state: v.state, context: STATUS_CONTEXT, description: statusDescription(v), target_url: runUrl }); }
  catch (e) { st = { status: 0, error: String(e?.message ?? e).slice(0, 200) }; }
  out.commit_status = { http: st.status, state: v.state, description: statusDescription(v) };
  step('status', out.commit_status);
  if (st.status !== 201) out.status_error = `set status: ${st.error ?? `HTTP ${st.status}`}`;
  return out;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  return a;
}

export async function main(argv) {
  const a = parseArgs(argv);
  const env = process.env;
  const out = { status: 'refused' };
  try {
    const verify = readJson(a.verify);
    const patchText = readFileSync(a.patch, 'utf8');
    const testedSha = env.TESTED_SHA;
    const { reasons, files } = checkCandidate({ verify, candidateDir: resolve(a.candidate), patchText, testedSha });
    if (reasons.length) {
      Object.assign(out, { reason: reasons.join('; '), checks: reasons });
    } else {
      const verdictInputs = { scope: readJson(a.scope), gen: readJson(a.gen), verify };
      const api = makeApi({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
      await publish({ api, verify, files, testedSha, branch: env.HEAD_REF, prNumber: env.PR_NUMBER, runUrl: env.RUN_URL, verdictInputs, out });
    }
  } catch (e) {
    // Keep what publish recorded (commit_sha, steps); only the status and reason change.
    Object.assign(out, { status: out.status === 'published' ? 'published' : 'error', reason: `publish crashed: ${String(e?.message ?? e).slice(0, 300)}` });
  }
  writeFileSync(a.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ status: out.status, reason: out.reason ?? null, commit: out.commit_sha ?? null, tree: out.github_tree_sha ?? null, ref_update: out.ref_update ?? null, commit_status: out.commit_status ?? null }));
  // A failed status write after the ref moved fails the job; the verdict reports it as infrastructure.
  return (out.status === 'published' && !out.status_error) || out.status === 'superseded' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
