// Loopback health for the Eterix update engine (upd/0 P6): GET /healthz → {ok, version, build, ts}.
//
// The engine reads only `ok` and `version`, and compares `version` with the upstream part of the
// package it just installed — that comparison is what catches a stack that came up on the old files
// and calls it a successful upgrade. So the version is the one baked into the build (build-info.json,
// written by build.sh from VERSION — P3), not a second copy typed somewhere; package.json is the
// fallback for a development run, where it is the same number (release-audit keeps them equal).
//
// `ok` is the database: the API answers only after it connected once (index.js), and a panel whose
// MongoDB went away answers 503 with ok:false rather than looking healthy while every page fails.
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const read = (url) => { try { return JSON.parse(readFileSync(url, 'utf8')); } catch { return null; } };

export function buildInfo(
  infoUrl = new URL('../build-info.json', import.meta.url),
  pkgUrl = new URL('../package.json', import.meta.url),
) {
  const info = read(infoUrl);
  if (info?.version) return { version: String(info.version), build: String(info.build || 'unknown') };
  return { version: String(read(pkgUrl)?.version || 'unknown'), build: 'dev' };
}

export function healthz({ info = buildInfo(), dbReady = () => mongoose.connection.readyState === 1 } = {}) {
  return (_req, res) => {
    const ok = Boolean(dbReady());
    res.status(ok ? 200 : 503).json({ ok, version: info.version, build: info.build, ts: new Date().toISOString() });
  };
}
