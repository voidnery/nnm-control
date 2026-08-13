// A link to what was recorded.
//
// DVR cannot be set up from here: WMSPanel exposes `/v1/dvr_streams` as GET
// and DELETE only, with no POST — the same shape as geo. Recording is
// configured in WMSPanel's own DVR settings page or in nimble.conf, and
// pretending otherwise would be the panel promising something it has no way
// to do.
//
// What it can do is the part an operator actually asks for during a broadcast:
// "the goal at 19:42, thirty seconds". A DVR link is not a new object — it is
// the live URL with a different filename, documented consistently across four
// of Softvelum's own articles:
//
//   playlist_dvr.m3u8                              the whole archive
//   playlist_dvr_range-<utc-start>-<seconds>.m3u8  a fragment
//   playlist_dvr_timeshift-<shift>-<depth>.m3u8    rewound from now
//
// and each with an `fmp4` variant for players that want CMAF. So this is
// arithmetic on a URL, which means it can be got right without a fleet — and
// the parts that are easy to get wrong are seconds, not milliseconds, and UTC,
// not the operator's clock.

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

export const CONTAINERS = { ts: 'playlist_dvr', fmp4: 'playlist_fmp4_dvr' };

// Seconds since the epoch, in UTC. `Date.now()` is milliseconds and dividing
// wrongly puts a request 46 years out — far enough that the server answers
// with an empty playlist rather than an error, which is the kind of wrong
// nobody debugs quickly.
export const toEpochSeconds = (when) => Math.floor(new Date(when).getTime() / 1000);

export function dvrUrl({
  host, port = 8081, scheme = 'http', application, stream,
  container = 'ts',
  // `full` — everything recorded; `range` — a fragment by absolute time;
  // `timeshift` — rewound from now.
  mode = 'full', from = null, seconds = null, shiftSeconds = null, depthSeconds = null,
}) {
  const base = CONTAINERS[container] || CONTAINERS.ts;
  const dir = `/${trim(application)}/${trim(stream)}`;
  let file;

  if (mode === 'range') {
    if (from == null || !(Number(seconds) > 0)) {
      // Refused rather than defaulted. A range with a missing bound silently
      // becomes some other range, and the operator gets footage of the wrong
      // minute without anything having looked broken.
      throw new Error('a range needs a start time and a duration');
    }
    file = `${base}_range-${toEpochSeconds(from)}-${Math.round(seconds)}.m3u8`;
  } else if (mode === 'timeshift') {
    if (!(Number(shiftSeconds) > 0)) throw new Error('a timeshift needs a shift in seconds');
    const depth = Number(depthSeconds) > 0 ? `-${Math.round(depthSeconds)}` : '';
    file = `${base}_timeshift-${Math.round(shiftSeconds)}${depth}.m3u8`;
  } else {
    file = `${base}.m3u8`;
  }

  return {
    url: `${scheme}://${host}:${port}${dir}/${file}`,
    mode, container,
    // What the link actually asks for, in words, so it can be checked against
    // what the operator meant before it is handed to anybody.
    describes: mode === 'range'
      ? { fromUtc: new Date(toEpochSeconds(from) * 1000).toISOString(), seconds: Math.round(seconds) }
      : mode === 'timeshift'
        ? { rewoundSeconds: Math.round(shiftSeconds), depthSeconds: depthSeconds ? Math.round(depthSeconds) : null }
        : { everything: true },
  };
}

// The common request during a broadcast: "that moment, and the half minute
// around it". Expressed as a moment plus padding because that is how somebody
// watching remembers it — not as a start and an end.
export function momentUrl({ at, beforeSeconds = 15, afterSeconds = 15, ...rest }) {
  const start = new Date(new Date(at).getTime() - beforeSeconds * 1000);
  return dvrUrl({ ...rest, mode: 'range', from: start, seconds: beforeSeconds + afterSeconds });
}

// Whether this channel has anything recorded, from the list WMSPanel does
// return. Matched on application and stream because that pair is the channel.
export function recordingFor(channel, dvrStreams = []) {
  const app = trim(channel.application);
  const st = trim(channel.stream);
  return dvrStreams.find(d => trim(d.application) === app && trim(d.stream) === st) || null;
}
