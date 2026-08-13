import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import { undefinedIdentifiers } from '../../backend/scripts/undef-audit.mjs';

// The same question, asked of the frontend.
//
// The backend has had this since v0.89.0 and the frontend has not, which is
// how `isGateway` shipped: used in three places in a dialog, declared nowhere,
// and every frontend gate passed. The render smoke test mounts pages, not
// every modal; hooks and i18n ask different questions entirely. A component
// that throws the moment somebody opens it is exactly the shape this catches,
// and it is worse here than on the backend — a thrown render takes the page
// with it and leaves a blank screen with no message.
//
// The parser lives in the backend's copy. Importing it rather than duplicating
// it, because two implementations of "what is in scope" would answer
// differently the first time either was touched.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

// A real JSX parser rather than a regular expression.
//
// The first version stripped the markup with patterns and left 69 of 79 files
// unparseable — a gate checking a eighth of the codebase and reporting OK.
// It refused to pass, which was the one thing it got right.
const JsxParser = Parser.extend(jsx());
const parseJsx = (src, opts) => JsxParser.parse(src, opts);

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.jsx') || e.endsWith('.js')) files.push(p);
  }
})(SRC);

// Names the browser provides, plus the ones JSX itself implies.
// Names Vite replaces at build time. They are genuinely not declared anywhere
// and genuinely work — read out of the config rather than listed here, so a
// define that is removed stops being excused the moment it is removed.
const viteConfig = readFileSync(path.resolve(HERE, '../vite.config.js'), 'utf8');
const DEFINED = new Set([...viteConfig.matchAll(/define\s*:\s*\{([\s\S]*?)\}/g)]
  .flatMap(m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(x => x[1])));

const EXTRA = new Set(['window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'alert', 'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event',
  'CustomEvent', 'DOMParser', 'Image', 'FileReader', 'WebSocket', 'EventSource', 'React']);

let bad = 0;
let parseFailures = 0;
for (const file of files) {
  const rel = path.relative(SRC, file);
  const hits = undefinedIdentifiers(readFileSync(file, 'utf8'), rel, { parse: parseJsx });
  for (const hit of hits) {
    if (hit.name === '(parse error)') {
      // Reported, not swallowed: a file this could not read is a file it did
      // not check, and saying "OK" about it would be the failure this whole
      // family of gates exists to avoid.
      parseFailures++;
      console.log(`  · ${rel}:${hit.line} — could not be parsed after stripping JSX, so it was not checked`);
      continue;
    }
    if (EXTRA.has(hit.name) || DEFINED.has(hit.name)) continue;
    console.log(`  ✗ ${rel}:${hit.line} — "${hit.name}" is used and declared in no scope that reaches it`);
    bad++;
  }
}

// A gate that cannot read its subject is not a gate. Whatever the reason, if
// this stops parsing the frontend it must say so loudly rather than keep
// reporting OK about files it never opened.
if (parseFailures > 0) {
  console.log(`\n${parseFailures} file(s) could not be parsed — this gate is not checking all of what it claims`);
  process.exit(1);
}

console.log(bad
  ? `\n${bad} undefined reference(s) — a component that throws the moment somebody opens it`
  : `frontend undefined-reference audit: OK (${files.length} files, ${parseFailures} unparsed)`);
process.exit(bad ? 1 : 0);
