#!/usr/bin/env node
// gen.json for one generate attempt: the status the verify, publish and report jobs read. Node 22.
//
//   ATTEMPT=<n> AGENT_EXIT=<exit> node gen-status.mjs <secret scan exit>     (in the job dir; reads out/)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Order: secret hit, skill outside the project list, agent error, refused file, guard, no-op, patch.
export function genStatus({ scan, agentExit, meta, result, guard, patch, refused }) {
  let g = { status: 'patch' };
  if (scan !== 0) g = { status: 'secret-hit' };
  else if (meta?.unexpected_skills?.length) g = { status: 'skill-violation', unexpected_skills: meta.unexpected_skills };
  else if (String(agentExit) !== '0' || !meta?.result || meta.result.is_error || !result) g = { status: 'agent-error', detail: `exit ${agentExit}, result ${meta?.result?.subtype ?? 'none'}${result ? '' : ', no structured output'}` };
  else if (refused?.length) g = { status: 'guard-fail', violations: refused };
  else if (!guard?.ok) g = { status: 'guard-fail', violations: guard?.violations ?? ['guard wrote no report'] };
  else if (!patch.trim()) g = { status: 'no-op', reason: result.reason };
  // After a secret-scan hit gen.json carries no model text at all.
  if (g.status !== 'secret-hit') {
    g.agent_decision = result?.decision ?? null;
    g.probable_bugs = (result?.probable_bugs ?? []).map((b) => String(b.title ?? '').slice(0, 200));
  }
  return g;
}

export function main(argv, env = process.env) {
  const n = env.ATTEMPT || '1';
  const read = (p, fallback) => (existsSync(p) ? readFileSync(p, 'utf8') : fallback);
  const parse = (p) => { try { return JSON.parse(read(p, 'null') || 'null'); } catch { return null; } };
  const refusedText = read(`out/files${n}.refused`, '').trim();
  const g = genStatus({
    scan: Number(argv[0]),
    agentExit: env.AGENT_EXIT,
    meta: parse(`out/run-meta-${n}.json`),
    result: parse(`out/result${n}.json`),
    guard: parse(`out/guard${n}.json`),
    patch: read(`out/patch${n}.diff`, ''),
    refused: refusedText ? refusedText.split('\n') : [],
  });
  g.attempt = Number(n);
  writeFileSync('out/gen.json', `${JSON.stringify(g, null, 2)}\n`);
  console.log(JSON.stringify(g.status === 'secret-hit' ? g : { status: g.status, attempt: g.attempt, probable_bugs: g.probable_bugs.length }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
