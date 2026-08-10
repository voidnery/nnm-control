import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { EDITIONS, GEOIP_DIR, downloadUrl, candidateReleases, install } from './geoip.js';

// Fetching the database is the one part of this that touches the internet, so
// it is the one part kept separate and injectable: every rule below — which
// release to try, what counts as too large, when to give up, what to do with a
// half-written file — is testable without a network, and is tested that way.
//
// The request goes out from the panel, not from the managed servers. Nothing
// about the fleet leaves the building; DB-IP sees a download, not a lookup.

// A free Lite database is 8 MB (country) or 124 MB (city). A response an order
// of magnitude past that is not the database, and streaming it to disk anyway
// is how a panel fills its own volume.
const sizeCeiling = edition => Math.max(EDITIONS[edition].approxBytes * 3, 32e6);

export async function downloadEdition(edition, {
  fetchImpl = fetch,
  now = new Date(),
  depth = 3,
  timeoutMs = 15 * 60 * 1000,
  onProgress = null,
} = {}) {
  if (!EDITIONS[edition]) throw new Error(`unknown edition: ${edition}`);
  await fs.mkdir(GEOIP_DIR, { recursive: true });

  const tried = [];
  for (const { year, month } of candidateReleases(now, depth)) {
    const release = `${year}-${String(month).padStart(2, '0')}`;
    const url = downloadUrl(edition, year, month);
    const tmp = path.join(GEOIP_DIR, `.incoming-${edition}-${release}.mmdb`);
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      tried.push({ release, error: e.message });
      continue;
    }
    // A release that does not exist yet is a 404, and it is the expected
    // answer on the 1st of the month — not an error worth surfacing.
    if (!res.ok) { tried.push({ release, status: res.status }); continue; }

    const declared = Number(res.headers?.get?.('content-length') || 0);
    if (declared && declared > sizeCeiling(edition)) {
      tried.push({ release, error: `declared ${declared} bytes exceeds ceiling` });
      continue;
    }

    try {
      let written = 0;
      const cap = sizeCeiling(edition);
      const counter = async function* (source) {
        for await (const chunk of source) {
          written += chunk.length;
          // Checked while writing too: content-length is a claim, not a fact.
          if (written > cap) throw new Error(`body exceeded ${cap} bytes`);
          if (onProgress) onProgress(written);
          yield chunk;
        }
      };
      // fetch gives a web stream; a Buffer or a Node stream is accepted too so
      // the fetcher can be swapped without the pipeline caring. Readable.from
      // on a bare Buffer would iterate it byte by byte, hence the array.
      let body = res.body;
      if (Buffer.isBuffer(body)) body = Readable.from([body]);
      else if (body?.getReader) body = Readable.fromWeb(body);
      await pipeline(body, createGunzip(), counter, createWriteStream(tmp));
      const info = await install(tmp, { edition, release });
      return { ok: true, edition, release, url, bytes: written, ...info, tried };
    } catch (e) {
      await fs.rm(tmp, { force: true });   // never leave a partial file behind
      tried.push({ release, error: e.message });
      // A release that exists but does not survive verification is a real
      // failure; stop rather than silently installing last month's data.
      return { ok: false, edition, error: e.message, tried };
    }
  }
  return { ok: false, edition, error: 'no release could be fetched', tried };
}
