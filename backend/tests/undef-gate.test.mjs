// The gate that failed three times, tested against the three failures.
//
// Twice a name was deleted in a cleanup while its call sites stayed. The third
// time a route handler read `originApps` that a *different* handler in the same
// file fetched — and the regex version asked only whether the name existed
// somewhere in the module. It did. The channels page answered 500.
//
// The version before this one was scoped and reported twenty-six names that
// were perfectly in scope. Both halves matter and both are checked here:
// it must catch the real thing, and it must be silent about the rest.
import assert from 'node:assert/strict';
import { undefinedIdentifiers } from '../scripts/undef-audit.mjs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};
const names = (src) => undefinedIdentifiers(src).map(h => h.name);

console.log('\nTHE THREE FAILURES THAT SHIPPED:');

check('a name fetched by another handler in the same file', () => {
  // v0.85.0, exactly: `originApps` exists in the module, in the wrong scope.
  const src = `
    import { wms } from './w.js';
    const router = {};
    router.get('/a', async (req, res) => {
      const originApps = await wms.list();
      res.json(originApps);
    });
    router.get('/b', async (req, res) => {
      res.json(status(c, { originApps }));
    });
    function status(c, o) { return o; }
  `;
  assert.ok(names(src).includes('originApps'), 'the defect that took the page down is still invisible');
});

check('a function deleted while its call sites stayed', () => {
  const src = `export function enroll() { return scriptFor('x'); }`;
  assert.deepEqual(names(src), ['scriptFor']);
});

check('a helper removed from a component', () => {
  const src = `const rows = []; export const up = (i) => move(rows, i, i - 1);`;
  assert.deepEqual(names(src), ['move']);
});

console.log('\nAND SILENT ABOUT EVERYTHING THE REGEX VERSION SHOUTED AT:');

check('parameters of a callback are declared', () => {
  // Twenty-six of these is what discredited the previous attempt.
  const src = `const xs = [1]; xs.map(x => x + 1); xs.forEach((v, i) => v + i);`;
  assert.deepEqual(names(src), []);
});

check('a catch binding is declared', () => {
  const src = `try { JSON.parse('x'); } catch (e) { console.log(e.message); }`;
  assert.deepEqual(names(src), []);
});

check('destructured parameters, nested and defaulted and rested', () => {
  const src = `
    function f({ a, b: { c }, d = 1, ...rest }, [e, , g] = []) {
      return a + c + d + e + g + Object.keys(rest).length;
    }
    f({ a: 1, b: { c: 2 } });
  `;
  assert.deepEqual(names(src), []);
});

check('an object key is not a read, and a shorthand value is', () => {
  // The distinction the whole rewrite turns on: acorn gives one node type for
  // both, and only `shorthand` tells them apart.
  assert.deepEqual(names(`const o = { missing: 1 };`), []);
  assert.deepEqual(names(`const o = { missing };`), ['missing']);
});

check('a property access is not a reference to the property', () => {
  const src = `const o = {}; o.whatever.deeper;`;
  assert.deepEqual(names(src), []);
});

check('a computed property is a read', () => {
  // `o[key]` genuinely reads `key`; `o.key` does not.
  assert.deepEqual(names(`const o = {}; o[missing];`), ['missing']);
});

check('imports, exports and class members are declared', () => {
  const src = `
    import fs, { readFile as rf } from 'node:fs';
    export class A { #p = 1; go() { return rf(fs, this.#p); } }
  `;
  assert.deepEqual(names(src), []);
});

check('a name declared later in the same scope is not reported', () => {
  // Over-approximating on purpose: this looks for names that exist nowhere,
  // not for names used early. A temporal-dead-zone check is a different tool
  // with a different false-positive rate.
  assert.deepEqual(names(`function f() { return later; } const later = 1; f();`), []);
});

check('a label is not a variable', () => {
  const src = `outer: for (const x of [1]) { if (x) break outer; }`;
  assert.deepEqual(names(src), []);
});

check('a nested function sees the scope enclosing it', () => {
  const src = `
    export async function handler(req, res) {
      const rows = await Promise.resolve([]);
      const mapped = rows.map((r) => ({ id: r.id, all: rows.length }));
      res.json(mapped);
    }
  `;
  assert.deepEqual(names(src), []);
});

console.log('\nA FILE IT CANNOT PARSE IS SAID SO, NOT PASSED:');

check('a syntax error is reported rather than skipped', () => {
  // Silently passing an unparseable file is how a gate reports success about
  // code it never looked at.
  const hits = undefinedIdentifiers(`const a = ;`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].name, /parse error/);
});

console.log(failures ? `\n${failures} gate check(s) failed` : '\nall undef-gate checks passed');
process.exit(failures ? 1 : 0);
