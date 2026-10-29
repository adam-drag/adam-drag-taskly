#!/usr/bin/env node
// Deterministic scope gate for the PR test agent. Node 22, no dependencies.
// It reads the PR trees as data only and never runs PR code.
//
//   node scope.mjs --base <dir> --head <dir> --out <ctx dir>
//                  [--trusted <dir>] [--fork] [--git <repo> --from <merge base sha> --to <head sha>]
// --base is the merge-base tree, --head the PR head tree (both read as data). With --git, the commits
// from..to are read to find bot commits (author github-actions[bot] and subject "test(agent):").
// Bot commits carry no trailers. Output: <out>/scope.json and <out>/pr.diff
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIMITS = { maxSrcFiles: 20, maxSrcLines: 800 };
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'storybook-static', '.vite']);
const SKIP_PREFIXES = ['backend/src/generated/'];
const TRUSTED_REQUIRED = [
  '.claude/agents/test-writer.md',
  '.claude/skills/analyze-pr-changes/SKILL.md',
  '.claude/skills/backend-unit-tests/SKILL.md',
  '.claude/skills/frontend-unit-tests/SKILL.md',
  '.claude/skills/verify-tests/SKILL.md',
  '.claude/skills/verify-tests/scripts/verify.mjs',
  '.claude/skills/verify-tests/scripts/guard.mjs',
];
export const BOT_AUTHOR = 'github-actions[bot]';
export const BOT_SUBJECT_PREFIX = 'test(agent):';

// A bot commit is identified by author name and subject prefix only. A human can fake both; that only
// makes the run skip generation and say so, so it fails safe.
export function isBotCommit(commit) {
  return Boolean(commit) && commit.author === BOT_AUTHOR && typeof commit.subject === 'string' && commit.subject.startsWith(BOT_SUBJECT_PREFIX);
}

// Commits in from..to (newest first) with author name, subject and the files they touched.
export function gitCommits(repo, from, to) {
  const r = spawnSync('git', ['-C', repo, 'log', '--no-color', '--no-renames', '--format=%x1e%H%x1f%an%x1f%s', '--name-only', `${from}..${to}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git log ${from}..${to} failed: ${r.stderr}`);
  return r.stdout.split('\x1e').filter((rec) => rec.trim()).map((rec) => {
    const [header, ...rest] = rec.split('\n');
    const [sha, author, subject] = header.split('\x1f');
    return { sha, author, subject, files: rest.map((l) => l.trim()).filter(Boolean) };
  });
}

export function agentAuthoredFiles(commits, headPaths) {
  const files = new Set();
  for (const c of commits) if (isBotCommit(c)) for (const f of c.files) if (!headPaths || headPaths.has(f)) files.add(f);
  return [...files].sort();
}

function parseArgs(argv) {
  const args = { fork: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fork') args.fork = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function walk(root) {
  const out = new Map();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split('\\').join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue;
        visit(abs);
      } else if (entry.isSymbolicLink()) {
        out.set(rel, { type: 'symlink', hash: `link:${readlinkSync(abs)}` });
      } else if (entry.isFile()) {
        const st = lstatSync(abs);
        out.set(rel, { type: 'file', mode: st.mode & 0o111 ? '100755' : '100644', hash: createHash('sha256').update(readFileSync(abs)).digest('hex') });
      }
    }
  };
  visit(root);
  return out;
}

export function classify(path) {
  if (/^\.github\//.test(path) || /^\.claude\//.test(path) || /(^|\/)\.claude\//.test(path) || /(^|\/)(\.mcp\.json|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/.test(path)) return 'agent-infra';
  if (/^backend\/tests\//.test(path)) return 'backend-test';
  if (/^frontend\/src\/.*\.(test|spec)\.(ts|tsx)$/.test(path) || /^frontend\/src\/test\//.test(path)) return 'frontend-test';
  if (/^backend\/src\/.*\.ts$/.test(path)) return 'backend-src';
  if (/^frontend\/src\/.*\.(ts|tsx)$/.test(path)) return 'frontend-src';
  if (/\.(md|mdx|txt)$/i.test(path) || /^backend\/openapi\.json$/.test(path)) return 'docs';
  if (/(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|[^/]*config[^/]*\.(ts|js|mjs|cjs)|Dockerfile|compose\.ya?ml|\.npmrc|\.env\.example|\.gitignore|\.dockerignore|\.prettier[^/]*|nginx\.conf)$/.test(path) || /^backend\/prisma\//.test(path)) return 'config';
  return 'other';
}

// Mirrors the coverage excludes in backend/vitest.config.ts and frontend/vite.config.ts.
export function coverageExcluded(path) {
  if (/^backend\/src\/(.*\/)?types\.ts$/.test(path) || /^backend\/src\/generated\//.test(path)) return 'backend coverage exclude (types.ts / generated)';
  const fe = [
    [/^frontend\/src\/main\.tsx$/, 'main.tsx'],
    [/^frontend\/src\/design-system\//, 'design-system (excluded from coverage; still test it if behaviour changed)'],
    [/^frontend\/src\/(.*\/)?(types|[^/]+\.types)\.ts$/, 'types'],
    [/^frontend\/src\/(.*\/)?index\.ts$/, 'index barrel'],
    [/^frontend\/src\/(.*\/)?(constants\.(ts|tsx)|[^/]+\.constants\.ts)$/, 'constants'],
    [/^frontend\/src\/features\/todos\/api\/queryKeys\.ts$/, 'queryKeys'],
    [/^frontend\/src\/lib\/queryClient\.ts$/, 'queryClient'],
  ];
  for (const [re, why] of fe) if (re.test(path)) return why;
  return null;
}

function stripExt(p) { return p.replace(/\.(tsx?|jsx?|mjs)$/, ''); }

// Test files that import (or vi.mock) a given src module, resolved from relative specifiers.
function findExistingTests(tree, headRoot, srcPath) {
  const target = stripExt(srcPath);
  const hits = [];
  for (const [rel, meta] of tree) {
    if (meta.type !== 'file') continue;
    const kind = classify(rel);
    if (kind !== 'backend-test' && kind !== 'frontend-test') continue;
    if (!/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
    const text = readFileSync(join(headRoot, rel), 'utf8');
    const specs = [...text.matchAll(/(?:from|import|vi\.mock\()\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      const resolved = stripExt(posix.normalize(posix.join(posix.dirname(rel), spec)));
      if (resolved === target || `${resolved}/index` === target) { hits.push(rel); break; }
    }
  }
  return hits.sort();
}

function fileDiff(baseRoot, headRoot, rel, status) {
  const a = status === 'added' ? '/dev/null' : join(baseRoot, rel);
  const b = status === 'deleted' ? '/dev/null' : join(headRoot, rel);
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--', a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed for ${rel}: ${r.stderr}`);
  let text = r.stdout;
  // Rewrite absolute paths in headers to repo-relative ones.
  for (const abs of [join(baseRoot, rel), join(headRoot, rel)]) {
    const noLead = abs.replace(/^\//, '');
    text = text.split(`a/${noLead}`).join(`a/${rel}`).split(`b/${noLead}`).join(`b/${rel}`)
      .split(`a/${abs}`).join(`a/${rel}`).split(`b/${abs}`).join(`b/${rel}`);
  }
  return text;
}

function numstat(diffText) {
  let added = 0, removed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function decide({ files, fork, headCommit, trustedMissing }) {
  const src = files.filter((f) => f.kind === 'backend-src' || f.kind === 'frontend-src');
  const infra = files.filter((f) => f.kind === 'agent-infra');
  const srcLines = src.reduce((n, f) => n + f.added + f.removed, 0);
  if (trustedMissing.length) return { decision: 'skip', reason: `bootstrap: trusted agent files missing on base (${trustedMissing.join(', ')})` };
  if (infra.length) return { decision: 'skip', reason: `PR edits agent infrastructure (${infra.map((f) => f.path).join(', ')}); needs human review` };
  if (isBotCommit(headCommit)) return { decision: 'skip', reason: `head commit ${String(headCommit.sha ?? '').slice(0, 12)} is a test-agent bot commit (author ${BOT_AUTHOR}, subject "${BOT_SUBJECT_PREFIX}")` };
  if (fork) return { decision: 'skip', reason: 'fork PR: no secrets available, generation skipped' };
  if (!src.length) {
    const kinds = [...new Set(files.map((f) => f.kind))].sort();
    return { decision: 'no-op', reason: files.length ? `no backend/src or frontend/src change (changed kinds: ${kinds.join(', ')})` : 'no file changes' };
  }
  if (src.length > LIMITS.maxSrcFiles || srcLines > LIMITS.maxSrcLines) {
    return { decision: 'skip', reason: `diff above cap: ${src.length} src files / ${srcLines} changed src lines (caps ${LIMITS.maxSrcFiles} / ${LIMITS.maxSrcLines})` };
  }
  return { decision: 'generate', reason: `${src.length} src file(s) changed (${srcLines} lines) in ${[...new Set(src.map((f) => f.kind.split('-')[0]))].sort().join(' + ')}` };
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args.base || !args.head || !args.out) {
    console.error('usage: scope.mjs --base <dir> --head <dir> --out <dir> [--trusted <dir>] [--fork] [--git <repo> --from <sha> --to <sha>]');
    return 2;
  }
  const baseRoot = resolve(args.base), headRoot = resolve(args.head), outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const baseTree = walk(baseRoot), headTree = walk(headRoot);
  const paths = [...new Set([...baseTree.keys(), ...headTree.keys()])].sort();
  const files = [];
  let diff = '';
  for (const rel of paths) {
    const a = baseTree.get(rel), b = headTree.get(rel);
    let status = null;
    if (!a) status = 'added';
    else if (!b) status = 'deleted';
    else if (a.hash !== b.hash || a.type !== b.type || a.mode !== b.mode) status = 'modified';
    if (!status) continue;
    const d = fileDiff(baseRoot, headRoot, rel, status);
    diff += d;
    const { added, removed } = numstat(d);
    const entry = { path: rel, status, kind: classify(rel), added, removed };
    if ((a && a.type === 'symlink') || (b && b.type === 'symlink')) entry.symlink = true;
    if (entry.kind.endsWith('-src') && status !== 'deleted') {
      entry.existing_tests = findExistingTests(headTree, headRoot, rel);
      const ex = coverageExcluded(rel);
      if (ex) entry.coverage_excluded = ex;
    }
    files.push(entry);
  }
  const trustedMissing = args.trusted ? TRUSTED_REQUIRED.filter((p) => !existsSync(join(resolve(args.trusted), p))) : [];
  let commits = [];
  if (args.git) {
    if (!args.from || !args.to) throw new Error('--git needs --from and --to');
    commits = gitCommits(resolve(args.git), args.from, args.to);
  }
  const headCommit = commits.find((c) => c.sha === args.to) ?? commits[0] ?? null;
  const { decision, reason } = decide({ files, fork: args.fork, headCommit, trustedMissing });
  const packages = [...new Set(files
    .filter((f) => ['backend-src', 'frontend-src', 'backend-test', 'frontend-test'].includes(f.kind))
    .map((f) => f.kind.split('-')[0]))].sort();
  const scope = {
    version: 1,
    decision,
    reason,
    llm_call_needed: decision === 'generate',
    packages,
    limits: LIMITS,
    totals: {
      files: files.length,
      src_files: files.filter((f) => f.kind.endsWith('-src')).length,
      src_lines_changed: files.filter((f) => f.kind.endsWith('-src')).reduce((n, f) => n + f.added + f.removed, 0),
    },
    files,
    head_commit: headCommit ? { sha: headCommit.sha, author: headCommit.author, subject: headCommit.subject, bot: isBotCommit(headCommit) } : null,
    commits_checked: commits.length,
    agent_authored_files: agentAuthoredFiles(commits, new Set(headTree.keys())),
  };
  writeFileSync(join(outDir, 'scope.json'), `${JSON.stringify(scope, null, 2)}\n`);
  writeFileSync(join(outDir, 'pr.diff'), diff);
  console.log(JSON.stringify({ decision, reason, packages }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
