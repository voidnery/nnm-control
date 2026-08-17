// The inventory must know every route this panel can already call.
//
// `/server/{s}/live/app` was in `wmspanelClient.js` — with a comment naming
// the path — while `docs/wmspanel-api.md` said the family it belongs to was
// unreachable and `docs/STATE.md` repeated that as settled. A probe of
// somebody else's API ran for a week past an answer sitting in our own source.
//
// So the rule is one-directional and mechanical: **anything callable must be
// written down.** The reverse is not required — the inventory legitimately
// lists families the panel does not use yet.
//
// The gate is proven by contradiction at the bottom of this file: the same
// check, run against an inventory with `live/app` cut out of it, must fail.
// A check that cannot fail has not been shown to work.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const CLIENT = join(root, 'backend', 'src', 'services', 'wmspanelClient.js');
const INVENTORY = join(root, 'docs', 'wmspanel-api.md');

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

// A path reduced to the thing an inventory row is about.
//
// Item and action routes are not separate families: `/wmsauth/groups/{id}/
// rules` is the WMSAuth group family seen from further in. So the path is cut
// at its first identifier, which leaves exactly what a table row names.
export function family(raw) {
  let p = String(raw).split('?')[0].replace(/\$\{[^}]*\}/g, '{id}').replace(/\/+$/, '');
  if (p.startsWith('/server/{id}')) p = `/server/{s}${p.slice('/server/{id}'.length)}`;
  const cut = p.indexOf('/{id}');
  if (cut >= 0) p = p.slice(0, cut);
  return p === '/server/{s}' ? '/server' : p;
}

// Every template literal in the client that looks like an API path. Read as
// text rather than by importing: the point is to see what the file says, and
// an import would only surface the paths some code path happens to reach.
export function calledFamilies(source) {
  const out = new Set();
  for (const m of source.matchAll(/`(\/[^`]*)`/g)) out.add(family(m[1]));
  return out;
}

// Backticked paths anywhere in the document, plus the fenced census block.
// Both count: a family named in a prose table is written down as surely as one
// listed in the block.
export function documentedFamilies(doc) {
  const out = new Set();
  for (const m of doc.matchAll(/`(\/[^`\s]*)`/g)) out.add(family(m[1]));
  const block = doc.match(/```routes-called\n([\s\S]*?)```/);
  if (block) for (const line of block[1].split('\n')) {
    const t = line.trim();
    if (t) out.add(family(t));
  }
  return out;
}

const client = readFileSync(CLIENT, 'utf8');
const inventory = readFileSync(INVENTORY, 'utf8');

console.log('WMSPanel inventory gate\n');

test('every route the client can call appears in the inventory', () => {
  const called = calledFamilies(client);
  const documented = documentedFamilies(inventory);
  const missing = [...called].filter(f => !documented.has(f)).sort();
  assert.deepEqual(missing, [],
    `not in docs/wmspanel-api.md: ${missing.join(', ')}\n` +
    '    A route the panel can call and the inventory does not mention is how\n' +
    '    live/app stayed invisible. Add it to the census block, with what it is.');
});

test('the census block is complete and honest about itself', () => {
  const called = calledFamilies(client);
  const block = inventory.match(/```routes-called\n([\s\S]*?)```/);
  assert.ok(block, 'the routes-called block is missing from the inventory');
  const listed = new Set(block[1].split('\n').map(s => s.trim()).filter(Boolean));
  const absent = [...called].filter(f => !listed.has(f)).sort();
  const stale = [...listed].filter(f => !called.has(f)).sort();
  assert.deepEqual(absent, [], `callable but not in the census: ${absent.join(', ')}`);
  assert.deepEqual(stale, [], `in the census but no longer callable: ${stale.join(', ')}`);
});

test('probe-only routes are declared, so a 404 is not read as a feature', () => {
  const block = inventory.match(/```routes-probe-only\n([\s\S]*?)```/);
  assert.ok(block, 'the routes-probe-only block is missing');
  const probes = block[1].split('\n').map(s => s.trim()).filter(Boolean);
  const called = calledFamilies(client);
  for (const p of probes) {
    assert.ok(called.has(family(p)),
      `${p} is declared probe-only but nothing calls it — delete the declaration`);
  }
});

test('live/app is present with the fields LL-HLS needs', () => {
  assert.ok(calledFamilies(client).has('/server/{s}/live/app'),
    'the client lost its live applications methods');
  for (const field of ['alhls_enabled', 'hls_part_duration', 'chunk_duration']) {
    assert.ok(inventory.includes(field), `${field} is not documented in the inventory`);
  }
});

// The bound that makes the difference between a working setting and a ticked
// box. Written here because it is the kind of rule that gets dropped in a
// refactor and produces no error when it is.
test('the part-duration bound is recorded, not just the field name', () => {
  // 500, not 250: the reference's number is stale and the server refuses it.
  // This check used to require 250 and would have kept the wrong figure in the
  // document by insisting on it.
  assert.match(inventory, /greater or equal to 500 ms/,
    'the measured lower bound on hls_part_duration is missing');
  assert.match(inventory, /reference says 250 and is stale|the reference says 250/,
    'the document does not say the published 250 is wrong');
  assert.match(inventory, /chunk_duration.{0,40}(2|half)/is,
    'the upper bound — half the chunk — is missing');
});

// --- the gate, proven by contradiction -------------------------------------
//
// Cut live/app out of a copy of the inventory. The first check must fail on
// it. If it does not, the check is decorative and this file is lying.
test('the gate fails when the inventory forgets a callable route', () => {
  const mutilated = inventory
    .replace(/^.*live\/app.*$/gm, '')
    .replace(/```routes-called\n[\s\S]*?```/, '```routes-called\n/server\n```');
  const called = calledFamilies(client);
  const documented = documentedFamilies(mutilated);
  const missing = [...called].filter(f => !documented.has(f));
  assert.ok(missing.includes('/server/{s}/live/app'),
    'removing live/app from the inventory did not make the check notice');
});

console.log(failures ? `\n${failures} inventory check(s) failed` : '\nall inventory checks passed');
process.exit(failures ? 1 : 0);
