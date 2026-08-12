import { chooseEdge, viewerUrl } from './arbiter.js';
import { channelPath } from '../models/Channel.js';
import { PROTOCOLS, playbackPath, protocolReadiness } from './protocols.js';

// The links an operator actually needs to hold.
//
// Two different things, and the panel used to offer neither. The **production**
// link is what a viewer gets: it goes through whatever mode and policy the
// network is configured with, so it is the thing to hand to a broadcaster, and
// it is also the thing that changes when the configuration changes. A **test**
// link goes straight at one named edge, past the policy, because the question
// "does RU-3 serve this" cannot be asked of a link that might resolve to RU-2.
//
// Both carry what they reveal. An operator about to paste a URL into a chat
// with a partner should be able to see, without thinking about it, whether
// they are also pasting the address of their origin.
//
// Pure: given a channel, a network and the edges already gathered, it computes.
// Nothing here reaches for a server.

export function channelLinks({ channel, network, edges, node = null }) {
  const gw = network?.gateway || {};
  const proto = PROTOCOLS[channel.protocol] || PROTOCOLS.hls;
  // The path the viewer fetches, which depends on the packaging: an .mpd for
  // DASH, a .m3u8 for both flavours of HLS. This was hard-coded to the HLS
  // playlist everywhere, which is why the choice could not be offered.
  const path = playbackPath(channel.protocol, channel.application, channel.stream);

  // Straight at each edge, in the order the operator arranged them. These do
  // not depend on the policy and must not: their whole purpose is to answer a
  // question about one machine.
  const tests = edges.map((e) => {
    const link = viewerUrl({
      mode: 'direct', edge: e, channel: channel.application, stream: channel.stream,
      protocol: channel.protocol,
    });
    const ready = protocolReadiness(channel.protocol, e);
    return {
      edge: e.name, url: link.url, exposes: link.exposes,
      // An edge that cannot carry this packaging is named here rather than
      // handing out a link that plays the wrong thing. For LL-HLS the failure
      // is a silent fallback to ordinary HLS, which is worse than an error
      // because it looks like success.
      protocolReady: ready.ok, protocolMissing: ready.missing,
      // A test link to an edge that has no route for this channel resolves and
      // 404s. Saying so beats letting the operator conclude the edge is broken.
      routed: e.routes ? e.routes.includes(String(channel.application).replace(/^\/+|\/+$/g, '')) : null,
      healthy: e.healthy !== false,
    };
  });

  const decision = chooseEdge(edges, {
    policy: gw.policy || 'nearest',
    channel: channel.application,
  });

  if (!decision.edge) {
    return {
      path,
      production: null,
      // Why there is no link, in the same words the preview uses, rather than
      // an empty field the operator has to interpret.
      productionReason: decision.reason,
      whenAllDown: gw.whenAllDown || 'fail',
      tests,
    };
  }

  const link = viewerUrl({
    mode: gw.mode || 'direct', domain: gw.domain || '', node,
    edge: decision.edge, channel: channel.application, stream: channel.stream,
    protocol: channel.protocol,
  });
  const ready = protocolReadiness(channel.protocol, decision.edge);

  return {
    path,
    production: {
      url: link.url,
      redirectsTo: link.redirectsTo || null,
      exposes: link.exposes,
      via: link.via,
      degraded: link.degraded || null,
      // Which edge this resolved to *now*. A production link under a policy is
      // not a fixed address, and printing it as though it were is how an
      // operator ends up debugging the wrong machine.
      protocol: proto.id,
      protocolReady: ready.ok,
      protocolMissing: ready.missing,
      pathUnverified: Boolean(proto.pathUnverified),
      resolvedTo: decision.edge.name,
      reason: decision.reason,
      mode: gw.mode || 'direct',
      policy: gw.policy || 'nearest',
      // Under a policy the answer can change between two viewers; under
      // `direct` with one edge it cannot. The difference matters when someone
      // is about to paste it somewhere permanent.
      stable: (gw.mode || 'direct') !== 'direct' || edges.length <= 1,
    },
    productionReason: null,
    whenAllDown: gw.whenAllDown || 'fail',
    tests,
  };
}
