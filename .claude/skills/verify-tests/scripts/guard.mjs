#!/usr/bin/env node
// Out-of-model guard for agent patches, plus the secret scan. Node 22, no dependencies. Fails closed.
//
//   node guard.mjs --patch <file> --before <tree> --after <tree> [--result result.json] [--out guard.json]
//     stdout carries counts only; violations (which quote model output) go to --out
//   node guard.mjs --secret-scan <file>... [--out scan.json]
//     literal secret values come from SECRET_SCAN_VALUES (newline-separated), never from argv
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CAPS = { linesPerFile: 400, linesTotal: 1500 };
const ALLOW = [
  /^backend\/tests\/(?:[^/]+\/)*[^/]+\.ts$/,
  /^frontend\/src\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/,
  /^frontend\/src\/test\/[^/]*Fixture\.ts$/,
];
const DENY = [
  [/^\.github\//, '.github/**'],
  [/(^|\/)\.claude\//, '.claude/**'],
  [/(^|\/)package(-lock)?\.json$|(^|\/)package[^/]*\.json$/, 'package*.json'],
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/, 'lockfile'],
  // Config files that tooling loads (vitest.config.ts, vite.config.ts, prisma.config.ts, core/config.ts).
  // A test for them, such as backend/tests/config.test.ts, does not end in config.ts and stays allowed.
  [/(^|\/)[^/]*config\.ts$/i, '*config.ts'],
  [/(^|\/)prisma\//, 'prisma/**'],
  [/^frontend\/src\/test\/setup\.ts$/, 'frontend/src/test/setup.ts'],
  [/(^|\/)design-system\/mocks\.tsx$/, 'design-system/mocks.tsx'],
];
const BANNED = [
  [/\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:only|skip|todo|fails|skipIf|runIf)\b/, '.only/.skip/.todo/.fails/.skipIf/.runIf'],
  [/(^|[^\w.])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/, 'xit/xdescribe/fit'],
  [/\bctx\.skip\s*\(|\bcontext\.skip\s*\(/, 'runtime skip'],
];
const TEST_CASE = /\b(?:it|test)(?:\.(?:concurrent|sequential))?(?:\.each)?\s*[(`]/g;
const EXPECT = /\bexpect(?:\.soft)?\s*\(/g;
// Lines an undeclared edit may remove: blank lines, single-line import statements, the closing line of a
// multi-line import, and lines of closing brackets only. A bare identifier line is not removable, because it
// can be an it.each row or a shorthand property; a name removed inside a multi-line import is refused too.
const REMOVABLE = /^\s*$|^\s*import\s+(?:type\s+)?(?:[\w$*{]|['"]).*$|^\s*\}\s*from\s+['"][^'"]+['"];?\s*$|^\s*[)}\]][)}\];,\s]*$/;
// An assertion on a line: expect(...) or a chained matcher such as .toBe( / .rejects.
const ASSERTION = /\bexpect(?:\.soft)?\s*\(|\.(?:to[A-Z]\w*|rejects|resolves)\b/;
// Matchers that accept almost any value. Replacing an existing assertion with one of them weakens it.
const WEAK_MATCHER = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined)\s*\(|\bexpect\.(?:any|anything)\s*\(/;

export function parsePatch(text) {
  const files = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0]);
    const f = { a: m ? m[1] : null, b: m ? m[2] : null, status: 'modified', added: 0, removed: 0, addedLines: [], removedLines: [], flags: [] };
    let inHunk = false;
    for (const line of lines.slice(1)) {
      if (!inHunk) {
        if (line.startsWith('new file mode ')) { f.status = 'added'; f.newMode = line.slice(14).trim(); }
        else if (line.startsWith('deleted file mode ')) { f.status = 'deleted'; f.flags.push('delete'); }
        else if (line.startsWith('old mode ') || line.startsWith('new mode ')) f.flags.push('mode-change');
        else if (line.startsWith('rename from ') || line.startsWith('rename to ')) f.flags.push('rename');
        else if (line.startsWith('copy from ') || line.startsWith('copy to ')) f.flags.push('copy');
        else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) f.flags.push('binary');
        else if (line.startsWith('@@')) inHunk = true;
        continue;
      }
      // Inside a hunk every +/- line is content, also "+++x" or "---x". File headers come before the first @@.
      if (line.startsWith('+')) { f.added++; f.addedLines.push(line.slice(1)); }
      else if (line.startsWith('-')) { f.removed++; f.removedLines.push(line.slice(1)); }
      else if (line.startsWith('GIT binary patch')) f.flags.push('binary');
    }
    if (f.newMode && f.newMode !== '100644') f.flags.push(f.newMode === '120000' ? 'symlink' : `mode ${f.newMode}`);
    if (/^index [0-9a-f]+\.\.[0-9a-f]+ 120000/m.test(chunk)) f.flags.push('symlink');
    files.push(f);
  }
  return files;
}

const count = (text, re) => (text.match(re) || []).length;

// humanUpdates: paths the agent declared in result.human_test_updates. Removing an assertion line from an
// existing test file is allowed only in those files.
export function checkPatch(patchText, beforeRoot, afterRoot, { humanUpdates = [] } = {}) {
  const declared = new Set(humanUpdates);
  const violations = [];
  const files = parsePatch(patchText);
  if (!patchText.trim()) return { ok: true, empty: true, violations, files: [], edited_existing: [], totals: { files: 0, added: 0 } };
  if (!files.length) violations.push('patch is not empty but has no parseable diff --git entries');
  let total = 0;
  const editedExisting = [];
  for (const f of files) {
    for (const p of new Set([f.a, f.b])) {
      if (!p) { violations.push('unparseable diff header'); continue; }
      if (p.includes('..') || p.startsWith('/')) violations.push(`${p}: path traversal`);
      const denied = DENY.find(([re]) => re.test(p));
      if (denied) violations.push(`${p}: denied path (${denied[1]})`);
      else if (!ALLOW.some((re) => re.test(p))) violations.push(`${p}: outside the test allowlist`);
    }
    if (f.a !== f.b) violations.push(`${f.a} -> ${f.b}: rename`);
    for (const flag of new Set(f.flags)) violations.push(`${f.b}: ${flag} not allowed`);
    if (f.added > CAPS.linesPerFile) violations.push(`${f.b}: ${f.added} added lines > ${CAPS.linesPerFile}`);
    total += f.added;
    f.addedLines.forEach((line) => {
      for (const [re, name] of BANNED) if (re.test(line)) violations.push(`${f.b}: banned modifier ${name}: ${line.trim().slice(0, 120)}`);
      if (line.includes('\u0000')) violations.push(`${f.b}: NUL byte`);
    });
    if (f.status === 'modified' && beforeRoot && afterRoot) {
      const bp = join(beforeRoot, f.a), ap = join(afterRoot, f.b);
      if (!existsSync(bp) || !existsSync(ap)) { violations.push(`${f.b}: cannot read before/after for the no-weakening check`); continue; }
      const before = readFileSync(bp, 'utf8'), after = readFileSync(ap, 'utf8');
      const e = {
        path: f.b,
        tests_before: count(before, TEST_CASE), tests_after: count(after, TEST_CASE),
        expects_before: count(before, EXPECT), expects_after: count(after, EXPECT),
        removed_lines: f.removedLines.slice(0, 40), added_lines_count: f.added,
      };
      if (e.tests_after < e.tests_before) violations.push(`${f.b}: test cases went down ${e.tests_before} -> ${e.tests_after} (no-weakening)`);
      if (e.expects_after < e.expects_before) violations.push(`${f.b}: expect( calls went down ${e.expects_before} -> ${e.expects_after} (no-weakening)`);
      // New tests appended to an existing file are fine. Changing existing assertions is not, unless the
      // agent declared the test in human_test_updates, and even then not towards a weak matcher.
      // The weak-matcher rule is per file and fails closed: an existing test file that loses any line
      // (an assertion, a property inside a multi-line toEqual, a whole it() block) may not gain a weak
      // matcher anywhere, declared or not. Edits that only add lines pass. The cost is a refused publish
      // for a legitimate edit plus a weak-matcher test in the same file; nothing is weakened by it.
      const assertionsRemoved = f.removedLines.some((l) => ASSERTION.test(l));
      if (assertionsRemoved && !declared.has(f.b)) violations.push(`${f.b}: assertion lines removed from an existing test file that is not in human_test_updates (no-weakening)`);
      // Outside human_test_updates an existing test file may lose only blank lines, import lines and lines of
      // closing brackets. Anything else (an it.each table row, a setup line) could drop a case unseen.
      const otherRemoved = f.removedLines.filter((l) => !ASSERTION.test(l) && !REMOVABLE.test(l));
      if (otherRemoved.length && !declared.has(f.b)) violations.push(`${f.b}: lines removed from an existing test file that is not in human_test_updates: ${otherRemoved[0].trim().slice(0, 120)}`);
      if (f.removed > 0 && f.addedLines.some((l) => WEAK_MATCHER.test(l))) violations.push(`${f.b}: no-weakening rule: this existing test file loses lines and gains a weak matcher (toBeDefined/toBeTruthy/toBeFalsy/toBeUndefined/expect.any/expect.anything); use an exact matcher, or a human pushes this change`);
      editedExisting.push(e);
    }
  }
  if (total > CAPS.linesTotal) violations.push(`total ${total} added lines > ${CAPS.linesTotal}`);
  return {
    ok: violations.length === 0,
    violations: [...new Set(violations)],
    files: files.map(({ a, b, status, added, removed, flags }) => ({ path: b, from: a, status, added, removed, flags })),
    edited_existing: editedExisting,
    totals: { files: files.length, added: total },
  };
}

const PATTERNS = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];

export function literalForms(value) {
  const v = String(value);
  return [
    ['literal', v],
    ['base64', Buffer.from(v).toString('base64')],
    ['base64url', Buffer.from(v).toString('base64url')],
    ['hex', Buffer.from(v).toString('hex')],
    ['url-encoded', encodeURIComponent(v)],
  ].filter(([, s]) => s.length >= 8);
}

// Returns only pattern names, never the matched text.
export function scanText(text, literals = []) {
  const hits = [];
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(name);
  for (const value of literals) for (const [form, s] of literalForms(value)) if (text.includes(s)) hits.push(`secret-value:${form}`);
  return [...new Set(hits)];
}

export function secretLiterals() {
  return (process.env.SECRET_SCAN_VALUES || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--secret-scan') args.secretScan = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args.files.push(a);
  }
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.secretScan) {
    const literals = secretLiterals();
    const results = args.files.map((file) => ({ file, hits: existsSync(file) ? scanText(readFileSync(file, 'utf8'), literals) : ['missing-file'] }));
    const ok = results.every((r) => r.hits.length === 0);
    const out = { ok, literal_values_checked: literals.length, results };
    if (args.out) writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
    console.log(JSON.stringify({ secret_scan_ok: ok, files: results.length, literal_values_checked: literals.length }));
    return ok ? 0 : 1;
  }
  if (!args.patch) { console.error('usage: guard.mjs --patch <file> --before <dir> --after <dir> [--out <file>]'); return 2; }
  let humanUpdates = [];
  if (args.result && existsSync(args.result)) {
    try { humanUpdates = (JSON.parse(readFileSync(args.result, 'utf8') || 'null')?.human_test_updates ?? []).map((u) => u.path); } catch { humanUpdates = []; }
  }
  const result = checkPatch(readFileSync(args.patch, 'utf8'), args.before, args.after, { humanUpdates });
  if (args.out) writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  // Counts only: violation text and paths come from model output and are not secret-scanned yet.
  console.log(JSON.stringify({ guard_ok: result.ok, violations: result.violations.length, files: result.files.length, added: result.totals.added }));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
