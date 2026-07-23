// Guards a whole class of "works locally, broken in the image" bugs: the
// Dockerfile COPYs a subset of the repo, so an asset that exists on disk can
// still be missing from the container build. We rebuild using ONLY what the
// Dockerfile copies, then assert every root-relative asset referenced by the
// built index.html actually exists in dist/.
import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const FRONTEND = path.resolve('.');
const dockerfile = readFileSync(path.join(FRONTEND, 'Dockerfile'), 'utf8');

// Collect sources from build-stage COPY lines (skip `COPY --from=...`).
const copied = [];
for (const line of dockerfile.split('\n')) {
  const m = line.match(/^COPY\s+(?!--from)(.+)$/);
  if (!m) continue;
  const parts = m[1].trim().split(/\s+/);
  parts.slice(0, -1).forEach(p => copied.push(p));
}

// CI builds from a git checkout, not from the working tree: a path that exists
// locally but is untracked (e.g. caught by .gitignore) makes `COPY` fail with
// "not found" in CI while everything looks fine here.
let untracked = 0;
for (const src of copied) {
  let tracked = 0;
  try {
    const out = execSync(`git ls-files -- ${JSON.stringify(src)}`, { cwd: FRONTEND, stdio: ['pipe','pipe','pipe'] }).toString().trim();
    tracked = out ? out.split('\n').length : 0;
  } catch { tracked = 0; }
  if (!tracked) {
    untracked++;
    console.error(`✗ Dockerfile COPYs "${src}" but git tracks no files there — CI checkout will not have it`);
  } else {
    console.log(`  ✓ tracked in git: ${src} (${tracked} file${tracked > 1 ? 's' : ''})`);
  }
}
if (untracked) {
  console.error(`\n${untracked} COPY source(s) missing from git — commit them (check .gitignore).`);
  process.exit(1);
}

const ctx = mkdtempSync(path.join(tmpdir(), 'nnmctx-'));
try {
  for (const src of copied) {
    const from = path.join(FRONTEND, src);
    if (!existsSync(from)) { console.error(`✗ Dockerfile COPYs "${src}" but it does not exist`); process.exit(1); }
    cpSync(from, path.join(ctx, path.basename(src)), { recursive: true });
  }
  symlinkSync(path.join(FRONTEND, 'node_modules'), path.join(ctx, 'node_modules'));
  execSync('npx vite build', { cwd: ctx, stdio: 'pipe' });

  const dist = path.join(ctx, 'dist');
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map(m => m[1]);

  let missing = 0;
  console.log(`Docker build context: ${copied.join(', ')}`);
  console.log(`Assets referenced by index.html: ${refs.length}`);
  for (const ref of refs) {
    const ok = existsSync(path.join(dist, ref.replace(/^\//, '').split('?')[0]));
    if (!ok) missing++;
    console.log(`  ${ok ? '✓' : '✗'} ${ref}`);
  }
  if (missing) {
    console.error(`\n${missing} referenced asset(s) missing from the container build — add the missing COPY to the Dockerfile.`);
    process.exit(1);
  }
  console.log('\nAll referenced assets are present in the container build.');
} finally {
  rmSync(ctx, { recursive: true, force: true });
}
