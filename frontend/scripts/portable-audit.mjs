import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

// Gates that only run where they were written are not gates.
//
// Eight of the frontend checks carried an absolute path to the machine they
// were authored on. They passed for a year because that machine kept the
// project in the same directory; extracted anywhere else — a colleague's
// laptop, a CI runner, a release archive — every one of them failed to resolve
// React and the whole suite went red for a reason having nothing to do with
// the code under test.
//
// Nothing caught it, because the suite was never run anywhere else. This is
// what running it somewhere else would have said.
const HERE = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };

const files = readdirSync(HERE).filter(f => f.endsWith('.mjs'));
for (const f of files) {
  const src = readFileSync(path.join(HERE, f), 'utf8');
  // Two shapes, and only two. A developer home directory can never be right
  // in a checked-in script; an absolute path naming this repository is the
  // same mistake spelled differently.
  //
  // Deliberately not every absolute path: fixtures legitimately contain server
  // paths like /var/log/nimble, which are data about a Nimble box and not
  // something this script opens. A check that flags those trains people to
  // ignore it.
  for (const m of src.matchAll(/['"](\/(?:home|Users|root)\/[^'"]+)['"]/g)) {
    fail(`${f} hard-codes ${m[1]}; it will resolve to nothing anywhere else`);
  }
  for (const m of src.matchAll(/['"](\/[^'"]*nnm-control\/[^'"]+)['"]/g)) {
    fail(`${f} hard-codes ${m[1]}; the repository is wherever it was checked out`);
  }
}
if (!bad) console.log(`  ✓ ${files.length} script(s), none tied to one machine`);

console.log(bad ? `\n${bad} portability problem(s)` : '\nportability audit: OK');
process.exit(bad ? 1 : 0);
