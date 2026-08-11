import path from 'node:path';
import { fileURLToPath } from 'node:url';
// No machine word reaches a person without an explanation.
//
// A route answered `{"error":"not-found"}`, the page put that string in a red
// bar, and an operator read "not-found" about a server at 192.168.200.129.
// Every part of that was true. None of it said what happened, whose fault it
// was, or what to do — and the answer was "nothing is broken, type the city
// in", which is unguessable from the word displayed.
//
// The contract that replaces it has two halves, and this checks both:
//   - the API sends a stable code,
//   - the dictionaries carry `err.<code>` for it, in both languages, with a
//     `err.<code>.fix` saying what to do.
//
// The failure mode being prevented is not a missing translation. It is a new
// code being added months from now, reaching a user as a bare string, and
// nobody noticing because it renders perfectly.
import { readFileSync, readdirSync, statSync } from 'node:fs';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const BACKEND = path.resolve(SRC, '../../backend/src');

let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };
const ok = (why) => console.log(`  ✓ ${why}`);

const dict = readFileSync(path.join(SRC, 'i18n.jsx'), 'utf8');
const hasKey = (k) => (dict.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length;

// Every reason the geolocation service can return. Read out of the source so a
// new one cannot be added without this check seeing it.
const geoip = readFileSync(path.join(BACKEND, 'services/geoip.js'), 'utf8');
const codes = [...new Set([...geoip.matchAll(/reason:\s*'([a-z-]+)'/g)].map(m => m[1]))];

if (codes.length < 3) {
  fail('could not read the failure codes out of the geoip service; this check has lost its subject');
} else {
  ok(`${codes.length} failure code(s) found: ${codes.join(', ')}`);
}

for (const code of codes) {
  const n = hasKey('err.' + code);
  if (n === 0) {
    fail(`err.${code} is in no dictionary — an operator would be shown the word "${code}"`);
  } else if (n < 2) {
    fail(`err.${code} is in only one dictionary; the other language shows the raw code`);
  } else if (hasKey(`err.${code}.fix`) < 2) {
    fail(`err.${code} explains what happened but not what to do about it`);
  } else {
    ok(`err.${code} explains itself in both languages`);
  }
}

console.log('\nEVERY FINDING SAYS WHAT TO DO:');

// The configuration overview follows the same contract as errors: a code, a
// sentence, and a fix — in both languages. A finding with no fix is a
// complaint, and a panel full of complaints is one the operator scrolls past.
const overview = readFileSync(path.join(BACKEND, 'services/configOverview.js'), 'utf8');
const findings = [...new Set([...overview.matchAll(/add\('([a-z-]+)'/g)].map(m => m[1]))];
if (findings.length < 8) {
  fail(`only ${findings.length} finding code(s) found; this check has lost its subject`);
} else {
  ok(`${findings.length} finding code(s) found`);
}
for (const code of findings) {
  if (hasKey('cfg.' + code) < 2) {
    fail(`cfg.${code} is missing from a dictionary — the operator would see the raw code`);
  } else if (hasKey(`cfg.${code}.fix`) < 2) {
    fail(`cfg.${code} says what is true but not what to do about it`);
  }
}
if (findings.every(c => hasKey('cfg.' + c) === 2 && hasKey(`cfg.${c}.fix`) === 2)) {
  ok('every finding explains itself and its fix, in both languages');
}

// The explanation has to be reachable: a component that catches a failure and
// renders `e.message` puts the transport's words on screen instead.
const errors = readFileSync(path.join(SRC, 'lib/errors.js'), 'utf8');
if (!/t\('err\.' \+ code\)/.test(errors)) {
  fail('explainError no longer looks up a dictionary entry for the code');
} else {
  ok('explainError resolves the code through the dictionary');
}
if (!/err\.unknown/.test(errors)) {
  fail('there is no fallback for a code with no entry — it would render as blank or as itself');
} else {
  ok('an unrecognised code still produces a sentence');
}

// And the dialog must keep the raw detail available rather than discarding it:
// the person who fixes the code needs it, just not first.
const dialog = readFileSync(path.join(SRC, 'components/ErrorDialog.jsx'), 'utf8');
if (!/p\.detail/.test(dialog) || !/err\.detail/.test(dialog)) {
  fail('the error dialog drops the technical detail entirely');
} else {
  ok('the technical detail is kept, folded');
}

console.log(bad ? `\n${bad} problem(s) in error reporting` : '\nerror-reporting audit: OK');
process.exit(bad ? 1 : 0);
