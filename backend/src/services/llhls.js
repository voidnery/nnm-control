// What LL-HLS actually requires, with the source of each number.
//
// These were scattered across two standalone tools and one document, and the
// first version of them was wrong in a way that would have shipped: the API
// reference says the part duration floor is 250 ms, and the live server
// refuses anything under 500. Both documents come from Softvelum. The server
// is the one that decides.
//
// So the rules live here, once. The tools cannot import this file — they are
// standalone by design and get copied to machines that have no repository
// around them — so they carry their own copies, and
// `backend/tests/llhls-rules.test.mjs` fails when the copies drift.

// ---------------------------------------------------------------------------
// The part duration floor.
//
// MEASURED, 2026-08-16, against api.wmspanel.ru with a 6 s chunk:
//   sent {"hls_part_duration":100}
//   → "HLS part duration must be greater or equal to 500 ms."
//
// The vendor's setup article agrees and explains why: 500 ms is the smallest
// value their web UI allows, because shorter parts do not pay for their own
// overhead in the delivery chain. Nimble can produce them; they would rather
// customers did not.
//
// The API reference published at wmspanel.com/api_info?g=application says 250.
// It is stale. Recorded here so nobody re-derives 250 from it a third time.
export const PART_MIN_MS = 500;

// The ceiling. MEASURED at the same time:
//   sent {"hls_part_duration":4000} at chunk 6
//   → "HLS part duration must be less or equal to 3000 ms."
// and, on a chunk change that would have orphaned an existing part:
//   → "…must be less or equal to half of Chunk duration in milliseconds"
export const partCeilingMs = (chunkSeconds) => {
  const c = Number(chunkSeconds);
  return Number.isFinite(c) && c > 0 ? Math.floor(c * 1000 / 2) : null;
};

// Which follows from the two above: a chunk under one second leaves a ceiling
// below the floor, and there is no legal part at all. At exactly one second
// the only legal value is 500.
export const MIN_CHUNK_SECONDS = (PART_MIN_MS * 2) / 1000;

export function partRangeMs(chunkSeconds) {
  const max = partCeilingMs(chunkSeconds);
  if (max === null) return null;
  return max < PART_MIN_MS ? null : { min: PART_MIN_MS, max };
}

export function partIsLegal(partMs, chunkSeconds) {
  const range = partRangeMs(chunkSeconds);
  const p = Number(partMs);
  return !!range && Number.isFinite(p) && p >= range.min && p <= range.max;
}

// ---------------------------------------------------------------------------
// What the viewer gets.
//
// DERIVED from Nimble's own published playlists, where PART-HOLD-BACK is
// exactly three times PART-TARGET in every example: 0.512 → 1.536, 1 → 3,
// 1.001 → 3.003. A player will not start inside the hold-back window, so this
// is a floor on latency, not an estimate of it.
export const holdBackMs = (partMs) => Number(partMs) * 3;

// QUOTED from the vendor's setup article, which gives three points and no
// formula. Interpolating between them would be inventing numbers, so anything
// else returns null and says so.
export const VENDOR_LATENCY = {
  2000: { seconds: '~6', note: 'recommended: best bandwidth, latency and buffer together' },
  1000: { seconds: '~4–5', note: 'minimum recommended: better latency, less buffer, more bandwidth' },
  500: { seconds: '~2', note: 'lowest the UI allows: very small buffer, severe bandwidth and CPU cost' },
};

export function expectedLatency(partMs) {
  const stated = VENDOR_LATENCY[Number(partMs)];
  return stated
    ? { ...stated, holdBackMs: holdBackMs(partMs), source: 'vendor' }
    : { seconds: null, note: 'the vendor states latency only for 500, 1000 and 2000 ms', holdBackMs: holdBackMs(partMs), source: 'derived' };
}

// The vendor's recommended default, and the reason the panel does not need to
// touch anybody's chunk duration: 6 seconds is what they recommend LL-HLS run
// at. An earlier note in this project claimed 85 of the fleet's applications
// needed their chunk lowered to 2. That was inferred, not sourced, and wrong.
export const RECOMMENDED = { chunkSeconds: 6, partMs: 2000 };

// ---------------------------------------------------------------------------
// Containers. QUOTED from the vendor's setup article; the three map onto the
// API's `protocols` values.
export const CONTAINERS = {
  HLS: {
    label: 'HLS',
    forLowLatency: 'audio-only',
    advice: 'Optimised for audio: reduced chunk size, ID3 tags in each part. Recommended for audio-only low-latency streams.',
  },
  HLS_FMP4: {
    label: 'fMP4 (CMAF)',
    forLowLatency: 'recommended',
    advice: 'Highly recommended for video+audio and video-only. The only container that gets the full benefit of LL-HLS, and the only one supporting HEVC.',
  },
  HLS_MPEGTS: {
    label: 'HLS (MPEG-TS)',
    forLowLatency: 'discouraged',
    advice: 'Not recommended by Softvelum for LL-HLS: significant overhead which increases latency, and no HEVC. Present as a fix for an iOS 12 bug.',
  },
};

// Illegal together, per the API reference.
export const INCOMPATIBLE_PAIR = ['HLS', 'HLS_MPEGTS'];

// MEASURED 2026-08-17, and it contradicts the reference. `nnm-probe` on
// NimbleRU-6 held HLS, DASH, SLDP. Sent:
//
//   PUT {"protocols":["HLS","DASH","SLDP","HLS_FMP4"]}   → status Ok
//   GET                                                  → HLS_FMP4, DASH, SLDP
//
// Plain HLS was dropped. The reference names only HLS + HLS_MPEGTS as an
// illegal pair and says the rest combine freely; on this deployment HLS_FMP4
// takes plain HLS's place instead of joining it, and the API reports success
// while doing it.
//
// So there is no "adding fMP4". There is only switching to it, and on a live
// application that is every current viewer's container changing under them.
export const CONTAINER_REPLACES = { HLS_FMP4: ['HLS'] };

// MEASURED 2026-08-17 on the same application, with the input stream
// restarted inside the window (media sequence 333 → 10, so a genuine restart):
//
//   before  /nnm-probe/feed1/playlist.m3u8 → chunks.m3u8, MPEG-TS
//   after   /nnm-probe/feed1/playlist.m3u8 → video.m3u8,  fMP4
//
// **The entry point does not move.** `playlist.m3u8` is what `channelLinks`
// builds and what an operator hands out, and it resolved before and after. The
// variant behind it is renamed, and a player finds it by following the master,
// which is what a player does anyway.
//
// So switching container is not a link migration. It is an operation with an
// interruption: the switch needs the input stream restarted, and a restart
// ends every session in flight regardless of what the variant is called.
export const CONTAINER_SWITCH = {
  entryPathMoves: false,
  variantPathMoves: true,
  requiresInputRestart: true,
  // And the reverse is equally true, which is easy to forget: putting the
  // protocols back does not put the output back. The running stream keeps the
  // container it was restarted with until it is restarted again.
  revertRequiresAnotherRestart: true,
};

// What a requested set will actually become, as far as we have measured. The
// panel must show this before it writes, not discover it in a readback.
export function protocolsAfterWrite(requested = []) {
  const out = [...requested];
  for (const [winner, losers] of Object.entries(CONTAINER_REPLACES)) {
    if (out.includes(winner)) {
      for (const l of losers) {
        const i = out.indexOf(l);
        if (i >= 0) out.splice(i, 1);
      }
    }
  }
  return out;
}

export const HLS_FAMILY = Object.keys(CONTAINERS);

// The whole fleet reads as plain `HLS` — the audio-optimised one — so turning
// LL-HLS on for video means adding a container, not just ticking a box.
export function containerAdvice(protocols = []) {
  const present = protocols.filter(p => HLS_FAMILY.includes(p));
  if (!present.length) return { ok: false, reason: 'no HLS container: LL-HLS does not apply' };
  if (present.includes('HLS') && present.includes('HLS_MPEGTS'))
    return { ok: false, reason: 'HLS and HLS_MPEGTS cannot both be set' };
  if (present.includes('HLS_FMP4')) return { ok: true, reason: null };
  return {
    ok: true,
    // Deliberately "switching to", not "adding": measured, the server drops
    // plain HLS when fMP4 goes in.
    reason: `only ${present.join(', ')} is set. For video, Softvelum recommends HLS_FMP4 — but switching to it REMOVES ${present.join(', ')}, so every current viewer's container changes.`,
  };
}

// ---------------------------------------------------------------------------
// Two things the API cannot do, which a form that pretends otherwise would be
// lying about.

// QUOTED: "Once LL HLS is enabled, you need to re-start the input stream so
// Nimble Streamer could start producing LL HLS output stream."
//
// For a pull source the panel has `livePullRestart`. For a stream somebody
// publishes into Nimble it has nothing, and must say so rather than report
// success on a write that has not taken effect yet.
export const RESTART_REQUIRED_AFTER_ENABLE = true;

// QUOTED, as two examples and no rule. A formula was not derivable from them —
// at a 6 s chunk a 1000 ms part allows 1, 2 and 3 second intervals while a
// 2000 ms part also allows 6 — so the examples are carried verbatim rather
// than generalised into something that would be wrong at the third case.
//
// Misalignment does not fail loudly: chunks come out at 4.3, 5.0, 10.0 seconds
// and some players simply misbehave. The keyframe interval is set on the
// encoder, so this is a warning the panel shows and cannot fix.
export const KEYFRAME_EXAMPLES = [
  { chunkSeconds: 6, partMs: 1000, validIntervalsSeconds: [1, 2, 3] },
  { chunkSeconds: 6, partMs: 2000, validIntervalsSeconds: [1, 2, 3, 6] },
];

// QUOTED: for video+audio, interleaving compensation with a minimum delay of
// zero. Both fields exist on the application object, so the panel can do it.
export const INTERLEAVING_FIX = { ic_enabled: true, ic_min_delay_ms: 0 };
