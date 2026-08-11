import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Two faults that every existing gate was blind to, made checkable.
//
// The first: a dialog written by hand with `modal-backdrop` — a class the
// stylesheet does not define, against the project's `modal-back`. It compiled,
// it rendered, it passed the click gate, and it appeared as a plain box in the
// page flow below the table it was editing. Nothing about it was wrong except
// that it was not a dialog.
//
// The second: `POST /servers/:id/geo/resolve` wrote a country to the database
// and `GET /servers` never returned the field. The button worked perfectly and
// the only symptom was that nothing on screen changed — which is
// indistinguishable from a dead control, and is how it was reported.
//
// The pattern behind both is the same: a thing that exists on one side of a
// boundary and not the other, where neither side is obviously broken.
import { readFileSync, readdirSync, statSync } from 'node:fs';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const BACKEND = path.resolve(SRC, '../../backend/src');

const jsx = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.jsx')) jsx.push(p);
  }
})(SRC);

let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };
const ok = (why) => console.log(`  ✓ ${why}`);

console.log('DIALOGS ARE DIALOGS:');

// Whatever class names the stylesheet actually defines. A component may only
// use one of those; inventing a neighbouring name produces markup that renders
// in the flow and looks like a layout bug rather than a typo.
const css = readFileSync(path.join(SRC, 'styles.css'), 'utf8');
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)\s*[{,:]/g)].map(m => m[1]));

let overlayUses = 0;
for (const f of jsx) {
  const src = readFileSync(f, 'utf8');
  const name = path.basename(f);
  for (const m of src.matchAll(/className="([^"{}]*)"/g)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      if (/^(modal|dialog|overlay|backdrop)/.test(cls) || /-(modal|backdrop|overlay)$/.test(cls)) {
        overlayUses++;
        if (!definedClasses.has(cls)) {
          fail(`${name} uses "${cls}", which the stylesheet does not define — `
             + 'it will render in the page flow instead of over it');
        }
      }
    }
  }
}
if (overlayUses) ok(`${overlayUses} overlay class use(s), all defined in the stylesheet`);

// Anything that renders a form with Cancel/Save should be going through the
// shared component rather than assembling its own backdrop.
for (const f of jsx) {
  const src = readFileSync(f, 'utf8');
  const name = path.basename(f);
  if (path.basename(f) === 'Modal.jsx') continue;
  if (/className="modal-back"/.test(src) && !/from '.*Modal\.jsx'/.test(src)) {
    fail(`${name} builds its own backdrop instead of using Modal.jsx`);
  }
}
ok('no component rolls its own backdrop');

console.log('\nWHAT THE PANEL WRITES, THE PANEL RETURNS:');

// Every field the server model persists under `geo` has to survive the
// projection that GET /servers applies, or the panel writes into a void.
const model = readFileSync(path.join(BACKEND, 'models/NimbleServer.js'), 'utf8');
const routes = readFileSync(path.join(BACKEND, 'routes/servers.js'), 'utf8');

const geoBlock = model.slice(model.indexOf('geo: {'), model.indexOf('order: {'));
const geoFields = [...geoBlock.matchAll(/^\s{4}(\w+):\s*\{\s*type:/gm)].map(m => m[1]);
if (geoFields.length < 5) {
  fail('could not read the geo fields out of the server model; this check has lost its subject');
} else {
  const pub = routes.slice(routes.indexOf('const pub = (s) =>'), routes.indexOf('serversRouter.get'));
  const missing = geoFields.filter(f => !new RegExp(`\\b${f}\\b`).test(pub));
  if (missing.length) {
    fail(`GET /servers does not return geo.${missing.join(', geo.')} — the panel `
       + 'stores it and can never show it back');
  } else {
    ok(`all ${geoFields.length} stored geo field(s) are returned by GET /servers`);
  }
}

// And the control that writes them must have somewhere to write to.
if (!/geo\/resolve/.test(readFileSync(path.join(BACKEND, 'routes/geoip.js'), 'utf8'))) {
  fail('the resolve endpoint is gone');
} else {
  ok('the resolve endpoint exists');
}

console.log(bad ? `\n${bad} problem(s)` : '\ndialog & payload audit: OK');
process.exit(bad ? 1 : 0);
