// What a network actually delivers, and in what packaging.
//
// The links page walked the channel records: one row per `{application,
// stream}` somebody had typed. That answered "what did an operator write
// down", not "what is this network delivering", and the two are different
// things — a re-streaming route is per application, so a stream that appears
// in a carried application is delivered whether or not a record exists for it.
// The fleet's one real network carries `test2` with two streams in it and grew
// a third the moment somebody published one; the page would not have shown it.
//
// So the list is a union: every live stream inside a carried application, plus
// every channel record, plus the channel records whose application the network
// does not carry — which is the one case that is genuinely wrong and was
// already reported as `not-delivered`.
//
// Three-valued throughout. "No stream is live" and "we could not read the
// origins" are different rows and different buttons.

// ---- packaging ---------------------------------------------------------------

// The panel's protocol ids that an origin application actually offers.
//
// Read from the application, never assumed. A discovered stream has no channel
// record and therefore no `protocol` field, and defaulting one to `hls` would
// hand out a link built from a guess — the same shape as reading a field off
// an object that does not carry it.
//
// The WMSPanel codes are HLS, HLS_MPEGTS, HLS_FMP4, RTMP, RTSP, MPEG2TS,
// ICECAST, DASH, SLDP and WebRTC; the published reference names HLS and
// HLS_MPEGTS as the one illegal pair. Only three of them are packagings this
// panel builds viewer links for.
export function applicationPackaging(app) {
  // `null` is not an empty list: an application we could not read offers an
  // unknown set, and a row that says "no playback" about it would be a lie.
  if (!app) return { known: false, protocols: [], llhls: null, container: null };

  const codes = Array.isArray(app.protocols) ? app.protocols.map(String) : [];
  const anyHls = ['HLS', 'HLS_MPEGTS', 'HLS_FMP4'].some(c => codes.includes(c));
  // Absent means the application carries no HLS container at all, which is a
  // different statement from the checkbox being off.
  const alhls = 'alhls_enabled' in app ? !!app.alhls_enabled : null;

  const protocols = [];
  // LL-HLS is not a fourth container: it is HLS with parts, so it replaces the
  // plain HLS entry rather than sitting beside it. Offering both would hand
  // the operator two links to the same playlist and imply a choice the server
  // does not have.
  if (anyHls) protocols.push(alhls === true ? 'llhls' : 'hls');
  if (codes.includes('DASH')) protocols.push('dash');

  return {
    known: true,
    protocols,
    llhls: anyHls ? alhls : null,
    container: codes.includes('HLS_FMP4') ? 'fmp4'
      : codes.includes('HLS_MPEGTS') ? 'mpegts'
      : codes.includes('HLS') ? 'hls' : null,
    // Everything else the application emits. Not link-building material, but
    // an operator looking at a row should see that SLDP is on rather than
    // discover it in WMSPanel.
    other: codes.filter(c => !['HLS', 'HLS_MPEGTS', 'HLS_FMP4', 'DASH'].includes(c)),
  };
}

// ---- the streams a network delivers -------------------------------------------

const key = (app, stream) => `${app}\u0000${stream}`;

/**
 * `carried`  — from `carriedApplications()`; only `names` is used.
 * `live`     — Map application -> [{ stream, bandwidth }], or **null** when no
 *              origin could be read. Null and empty are different answers.
 * `channels` — the records, as annotations.
 * `apps`     — Map application -> the WMSPanel application object, or null per
 *              entry when it could not be read.
 */
export function deliveredStreams({ carried, live = null, channels = [], apps = new Map() }) {
  const names = new Set(carried?.names || []);
  const rows = new Map();

  const packagingOf = (application) =>
    applicationPackaging(apps.has(application) ? apps.get(application) : null);

  const row = (application, stream) => {
    const k = key(application, stream);
    if (!rows.has(k)) {
      rows.set(k, {
        application, stream,
        carried: names.has(application),
        // true seen, false looked and not there, null not asked.
        live: live === null ? null : false,
        bandwidth: null,
        channel: null,
        packaging: packagingOf(application),
      });
    }
    return rows.get(k);
  };

  // Everything the origins are actually publishing inside a carried
  // application. This is the half that did not exist.
  if (live) {
    for (const [application, entries] of live) {
      if (!names.has(application)) continue;
      for (const e of entries || []) {
        if (!e?.stream) continue;
        const r = row(application, e.stream);
        r.live = true;
        r.bandwidth = e.bandwidth ?? null;
      }
    }
  }

  // The records, as annotations on the streams they name.
  for (const c of channels || []) {
    const application = String(c.application || '');
    const stream = String(c.stream || '');
    if (!application || !stream) continue;
    const r = row(application, stream);
    r.channel = {
      id: String(c.id ?? c._id ?? ''),
      name: c.name || null,
      protocol: c.protocol || null,
      protection: c.protection?.mode || null,
    };
    // A record for a stream that is not live is not an error — an event is
    // configured before it starts. It is only worth saying when the origins
    // were actually read.
    if (live && r.live !== true) r.live = false;
  }

  const list = [...rows.values()].sort((a, b) =>
    a.application.localeCompare(b.application) || a.stream.localeCompare(b.stream));

  return {
    list,
    // Streams nobody wrote down, which is the normal case now rather than an
    // anomaly: they are delivered because their application is carried.
    discovered: list.filter(r => r.live === true && !r.channel).length,
    // A record whose application this network does not carry. The one case
    // that is actually wrong.
    notDelivered: list.filter(r => !r.carried).map(r => `${r.application}/${r.stream}`),
    // A record that names a packaging the application does not offer. Two
    // records in one application cannot legitimately differ — `live/app`
    // carries one set of protocols — so this is where that shows up.
    packagingDisagrees: list
      .filter(r => r.channel?.protocol && r.packaging.known
                && !r.packaging.protocols.includes(r.channel.protocol))
      .map(r => ({ application: r.application, stream: r.stream,
                   recorded: r.channel.protocol, offers: r.packaging.protocols })),
    asked: live !== null,
  };
}
