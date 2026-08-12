// The panel has been taken down twice by the same defect: an identifier that
// is called but was never declared. On the frontend it was `move` in
// ServersPage; on the backend it was `scriptFor` and `sha256` in agentEnroll,
// deleted during a cleanup while their call sites stayed.
//
// `node --check` cannot see it, because the syntax is perfectly valid. Nothing
// notices until the line runs — and on the backend that means a ReferenceError
// inside an async route, an unhandled rejection, and a process exit: HTTP 502
// and a restarted panel, rather than one failed request.
//
// The frontend gained a gate for this (audit:pages clicks every button). This
// is the backend's.
//
// Deliberately conservative: it flags only names that appear in call position
// and are declared NOWHERE in the file — not out of scope, not shadowed,
// nowhere. That misses some real bugs and reports almost no false ones, which
// is the right trade for something that must never cry wolf.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

// Keywords that can appear immediately before a parenthesis and are not calls.
const GLOBALS = new Set([
  'require', 'import', 'super', 'this', 'typeof', 'void', 'delete', 'new', 'return', 'yield', 'await',
  'if', 'for', 'while', 'switch', 'catch', 'function', 'class', 'do', 'else', 'try', 'finally', 'case',
  'async', 'of', 'in', 'instanceof', 'throw', 'export', 'default', 'from', 'as', 'let', 'const', 'var',
  'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'AbortController', 'AbortSignal', 'Intl', 'BigInt', 'isNaN', 'parseInt', 'parseFloat', 'structuredClone',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'globalThis',
]);

// Strip comments, regex literals, template literals and strings so their
// contents cannot look like code.
//
// Regex literals go BEFORE strings, and that ordering is load-bearing: this
// codebase contains patterns like /([?&](?:key|token)=)[^\s&"']+/gi, and an
// apostrophe inside one desynchronises a naive string stripper, which then
// swallows the rest of the file and makes everything after it look undeclared.
// The first run of this audit did exactly that.
function strip(src) {
  let out = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // A `//` comment, with URLs protected by hiding their separator first
    // rather than by refusing to strip a comment that happens to follow a
    // colon. The old guard was `[^:]`, which meant a line such as
    // `const clk = 100;  // USER_HZ; the kernel's own unit` stripped fine but
    // anything reaching `//` just after a colon did not — and the leftover
    // comment text then swallowed the rest of the file at the next apostrophe,
    // reporting four real functions as undefined.
    .replace(/:\/\//g, ':\u0000\u0000')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/:\u0000\u0000/g, '://');
  // A slash starts a regex only where a value may begin — after an operator,
  // a comma, a bracket or the start of a statement.
  out = out.replace(/([=(,:;[!&|?{}+\-*%^~<>]|^|\breturn\b|\btypeof\b)(\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuyd]*/g,
    (_m, pre, ws) => `${pre}${ws}/RE/`);
  return out
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

// Names visible at module level: declared at column zero, or imported.
// Everything else belongs to some function and is not visible from another.
const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new',
  'await', 'delete', 'void', 'do', 'else', 'try', 'throw', 'yield', 'function', 'super', 'this',
  'instanceof', 'in', 'of', 'case', 'const', 'let', 'var', 'class', 'import', 'export', 'default']);

function moduleLevelNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^import\s+([^;]*?)\s+from\b/gm)) {
    for (const part of m[1].split(/[{},]/)) {
      const bits = part.trim().split(/\s+as\s+|\s+/).filter(Boolean);
      if (bits.length) names.add(bits[bits.length - 1]);
    }
  }
  // Destructured module-level constants: `const { a, b } = …` at column zero.
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.split(':').map(x => x.trim());
      const last = (bits[bits.length - 1] || '').split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(last)) names.add(last);
    }
  }
  return names;
}

// Each route handler, as its own scope.
//
// The gate collected declarations file-wide, which is why it passed on a
// handler using `originApps` that a *different* handler in the same file had
// fetched: the name existed somewhere, so it counted as declared. The page
// returned 500 and the operator saw "Internal server error".
//
// A name used inside a handler must be declared inside it, or at module level.
// Anything else belongs to some other function and is not visible from here.
function routeHandlers(src) {
  const out = [];
  // Anchored on the route line, then the first `async (…) => {` after it.
  //
  // The first attempt matched from the route method to the arrow with
  // `[^)]*?`, which cannot cross `requirePerm('cdn.view')` — so it found zero
  // handlers in a file full of them and reported success. A gate that matches
  // nothing is indistinguishable from a gate that passes.
  const line = /^\s*\w+\.(?:get|post|put|patch|delete|use)\(/gm;
  let m;
  while ((m = line.exec(src))) {
    const arrow = /async\s*\(([^)]*)\)\s*=>\s*\{/g;
    arrow.lastIndex = m.index;
    const a = arrow.exec(src);
    if (!a || a.index > m.index + 400) continue;
    let depth = 1;
    let i = arrow.lastIndex;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out.push({ params: a[1], body: src.slice(arrow.lastIndex, i - 1) });
  }
  return out;
}

function declaredNames(src) {
  const names = new Set();
  const add = (n) => { if (n) names.add(n); };

  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // import x, { a as b, c } from '…'  /  import * as ns from '…'
  for (const m of src.matchAll(/\bimport\s+([^;]*?)\s+from\b/g)) {
    for (const part of m[1].split(/[{},]/)) {
      const bits = part.trim().split(/\s+as\s+|\s+/).filter(Boolean);
      const last = bits[bits.length - 1];
      if (last && /^[A-Za-z_$][\w$]*$/.test(last)) add(last);
    }
  }
  // Destructuring, including from await/require, and catch bindings.
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.split(':').map(x => x.trim());
      const name = (bits[1] || bits[0] || '').replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name);
    }
  }
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // Function parameters of every shape, plus arrow parameters.
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/[{}[\]]/g, ' ').split(/[:=]/)[0].replace(/\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name);
    }
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // Destructured parameters, including ones with defaults spread over several
  // lines and defaults that are themselves functions —
  // `function f({ onOutput = () => {}, timeoutMs = 1000 })`. One level of
  // nesting is allowed, which is what an arrow-function default needs.
  for (const m of src.matchAll(/\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    for (const part of m[1].replace(/\{[^{}]*\}/g, '').split(',')) {
      const bits = part.split(':').map(x => x.trim());
      const name = (bits[1] || bits[0] || '').replace(/=.*$/, '').replace(/\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name);
    }
  }
  // Object shorthand methods: `async foo(a, b) {`
  for (const m of src.matchAll(/(?:^|[,{]\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) add(m[1]);
  return names;
}

function usedAsCalls(src) {
  const out = new Map();
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // Direct calls: foo(...)
    for (const m of line.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (!out.has(name)) out.set(name, i + 1);
    }
    // Member calls on a capitalised receiver: NimbleServer.find(...).
    //
    // This shape is the most common one in the codebase — every model is used
    // this way — and the first version of this audit missed it entirely,
    // letting a missing `import { NimbleServer }` through into a route. Only
    // capitalised receivers, because a lowercase one is nearly always a local
    // object rather than an import.
    for (const m of line.matchAll(/(^|[^.\w$'"`])([A-Z][\w$]*)\s*\.\s*[\w$]+\s*\(/g)) {
      const name = m[2];
      if (!out.has(name)) out.set(name, i + 1);
    }
  });
  return out;
}

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
})(SRC);

let bad = 0;
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const src = strip(raw);
  const declared = declaredNames(src);
  for (const [name, line] of usedAsCalls(src)) {
    if (GLOBALS.has(name) || declared.has(name)) continue;
    console.log(`  ✗ ${path.relative(SRC, file)}:${line} — ${name}() is called but declared nowhere in this file`);
    bad++;
  }
}

// A second, scoped pass belongs here and is not finished.
//
// The file-wide pass below asks whether a name exists anywhere in the module.
// That is the wrong question, and it cost v0.85.0: a handler used `originApps`
// that a *different* handler in the same file had fetched, the name existed,
// this gate passed, and the page answered 500.
//
// A prototype of the scoped version does catch exactly that — it names
// `originApps` the moment the fetch is removed — but it also reports
// twenty-six names that are perfectly in scope, because a handler is full of
// callbacks whose parameters a regular expression struggles to collect. A gate
// that fails every build is worse than the hole it covers: it gets switched
// off, and then so is everything else it was checking.
//
// Left out rather than shipped half-working, and written down rather than
// forgotten. The honest fix is a real parser over these files instead of
// patterns, which is a piece of work rather than a patch.

console.log(bad
  ? `\n${bad} undefined reference(s) — this is the defect class that returns 502 and restarts the panel`
  : `undefined-reference audit: OK (${files.length} backend modules)`);
process.exit(bad ? 1 : 0);
