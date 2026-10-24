// The licence gate (ci/license-audit.mjs) decides whether a closed product may ship; its classifier
// is checked here on the SPDX shapes npm actually carries, including the dual-licence forms that a
// naive «contains GPL» test gets wrong in both directions.
import assert from 'node:assert/strict';
import { classify, inventory } from './license-audit.mjs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

console.log('\nCLASSIFIER:');
check('permissive licences pass', () => {
  for (const l of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'MIT-0',
    'Python-2.0', 'CC-BY-4.0', 'CC0-1.0', 'BlueOak-1.0.0']) assert.equal(classify(l), 'permissive', l);
});
check('strong copyleft is caught', () => {
  for (const l of ['GPL-2.0', 'GPL-3.0-only', 'AGPL-3.0-or-later', 'CC-BY-SA-4.0', 'EUPL-1.2']) {
    assert.equal(classify(l), 'strong-copyleft', l);
  }
});
check('weak copyleft is caught, and LGPL is not mistaken for GPL', () => {
  for (const l of ['LGPL-2.1', 'LGPL-3.0-or-later', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0']) {
    assert.equal(classify(l), 'weak-copyleft', l);
  }
});
check('source-available and non-commercial licences are not permissive', () => {
  for (const l of ['SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-4.0', 'UNLICENSED']) assert.equal(classify(l), 'non-free', l);
});
check('a dual licence with a permissive choice is permissive', () => {
  assert.equal(classify('(MIT OR GPL-3.0)'), 'permissive');
  assert.equal(classify('MPL-2.0 OR Apache-2.0'), 'permissive');
});
check('a conjunction takes its worst part', () => {
  assert.equal(classify('(MIT AND GPL-2.0)'), 'strong-copyleft');
  assert.equal(classify('MIT AND LGPL-2.1'), 'weak-copyleft');
});
check('no licence is unknown, not permissive', () => {
  assert.equal(classify(''), 'unknown');
  assert.equal(classify(undefined), 'unknown');
});

console.log('\nINVENTORY:');
check('every package of both lock files is listed, with a scope', () => {
  for (const dir of ['backend', 'frontend']) {
    const rows = inventory(dir);
    assert.ok(rows.length > 50, `${dir}: only ${rows.length} packages — the lock file is empty again`);
    assert.ok(rows.every(r => ['prod', 'dev', 'optional'].includes(r.scope)));
  }
});
check('backend ships its production dependencies and nothing from dev', () => {
  const rows = inventory('backend');
  for (const name of ['express', 'mongoose', 'ssh2', 'maxmind']) {
    assert.ok(rows.find(r => r.name === name)?.ships, `${name} must ship`);
  }
  for (const name of ['acorn', 'js-yaml']) assert.equal(rows.find(r => r.name === name)?.ships, false, name);
});
check('frontend build tools do not ship', () => {
  const rows = inventory('frontend');
  for (const name of ['vite', 'jsdom', 'esbuild']) assert.equal(rows.find(r => r.name === name)?.ships, false, name);
  assert.ok(rows.find(r => r.name === 'react')?.ships, 'react must ship');
});

console.log(failures ? `\n${failures} licence-audit check(s) failed` : '\nall licence-audit checks passed');
process.exit(failures ? 1 : 0);
