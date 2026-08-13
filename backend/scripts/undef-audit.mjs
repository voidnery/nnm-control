import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

// An identifier used where nothing declares it.
//
// This defect class has taken the panel down three times. Twice a name was
// deleted in a cleanup while its call sites stayed — `move` in ServersPage,
// `scriptFor` in agentEnroll. The third time is why this file was rewritten: a
// route handler read `originApps`, a *different* handler in the same file
// fetched it, and the previous version asked only whether the name existed
// somewhere in the module. It did. The gate passed and the channels page
// answered 500.
//
// Regular expressions cannot answer this. Scope is a tree, and the first
// attempt at a scoped version reported twenty-six names that were perfectly in
// scope — parameters of callbacks it could not see. A gate that fails every
// build gets switched off, and then so is everything else it was checking.
//
// So: a parser. Every function pushes a frame, declarations land in the frame
// that owns them, and each identifier read is checked against the chain.
// `node --check` sees none of this because the syntax is valid; nothing
// notices until the line runs, and on the backend that means a ReferenceError
// inside an async route and a 500.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

const GLOBALS = new Set([
  'globalThis', 'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'AbortController', 'AbortSignal',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'Intl',
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'crypto', 'performance', 'require',
  '__dirname', '__filename', 'undefined', 'NaN', 'Infinity', 'arguments', 'module', 'exports',
]);

// acorn-walk has no base for JSX, and every walk in this file meets it once
// the caller passes a JSX parser — including the small ones that only collect
// declarations. Without a base they throw on the first `<div>`, which is loud
// but stops the gate dead.
//
// Built once and given to every walk: children are visited so an expression
// inside `{...}` is still checked, and the leaves are no-ops.
const BASE = { ...walk.base };
BASE.JSXElement = (n, st, c) => {
  if (n.openingElement) c(n.openingElement, st);
  for (const child of n.children || []) c(child, st);
};
BASE.JSXFragment = (n, st, c) => { for (const child of n.children || []) c(child, st); };
BASE.JSXOpeningElement = (n, st, c) => { for (const a of n.attributes || []) c(a, st); };
BASE.JSXAttribute = (n, st, c) => { if (n.value) c(n.value, st); };
BASE.JSXSpreadAttribute = (n, st, c) => { if (n.argument) c(n.argument, st); };
BASE.JSXSpreadChild = (n, st, c) => { if (n.expression) c(n.expression, st); };
BASE.JSXExpressionContainer = (n, st, c) => { if (n.expression) c(n.expression, st); };
BASE.JSXClosingElement = () => {};
BASE.JSXOpeningFragment = () => {};
BASE.JSXClosingFragment = () => {};
BASE.JSXIdentifier = () => {};
BASE.JSXMemberExpression = () => {};
BASE.JSXNamespacedName = () => {};
BASE.JSXText = () => {};
BASE.JSXEmptyExpression = () => {};

// Every name a binding pattern introduces: plain, destructured, defaulted,
// rested, nested. Written out because each shape a regex missed became a false
// positive, and false positives are what discredited the previous attempt.
export function bound(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') bound(p.argument, out);
        else bound(p.value, out);
      }
      break;
    case 'ArrayPattern': for (const e of node.elements) bound(e, out); break;
    case 'AssignmentPattern': bound(node.left, out); break;
    case 'RestElement': bound(node.argument, out); break;
    case 'Property': bound(node.value, out); break;
    default: break;
  }
  return out;
}

// Declarations belonging to this scope rather than to a nested one.
//
// One frame per function, not per block: that over-approximates in the
// operator's favour, treating a name declared later in the same scope as
// visible. This looks for names that exist nowhere, not for names used early —
// reporting a temporal dead zone would be a different check with a different
// false-positive rate.
function collect(node, add) {
  walk.recursive(node, null, {
    VariableDeclaration(n, st, c) {
      for (const d of n.declarations) {
        for (const name of bound(d.id)) add(name);
        if (d.init) c(d.init, st);
      }
    },
    FunctionDeclaration(n) { if (n.id) add(n.id.name); },
    ClassDeclaration(n) { if (n.id) add(n.id.name); },
    ImportDeclaration(n) { for (const sp of n.specifiers) add(sp.local.name); },
    FunctionExpression() {},
    ArrowFunctionExpression() {},
  }, BASE);
}

function scopeOf(fnNode) {
  const names = new Set();
  for (const p of fnNode.params || []) for (const n of bound(p)) names.add(n);
  if (fnNode.id) names.add(fnNode.id.name);
  if (fnNode.body) collect(fnNode.body, (n) => names.add(n));
  return names;
}

export function undefinedIdentifiers(source, filename = '<anonymous>', { parse: parseWith = parse } = {}) {
  let ast;
  try {
    ast = parseWith(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    return [{ name: '(parse error)', line: e.loc?.line || 0, file: filename, message: e.message }];
  }

  const moduleScope = new Set();
  collect(ast, (n) => moduleScope.add(n));

  const found = [];
  const seen = new Set();

  walk.recursive(ast, [], {
    FunctionDeclaration(n, st, c) { c(n.body, [...st, scopeOf(n)]); },
    FunctionExpression(n, st, c) { c(n.body, [...st, scopeOf(n)]); },
    ArrowFunctionExpression(n, st, c) { c(n.body, [...st, scopeOf(n)]); },
    ClassDeclaration(n, st, c) { c(n.body, st); },
    TryStatement(n, st, c) {
      c(n.block, st);
      if (n.handler) c(n.handler.body, [...st, new Set(bound(n.handler.param || null))]);
      if (n.finalizer) c(n.finalizer, st);
    },
    // The property in `a.b` is not a reference to something called `b`.
    MemberExpression(n, st, c) {
      c(n.object, st);
      if (n.computed) c(n.property, st);
    },
    // `{ a: 1 }` — the key is not a read. `{ a }` is, and acorn gives the same
    // node type for both. This is exactly the shape `originApps` shipped in.
    Property(n, st, c) {
      if (n.computed) c(n.key, st);
      c(n.value, st);
    },
    MethodDefinition(n, st, c) {
      if (n.computed) c(n.key, st);
      c(n.value, st);
    },
    PropertyDefinition(n, st, c) {
      if (n.computed) c(n.key, st);
      if (n.value) c(n.value, st);
    },
    // A label is not a variable.
    LabeledStatement(n, st, c) { c(n.body, st); },
    BreakStatement() {},
    ContinueStatement() {},
    ExportSpecifier() {},
    ImportSpecifier() {},
    ImportDefaultSpecifier() {},
    ImportNamespaceSpecifier() {},
    // JSX, when a caller passes a parser that understands it. `<Foo>` is a
    // reference to `Foo` and must be checked; `<div>` is not, and neither is
    // an attribute name. Ignored entirely by the base walker, so without this
    // a component used and never imported would pass.
    JSXElement(n, st, c) {
      const nameNode = n.openingElement?.name;
      if (nameNode?.type === 'JSXIdentifier' && /^[A-Z]/.test(nameNode.name)) {
        c({ type: 'Identifier', name: nameNode.name, loc: nameNode.loc }, st);
      }
      for (const a of n.openingElement?.attributes || []) {
        if (a.value) c(a.value, st);
        if (a.type === 'JSXSpreadAttribute' && a.argument) c(a.argument, st);
      }
      for (const child of n.children || []) c(child, st);
    },
    JSXFragment(n, st, c) { for (const child of n.children || []) c(child, st); },
    JSXExpressionContainer(n, st, c) { if (n.expression) c(n.expression, st); },
    JSXText() {},
    JSXEmptyExpression() {},
    // acorn-walk has no base for JSX at all, so every node type it can produce
    // has to be named here or the walk throws. The first version listed four
    // and the walker died on the fifth — which at least failed loudly rather
    // than skipping the file.
    JSXIdentifier() {},
    JSXMemberExpression() {},
    JSXNamespacedName() {},
    JSXAttribute(n, st, c) { if (n.value) c(n.value, st); },
    JSXSpreadAttribute(n, st, c) { if (n.argument) c(n.argument, st); },
    JSXSpreadChild(n, st, c) { if (n.expression) c(n.expression, st); },
    JSXOpeningElement() {},
    JSXClosingElement() {},
    JSXOpeningFragment() {},
    JSXClosingFragment() {},
    Identifier(n, st) {
      const name = n.name;
      if (GLOBALS.has(name) || moduleScope.has(name)) return;
      if (st.some(s => s.has(name))) return;
      const key = `${name}:${n.loc.start.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ name, line: n.loc.start.line, file: filename });
    },
  }, BASE);

  return found;
}

// ---------------------------------------------------------------- the gate

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = [];
  (function walkDir(dir) {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules') walkDir(p); }
      else if (e.endsWith('.js') || e.endsWith('.mjs')) files.push(p);
    }
  })(SRC);

  let bad = 0;
  for (const file of files) {
    for (const hit of undefinedIdentifiers(readFileSync(file, 'utf8'), path.relative(SRC, file))) {
      console.log(`  ✗ ${hit.file}:${hit.line} — "${hit.name}" is used and declared in no scope that reaches it`);
      bad++;
    }
  }

  console.log(bad
    ? `\n${bad} undefined reference(s) — this is the defect class that returns 500 and restarts the panel`
    : `undefined-reference audit: OK (${files.length} backend modules, parsed)`);
  process.exit(bad ? 1 : 0);
}
