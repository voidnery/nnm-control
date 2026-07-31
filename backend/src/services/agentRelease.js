// iter14 — what the panel ships, so it can tell an agent apart from itself.
//
// The version and digest come from the file the panel actually serves, read
// once at startup. Deriving them from anything else — a constant here, the
// package version — would let the two drift, and the whole update mechanism
// rests on the panel knowing exactly what an agent will receive.
//
// Comparison is EXACT MATCH, not ordering. That is a lesson paid for in
// NET-Control: a build stamp is not a semver, and inventing "which of these
// two is newer" produced a class of bug that took a while to see. Here the
// version happens to be an integer, but the question the panel answers is
// still "is this agent running what I have", not "is it older".
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../assets/nnm-agent.mjs', import.meta.url)));

let cached = null;

export async function agentRelease() {
  if (cached) return cached;
  const body = await readFile(SRC);
  const text = body.toString('utf8');
  const m = /const AGENT_VERSION = (\d+);/.exec(text);
  if (!m) throw new Error('cannot read AGENT_VERSION out of the shipped agent');
  cached = {
    version: Number(m[1]),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    body,
  };
  return cached;
}

/**
 * @returns 'current' | 'outdated' | 'ahead' | 'unknown'
 *
 * `ahead` is a real state, not a curiosity: it means the panel was rolled back
 * while its agents were not, and an operator seeing "current" there would be
 * being lied to.
 */
export function versionState(reported, shipped) {
  const r = Number(reported);
  if (!r) return 'unknown';
  if (r === shipped) return 'current';
  return r < shipped ? 'outdated' : 'ahead';
}
