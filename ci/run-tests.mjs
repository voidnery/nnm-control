#!/usr/bin/env node
// ci/run-tests.mjs — every test and audit of the repository in one run, reported as TAP.
//
// The project's tests are plain node scripts: each prints «✓ name» / «✗ name: why» per check and
// exits non-zero when one failed (`npm test` chains sixty of them with && and stops at the first
// red). This runner executes ALL of them, one process each, and turns their output into TAP lines
// for the eterix-ci gate (scripts/run-tests.sh, test-format: tap), which refuses zero tests and
// any failure:
//   - each «✓» / «✗» line is one test;
//   - a script that printed no marks is one test, green if it exited 0;
//   - a non-zero exit without a «✗» line is one failed test (a crash, a throw before any check);
//   - a «✗» line is a failure even if the script exited 0.
// The set is discovered from disk, not from a list: a new *.test.mjs or *-audit.mjs runs without
// anybody wiring it, and a file nobody wired cannot silently stop running (that happened —
// tests/playback-endpoints.test.mjs was never in `npm test`).
//
// Suites, in order: backend audits, backend tests, agent tests, frontend audits (the
// `npm run audit` chain), CI tests and the licence gate. Python audits need python3; without it
// they FAIL, unless NNM_ALLOW_NO_PYTHON=1 (a developer machine) turns them into skips.
//
//   node ci/run-tests.mjs [filter]     filter — substring of the script path, for a partial run
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const TIMEOUT_MS = 5 * 60 * 1000;

const list = (dir, re) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : [])
  .filter(f => re.test(f)).sort().map(f => `${dir}/${f}`);

function frontendAudits() {
  // The frontend's own definition of its gate, so a script added there is added here.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'frontend/package.json'), 'utf8'));
  return pkg.scripts.audit.split('&&').map(s => s.trim().replace(/^npm run /, '')).map(name => {
    const [cmd, file] = pkg.scripts[name].split(/\s+/);
    return { cwd: 'frontend', file: `frontend/${file}`, python: cmd === 'python3' };
  });
}

const jobs = [
  ...list('backend/scripts', /-audit\.mjs$/).map(file => ({ cwd: 'backend', file })),
  ...list('backend/tests', /\.test\.mjs$/).map(file => ({ cwd: 'backend', file })),
  ...list('agent/tests', /\.test\.mjs$/).map(file => ({ cwd: 'agent', file })),
  ...frontendAudits(),
  ...list('ci', /\.test\.mjs$/).map(file => ({ cwd: '.', file })),
  { cwd: '.', file: 'ci/license-audit.mjs', args: ['--check'] },
].filter(j => j.file.includes(filter));

const hasPython = spawnSync('python3', ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' }).status === 0;

function run(job) {
  const cmd = job.python ? 'python3' : process.execPath;
  const args = [relative(join(ROOT, job.cwd), join(ROOT, job.file)), ...(job.args || [])];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: join(ROOT, job.cwd), env: { ...process.env, FORCE_COLOR: '0' } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += `\n[run-tests] killed after ${TIMEOUT_MS / 1000}s\n`; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', e => { out += `\n[run-tests] ${e.message}\n`; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 1 : 0), out }); });
  });
}

// TAP descriptions are one line and may not start with a digit or carry «#» unescaped.
const desc = (s) => s.replace(/\s+/g, ' ').replace(/#/g, '\\#').trim().slice(0, 300);

let n = 0, pass = 0, fail = 0, skipped = 0;
const ok = (good, text, directive = '') => {
  n++;
  if (directive) skipped++; else if (good) pass++; else fail++;
  console.log(`${good ? 'ok' : 'not ok'} ${n} - ${desc(text)}${directive ? ` # ${directive}` : ''}`);
};
const comment = (text) => { for (const l of text.split('\n')) if (l.trim()) console.log(`#   ${l}`); };

console.log('TAP version 13');
for (const job of jobs) {
  if (job.python && !hasPython) {
    if (process.env.NNM_ALLOW_NO_PYTHON === '1') ok(true, `${job.file}`, 'SKIP python3 not available');
    else ok(false, `${job.file} — python3 not available`);
    continue;
  }
  const { code, out } = await run(job);
  const lines = out.split(/\r?\n/);
  const marks = lines.map(l => l.match(/^\s*([✓✗])\s+(.*)$/)).filter(Boolean);
  console.log(`# ${job.file}`);
  if (!marks.length) {
    ok(code === 0, `${job.file}${code === 0 ? '' : ` — exited with code ${code}`}`);
    if (code !== 0) comment(lines.slice(-25).join('\n'));
    continue;
  }
  for (const [, mark, text] of marks) ok(mark === '✓', `${job.file} › ${text}`);
  if (code !== 0 && !marks.some(([, m]) => m === '✗')) {
    ok(false, `${job.file} — exited with code ${code} after ${marks.length} passing check(s)`);
    comment(lines.slice(-25).join('\n'));
  } else if (code !== 0) {
    comment(lines.filter(l => !/^\s*✓/.test(l)).slice(-25).join('\n'));
  }
}
console.log(`1..${n}`);
console.log(`# tests ${n}`);
console.log(`# pass ${pass}`);
console.log(`# fail ${fail}`);
console.log(`# skipped ${skipped}`);
console.log(`# files ${jobs.length}`);
process.exit(fail ? 1 : 0);
