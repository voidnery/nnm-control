import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Three rungs, not five. The ladder that matters is body → heading; a second
// heading size wedged between them made every page feel oversized and added no
// clarity, which is what an operator meant by "everything got bigger and it is
// not a joy".
const ladder = ['fs-body', 'fs-lead', 'fs-h1'];
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

console.log('\nTHE SCALE STAYS COMPACT:');

// The other direction, and the one an operator actually complained about.
// A ladder with correct ratios can still be far too large: 15 → 19 → 24 → 30
// passed every check above and made the whole panel feel shouted. A dense
// operator tool is read at a desk, all day, next to a vMix window — so the
// body has a ceiling, and the page title is not allowed to become a banner.
if (body && body > 15) fail(`the body is ${body}px; above 15 a dense tool starts feeling shouted`);
else ok(`body at ${body}px`);
const h1 = px('fs-h1');
if (h1 && h1 > 24) fail(`the page title is ${h1}px, which is a banner, not a heading`);
else ok(`page title at ${h1}px`);

console.log('\nHEADINGS ARE BIGGER THAN WHAT THEY HEAD:');

// The specific failure that made the pages unreadable: a section heading set
// smaller than its own contents.
const block = (sel) => {
  const i = css.indexOf(sel + ' {');
  return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
};
for (const [sel, floor] of [['.gsection', 'fs-lead'], ['h2', 'fs-lead'], ['h1', 'fs-h1']]) {
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

console.log('\nDENSE SCREENS ARE SEPARATED, NOT JUST SPACED:');

// The complaint this answers: everything at the same weight, the same colour
// and the same distance apart, so the eye has nothing to grip and a wall of
// text happens to contain the answer. Weight alone does not do it — a bold
// heading in a dark theme reads as slightly-more-text — so a heading has to
// differ in colour, and blocks have to be divided by a rule rather than by
// hoping the reader notices four pixels of margin.
const rule = (sel) => {
  const i = css.indexOf(sel + ' {');
  return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
};
const allRules = (sel) => {
  const out = [];
  let i = -1;
  while ((i = css.indexOf(sel, i + 1)) !== -1) {
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    // Only when the selector ends here, so `.gsection` does not match
    // `.gsection-thing`.
    if (/^[\s{,:]/.test(css.slice(i + sel.length, i + sel.length + 1) || ' ')) {
      out.push(css.slice(brace, css.indexOf('}', brace)));
    }
  }
  return out.join(' ');
};

for (const [sel, what] of [['.gsection', 'section headings'], ['.gcol-h', 'column headings']]) {
  if (!/color:\s*var\(--accent/.test(allRules(sel))) {
    fail(`${what} (${sel}) are not set apart by colour, only by weight`);
  } else {
    ok(`${what} carry the accent colour`);
  }
}

if (!/border-top:\s*1px solid var\(--line/.test(allRules('.cfg-grid > div'))) {
  fail('the facts on "At a glance" have no rule between them');
} else {
  ok('the facts are ruled, not merely spaced');
}

if (!/margin-bottom:\s*var\(--sp-[45]\)/.test(allRules('.gpipe-card'))) {
  fail('the flow boards touch each other; they need room, not just a border');
} else {
  ok('the flow boards have room around them');
}

console.log('\nTHE SETUP CHAIN:');

if (!/animation:\s*steppop-in/.test(rule('.steppop'))) {
  fail('the step panel does not grow from its card');
// Scoped to a reduced-motion block that actually turns *this* animation off.
// The first version searched the whole stylesheet, and an unrelated
// reduced-motion rule elsewhere satisfied it — a check passing on evidence
// about something else.
// Both writings: a block spanning lines and one written on a single line.
// The first attempt required a newline before the closing brace and missed the
// one-liner that was right there — a check reporting a fault it had itself
// failed to look for.
} else if (!/@media[^{]*prefers-reduced-motion[\s\S]{0,400}?\.steppop[^}]*animation:\s*none/.test(css)) {
  fail('the animation has no reduced-motion escape; an animation is a way of '
     + 'saying where something came from, and somebody who asked for less of it '
     + 'has already been told');
} else {
  ok('the panel grows from its card, and stops for reduced motion');
}
if (!/transform-origin:\s*top/.test(rule('.steppop'))) {
  fail('the panel scales from its centre, which reads as "the page got longer" '
     + 'rather than "that card opened"');
} else {
  ok('it scales from the top edge');
}

console.log(bad ? `\n${bad} typography problem(s)` : '\ntypography audit: OK');
process.exit(bad ? 1 : 0);
