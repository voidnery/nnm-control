// Typographic hierarchy, checkable.
//
// What this replaces was not a bug anyone could point at. Every rule was
// individually sane and the result was unusable: h2 at 15px over a 14px body —
// a ratio of 1.07 — and `.gsection` at 11px, a section heading *smaller* than
// the text beneath it. An operator said the pages were hard to use and could
// not say why, because there is nothing to point at. The numbers are the only
// place it shows.
//
// So the scale is a contract: steps at least 1.25 apart, headings above body,
// and nothing on the delivery pages allowed to shrink below the smallest step
// by way of an inline style, which is how a scale erodes — one `fontSize: 10`
// at a time, each of them locally reasonable.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const css = readFileSync(path.join(SRC, 'styles.css'), 'utf8');

let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };
const ok = (why) => console.log(`  ✓ ${why}`);

const px = (name) => {
  const m = css.match(new RegExp(`--${name}:\\s*([\\d.]+)px`));
  return m ? Number(m[1]) : null;
};

console.log('THE SCALE HAS STEPS:');

const ladder = ['fs-body', 'fs-lead', 'fs-h2', 'fs-h1'];
const sizes = ladder.map(px);
if (sizes.some(v => v === null)) {
  fail(`the scale is not declared: ${ladder.filter((_, i) => sizes[i] === null).join(', ')} missing`);
} else {
  let flat = false;
  for (let i = 1; i < sizes.length; i++) {
    const ratio = sizes[i] / sizes[i - 1];
    if (ratio < 1.25) {
      fail(`${ladder[i - 1]} → ${ladder[i]} is ${ratio.toFixed(2)}; below 1.25 a difference reads as a mistake, not a level`);
      flat = true;
    }
  }
  if (!flat) ok(`${sizes.join(' → ')} — every step at least 1.25`);
}

const meta = px('fs-meta'), micro = px('fs-micro'), body = px('fs-body');
if (meta && body && meta >= body) fail('fs-meta is not smaller than the body; de-emphasis that is not smaller is not de-emphasis');
else if (micro && meta && micro >= meta) fail('fs-micro is not smaller than fs-meta');
else ok('de-emphasis sizes sit below the body size');

console.log('\nHEADINGS ARE BIGGER THAN WHAT THEY HEAD:');

// The specific failure that made the pages unreadable: a section heading set
// smaller than its own contents.
const block = (sel) => {
  const i = css.indexOf(sel + ' {');
  return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
};
for (const [sel, floor] of [['.gsection', 'fs-lead'], ['h2', 'fs-h2'], ['h1', 'fs-h1']]) {
  const b = block(sel);
  if (!b) { fail(`${sel} is not defined`); continue; }
  if (!b.includes(`var(--${floor})`)) {
    fail(`${sel} does not use var(--${floor}); it can drift off the scale silently`);
  } else {
    ok(`${sel} is set from the scale`);
  }
}

console.log('\nTHE SCALE IS NOT ERODED INLINE:');

// Inline font sizes are how a scale dies: each one is locally reasonable and
// the page ends up with nine sizes and no hierarchy. Small ones are the
// problem, so that is what is banned.
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.jsx')) files.push(p);
  }
})(path.join(SRC, 'components'));

const FLOOR = micro || 11.5;
let offenders = 0;
for (const f of files) {
  if (!/Delivery|Gateway|Config|Globe|Probe/.test(path.basename(f))) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) {
    if (Number(m[1]) < FLOOR) {
      fail(`${path.basename(f)} sets fontSize ${m[1]}, below the smallest step (${FLOOR})`);
      offenders++;
    }
  }
}
if (!offenders) ok(`no delivery component sets a size below ${FLOOR}px inline`);

console.log('\nNO NESTED CARDS ON THE DELIVERY PAGES:');

// Two containers competing and neither winning. The panel-inside-a-panel was
// how every result block on these pages was built.
// Actual nesting, not a count. The first version counted `className="panel"`
// per file and called two siblings a nest — which is how a gate ends up
// demanding a worse layout than the one it found. This walks forward from each
// panel to its own closing tag and looks inside that span only.
const nestedPanelIn = (src) => {
  const open = /<div className="panel"/g;
  let m;
  while ((m = open.exec(src))) {
    let depth = 0, i = m.index;
    for (;;) {
      const nextOpen = src.indexOf('<div', i + 1);
      const nextClose = src.indexOf('</div>', i + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen; continue; }
      if (depth === 0) {
        // From after this panel's own opening tag. Starting at m.index + 1
        // included its own `className="panel"` in the span, so every file with
        // a single panel reported itself as nested — a check that fires on
        // everything is indistinguishable from a check that fires on nothing.
        const inner = src.slice(src.indexOf('>', m.index) + 1, nextClose);
        if (/className="panel"/.test(inner)) return true;
        break;
      }
      depth--; i = nextClose;
    }
  }
  return false;
};

let nested = 0;
for (const f of files) {
  if (!/Delivery|Gateway|Config|Globe|Probe/.test(path.basename(f))) continue;
  if (nestedPanelIn(readFileSync(f, 'utf8'))) {
    fail(`${path.basename(f)} puts a panel inside a panel: two containers competing, neither winning`);
    nested++;
  }
}
if (!nested) ok('no delivery component nests one card in another');

console.log(bad ? `\n${bad} typography problem(s)` : '\ntypography audit: OK');
process.exit(bad ? 1 : 0);
