// Every wizard key the backend can emit has a string, in both languages.
//
// The setup wizard builds its key at runtime — `t('step.' + id + '.' + code)`
// — so no check over literal keys can see it, and none did. v1.31.0 shipped
// with `step.channels.carried-undeclared` on the operator's screen, printed as
// its own name, next to `step.verify.empty` which had been doing the same for
// longer. Both were reported by the person looking at the page.
//
// A missing translation does not throw: `t()` returns the key. So the screen
// stays up, the layout is intact, and the only symptom is a line of code where
// a sentence belongs — the same shape as a caught exception rendering as
// absence.
//
// The keys are taken from the source by walking each `add(...)` call with a
// balanced-paren reader rather than a regular expression. The first attempt
// used one and reported four keys as missing that are unreachable, because it
// could not tell which calls carry a `code`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const steps = readFileSync(new URL('../src/services/networkSteps.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');

// The text of one `add(` call, from its opening paren to the matching close.
// Quotes and comments are not tracked, because neither appears with unbalanced
// parens in this file; if that changes, the reader stops early and the call is
// reported rather than skipped.
function callAt(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

export function stepKeys(src) {
  const out = [];
  const re = /\badd\(/g;
  let m;
  while ((m = re.exec(src))) {
    const body = callAt(src, m.index + 3);
    assert.ok(body !== null, `unbalanced add( at offset ${m.index}`);
    const head = /^\s*'([a-z]+)'\s*,\s*'([a-z]+)'/.exec(body);
    if (!head) continue;
    const [, id, state] = head;
    // The screen prefers the code and falls back to the state:
    // `code ? t('step.'+id+'.'+code) : t('step.'+id+'.'+state)`. So a call
    // that carries a code never renders its state key, which is why four of
    // them are legitimately absent.
    const code = /\bcode:\s*'([a-z0-9-]+)'/.exec(body);
    out.push({ id, state, code: code ? code[1] : null,
               key: `step.${id}.${code ? code[1] : state}` });
  }
  return out;
}

const emitted = stepKeys(steps);
// Both dictionaries, so a key present only in English is still a bug on a
// panel whose operators work in Russian.
const has = (key) => (i18n.match(new RegExp(`'${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'\\s*:`, 'g')) || []).length;

console.log('\nEVERY KEY THE WIZARD CAN PRINT HAS A SENTENCE:');

check('the reader found the calls at all', () => {
  // A parser that silently matched nothing would make every check below pass.
  assert.ok(emitted.length >= 20, `only ${emitted.length} add() calls found`);
  assert.ok(emitted.some(e => e.code), 'no call with a code was recognised');
  assert.ok(emitted.some(e => !e.code), 'no call without a code was recognised');
});

check('every emitted key exists', () => {
  const missing = emitted.filter(e => has(e.key) === 0).map(e => e.key);
  assert.deepEqual([...new Set(missing)], [],
    `printed as their own name on the page: ${[...new Set(missing)].join(', ')}`);
});

check('every emitted key exists twice — English and Russian', () => {
  const once = emitted.filter(e => has(e.key) === 1).map(e => e.key);
  assert.deepEqual([...new Set(once)], [],
    `defined in one language only: ${[...new Set(once)].join(', ')}`);
});

check('every step id has a title', () => {
  for (const id of new Set(emitted.map(e => e.id))) {
    assert.equal(has(`step.${id}`), 2, `step.${id} is not titled in both languages`);
  }
});

check('the keys that broke are named, so this cannot pass by finding nothing', () => {
  // The four from v1.31.0, listed so that a reader who deletes the general
  // check still leaves evidence of what it was for.
  for (const k of ['step.channels.carried-undeclared', 'step.channels.carried-conflict',
                   'step.channels.unknown', 'step.verify.empty']) {
    assert.ok(emitted.some(e => e.key === k), `${k} is no longer emitted — remove it from this list`);
    assert.equal(has(k), 2, `${k} has no sentence`);
  }
});

if (failures) { console.log(`\n${failures} wizard-string check(s) failed`); process.exit(1); }
console.log('\nall wizard-string checks passed');
