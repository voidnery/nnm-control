// Express 4 does not catch rejections from async handlers. Node 22 terminates
// the process on an unhandled rejection. Together that means one bad line in
// one route takes the whole panel down: the operator sees HTTP 502, the
// container restarts, and every session in the building has to log in again.
//
// That happened, twice over, from a ReferenceError — an identifier deleted
// during a cleanup while its call sites stayed. `scripts/undef-audit.mjs` now
// catches that specific class before it ships. This is the other half: even
// for a defect nothing caught, one failed request should cost one failed
// request.
//
// Imported FIRST in index.js, and that ordering matters: ES modules evaluate
// their imports before the importing module's body, and route modules create
// their routers at module scope. Patched any later, the routers would already
// exist.
import express from 'express';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use'];

// Express's router methods live on a shared prototype; one patch covers every
// router created from here on, including those in modules imported after this.
const proto = Object.getPrototypeOf(express.Router());

function wrap(fn) {
  // Error middleware takes four arguments and must keep its arity, or Express
  // stops recognising it as error middleware.
  if (typeof fn !== 'function' || fn.length >= 4) return fn;
  // A mounted sub-router is itself a function; wrapping it would work but
  // would hide the properties Express inspects on it.
  if (fn.stack || fn.handle) return fn;

  const guarded = function (req, res, next) {
    let out;
    try { out = fn.call(this, req, res, next); }
    catch (e) { return next(e); }
    if (out && typeof out.catch === 'function') out.catch(next);
    return out;
  };
  Object.defineProperty(guarded, 'name', { value: fn.name || 'guarded' });
  return guarded;
}

for (const verb of VERBS) {
  const original = proto[verb];
  if (typeof original !== 'function') continue;
  proto[verb] = function (...args) {
    return original.apply(this, args.map(wrap));
  };
}

// Belt and braces. If something still escapes — a rejection from a timer, or
// from code outside a request — say so loudly and keep serving. A panel that
// logs a stack trace is worth more than one that exits during an incident.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason instanceof Error ? reason.stack : reason);
});

export const asyncGuardInstalled = true;
