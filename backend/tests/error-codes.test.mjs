// Failure codes, and the sentences for them.
//
// What shipped: `readConf` caught an exception, put its **message** where a
// code belonged, and the page did `t('llhls.confError.' + that)`. A Russian
// interface displayed
//
//     llhls.confError.agent is not enabled for this server
//
// Three faults in one line. A message used as a code. A computed translation
// key, which renders as itself when nothing matches. And an i18n audit that
// reads static `t('literal')` calls and therefore could not see the key at all
// — so nothing failed until an operator sent a screenshot.
//
// All three are addressed by the same shape, and these checks are what keep it:
// the API's codes are a declared list, the interface handles each one with a
// literal `t()` the audit can see, and the two lists have to match.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONF_ERROR_CODES } from '../src/routes/llhls.js';

const here = dirname(fileURLToPath(import.meta.url));
const confErrors = readFileSync(
  join(here, '..', '..', 'frontend', 'src', 'lib', 'confErrors.jsx'), 'utf8');
const i18n = readFileSync(join(here, '..', '..', 'frontend', 'src', 'i18n.jsx'), 'utf8');
const routes = readFileSync(join(here, '..', 'src', 'routes', 'llhls.js'), 'utf8');
const bus = readFileSync(join(here, '..', 'src', 'services', 'agentBus.js'), 'utf8');
const page = readFileSync(join(here, '..', '..', 'frontend', 'src', 'pages', 'LlhlsPage.jsx'), 'utf8');

// Comments are prose about the code, not the code. Two checks below look for a
// pattern that must not be *called*, and both files explain in a comment
// exactly which pattern that is — so without this they failed on their own
// documentation. Fourth instance of this shape in the project after the
// clipboard audit, and the same fix: narrow the check to what it is about.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Failure codes\n');

// The codes the interface answers, read out of the switch rather than declared
// twice.
const handled = [...confErrors.matchAll(/case '([a-z-]+)':\s*return t\('llhls\.confError\.([a-z-]+)'\)/g)];

check('the interface answers every code the API can return', () => {
  const cases = handled.map(m => m[1]);
  const missing = CONF_ERROR_CODES.filter(c => c !== 'unknown' && !cases.includes(c));
  assert.deepEqual(missing, [],
    `these codes reach the interface with no sentence for them: ${missing.join(', ')}`);
});

check('the interface answers nothing the API cannot return', () => {
  const cases = handled.map(m => m[1]);
  const extra = cases.filter(c => !CONF_ERROR_CODES.includes(c));
  assert.deepEqual(extra, [], `dead branches for codes nothing produces: ${extra.join(', ')}`);
});

check('each case returns the key for its own code, not a neighbour\'s', () => {
  // A copy-pasted switch where two branches return the same key is invisible
  // until the wrong sentence appears on screen.
  for (const [, code, key] of handled) {
    assert.equal(key, code, `the branch for ${code} returns the sentence for ${key}`);
  }
});

check('every code has a sentence and a fix, in both languages', () => {
  const has = (key) => new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:`, 'g');
  for (const code of CONF_ERROR_CODES) {
    for (const prefix of ['llhls.confError.', 'llhls.confFix.']) {
      const hits = (i18n.match(has(prefix + code)) || []).length;
      assert.equal(hits, 2,
        `${prefix}${code} appears ${hits} time(s) in i18n.jsx — it needs one EN and one RU`);
    }
  }
});

// --- the shapes that let the fault happen -----------------------------------

check('the page builds no translation key out of a value', () => {
  const src = code(page);
  assert.ok(!/t\(`llhls\.confError\.\$\{/.test(src) && !/t\('llhls\.confError\.'\s*\+/.test(src),
    'a computed key is back, and it renders as itself when nothing matches');
});

check('a message is never returned where a code belongs', () => {
  // The catch used to be `return { error: String(e.message) }`.
  assert.ok(!/error: String\(e\?\.message/.test(routes),
    'an exception message is being returned as an error code again');
  assert.match(routes, /detail: String\(e\?\.message/,
    'the raw message should still travel, beside the code and never instead of it');
});

check('an unrecognised code becomes `unknown` rather than being passed through', () => {
  assert.match(routes, /CONF_ERROR_CODES\.includes\(e\?\.code\) \? e\.code : 'unknown'/);
});

check('the bus attaches codes to the failures it knows about', () => {
  // Without these, `readConf` has nothing to map and every failure is
  // `unknown` — technically correct, useless in practice.
  for (const code of ['agent-disabled', 'agent-offline', 'agent-timeout']) {
    assert.ok(bus.includes(`'${code}'`), `agentBus does not label ${code}`);
  }
});

check('the fallback branch exists, so a future code cannot render as itself', () => {
  assert.match(confErrors, /default: return t\('llhls\.confError\.unknown'\)/);
  assert.match(confErrors, /default: return t\('llhls\.confFix\.unknown'\)/);
});

check('every key in the switch is a literal the i18n audit can see', () => {
  // The audit reads static `t('literal')`. A template or a concatenation is
  // invisible to it, which is how the missing string reached a screenshot.
  const dynamic = code(confErrors).match(/t\(\s*[`'"][^'"`]*\$\{|t\(\s*'[^']*'\s*\+/g);
  assert.equal(dynamic, null, `computed keys in confErrors.jsx: ${dynamic}`);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall failure-code checks passed');
process.exit(failures ? 1 : 0);
