// A setting the backend stores, the API returns and nothing can switch on.
//
// This has now shipped twice: log collection (iter10 → v0.17.1) and host
// metrics (iter15 m1 → v0.22.12). Both times the model, the gateway and the
// agent were complete and correct, and the operator had no way to turn the
// feature on — so it collected nothing and looked broken.
//
// The check is deliberately blunt: every top-level block the settings route
// returns must be mentioned somewhere in the settings page. It cannot tell a
// real control from a stray string, but it catches a block with no UI at all,
// which is the failure that actually happened.
import { readFileSync } from 'node:fs';

const routeSrc = readFileSync(new URL('../../backend/src/routes/settings.js', import.meta.url), 'utf8');
const pageSrc = readFileSync(new URL('../src/pages/SettingsPage.jsx', import.meta.url), 'utf8');

// The shape the settings route serves is built by `pub()`, not inline in the
// handler — the first version of this audit read the handler, found nothing,
// and reported OK. A check that examines the wrong thing is worse than none.
const from = routeSrc.indexOf('const pub =');
if (from < 0) { console.log('  ✗ cannot find the settings shape builder — this audit is looking at the wrong thing'); process.exit(1); }
const body = routeSrc.slice(from, routeSrc.indexOf('\n});', from));
const blocks = [...body.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
if (blocks.length < 3) { console.log(`  ✗ only ${blocks.length} field(s) parsed — the audit is not reading the shape`); process.exit(1); }

// Blocks the page has no business exposing.
const INTERNAL = new Set(['wmspanel']);

let bad = 0;
for (const b of blocks) {
  if (INTERNAL.has(b)) continue;
  const used = new RegExp(`\\b${b}\\b`).test(pageSrc);
  if (!used) {
    console.log(`  ✗ settings.${b} is stored and served, but the settings page never mentions it — ` +
                'there is no way for an operator to turn it on');
    bad++;
  }
}

console.log(bad
  ? `\n${bad} setting(s) with no control`
  : `settings audit: OK (${blocks.length} block(s), each reachable from the page)`);
process.exit(bad ? 1 : 0);
