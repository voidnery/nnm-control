import mongoose from 'mongoose';

// A channel is one application and one stream, delivered by one network.
//
// Until now the panel had no such object. An operator typed `test2` into a box
// to compute a plan, and nothing remembered it — so "which streams go through
// which network" was a question the panel could not answer about its own
// configuration, and there was nothing to hang a viewer's link on. Every screen
// that needed the answer asked for it again.
//
// The pair is the identity, not the application. `test2/test_stream` and
// `test2/other` are two channels: they are watched separately, they can be
// healthy separately, and a link points at one of them.
//
// Unique on that pair, deliberately. The same stream delivered by two networks
// would make "the production link for this channel" ambiguous, and an
// ambiguous answer to that question is worse than a missing one. A stream that
// genuinely must reach two audiences is a topology question — an edge in both
// networks — not two records claiming the same name.
const channelSchema = new mongoose.Schema({
  application: { type: String, required: true, trim: true },
  stream: { type: String, required: true, trim: true },

  // What a person calls it. `ewc_chess_tm_homecast` is a path, not a name, and
  // an operator scanning a dashboard at speed is reading names.
  label: { type: String, default: '' },
  notes: { type: String, default: '' },

  // Null is a real state and the dashboard shows it: a stream that exists on
  // an origin and is delivered by nothing. That was invisible before, and it
  // is exactly the thing worth seeing before an event rather than during one.
  network: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryNetwork', default: null },

  // Which packaging a viewer is handed a link to.
  //
  // Not a conversion setting: the fleet's own log shows Nimble already emits
  // both containers for one incoming stream —
  //
  //   add_dash_segment key='/cyber_cct/srt_feed_3/v_...m4s' duration=6,0
  //   add HLS chunk app='cyber_cct' stream='srt_feed_3' duration=6.0
  //   add_chunk key='/cyber_cct/srt_feed_3/l_...ts'
  //
  // — so choosing between HLS and DASH is choosing which URL to give out, and
  // costs nothing on the server. That is why they are on the channel rather
  // than being a network-wide decision.
  //
  // `llhls` is different in kind and is not selectable until the server can
  // carry it: Softvelum are explicit that LL-HLS uses HTTP/2 over SSL, and a
  // client reaching it over HTTP/1.1 silently falls back to ordinary HLS. An
  // option that quietly does nothing is worse than one that is absent, so the
  // panel refuses to offer it on a server without TLS.
  protocol: { type: String, enum: ['hls', 'llhls', 'dash'], default: 'hls' },

  // Who may watch, said as intent rather than as WMSPanel objects.
  //
  // The operator says "only from our sites", "only from Russia", "only with a
  // link that expires"; the panel works out the groups and rules that means.
  // None of these exist on the account today — every stream on the fleet is
  // open, which is a decision nobody made.
  //
  // `open` is a real answer and the default. Most streams are meant to be
  // watchable, and a panel that treats "unprotected" as an oversight nags
  // about the normal case.
  protection: {
    mode: { type: String, enum: ['open', 'token', 'referer', 'ip', 'geo'], default: 'open' },

    // Token: the signing key, and how long a link stays good. The key is the
    // whole secret — anyone holding it can mint links — so it is generated
    // rather than typed, and never returned once set.
    tokenKey: { type: String, default: '' },
    validMinutes: { type: Number, default: 20 },
    // Whether a link is tied to the viewer who was issued it. Nimble hashes
    // the address either way; this is whether it also *checks* it.
    bindToIp: { type: Boolean, default: false },

    // Referer: the sites allowed to embed the player. Bare domains, because
    // that is what a person knows — the panel builds whatever pattern the API
    // wants.
    allowedDomains: { type: [String], default: [] },

    // Geo: ISO alpha-2, and whether the list permits or forbids. A list with
    // no direction is ambiguous in the dangerous direction.
    countries: { type: [String], default: [] },
    countriesAllow: { type: Boolean, default: true },

    // IP: CIDR ranges, same question of direction.
    ranges: { type: [String], default: [] },
    rangesAllow: { type: Boolean, default: true },
  },

  // Production channels are what viewers get. Test channels exist so an
  // operator can rehearse the whole path without the rehearsal being
  // indistinguishable from the broadcast on every screen that lists channels.
  kind: { type: String, enum: ['production', 'test'], default: 'production' },

  enabled: { type: Boolean, default: true },
  createdBy: { type: String, default: '' },
}, { timestamps: true });

channelSchema.index({ application: 1, stream: 1 }, { unique: true });
channelSchema.index({ network: 1 });

export const Channel = mongoose.model('Channel', channelSchema);

export const channelPath = (c) =>
  `/${String(c.application || '').replace(/^\/+|\/+$/g, '')}/${String(c.stream || '').replace(/^\/+|\/+$/g, '')}`;

// What to call it on screen. Falls back to the path rather than to an empty
// cell: a row with no name is a row nobody can act on.
export const channelName = (c) => c.label?.trim() || `${c.application}/${c.stream}`;
