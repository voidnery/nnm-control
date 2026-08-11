import mongoose from 'mongoose';

// A delivery network is the operator's plan, not the state of the fleet.
//
// Nimble has no notion of "this box is an edge". A server becomes an edge
// because someone pointed a re-streaming route at an origin, and the only
// record of that intent lives in whoever set it up. Writing the intent down
// first is what lets later milestones compare it against what the servers
// actually report and say "this edge is pulling from somewhere you did not
// plan" instead of silently drawing a topology from configuration and calling
// it the truth.
//
// Roles, in the order content moves:
//   ingest  — takes the feed from the outside world (SRT, RTMP, NDI)
//   origin  — packages and, with the transcoder, builds the ABR ladder
//   mid     — optional relief layer between origin and a wide edge fan-out
//   edge    — serves viewers, caches
//   gateway — hands a viewer the URL of an edge; carries no media in redirect
//             mode. Listed here because it is part of the plan, but it is a
//             different kind of node: see iter20 m5.
export const ROLES = ['ingest', 'origin', 'mid', 'edge', 'gateway'];

// Who may sit above whom. A network where an origin pulls from an edge is not
// a network, it is a loop with a delay, and it is easy to build by accident in
// a dialog. Enforced at the model boundary rather than in the page, because
// the API is what a second client would use.
export const ALLOWED_UPSTREAM = {
  ingest: [],
  origin: ['ingest'],
  mid: ['origin'],
  edge: ['origin', 'mid'],
  gateway: [],
};

const nodeSchema = new mongoose.Schema({
  server: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true },
  role: { type: String, enum: ROLES, required: true },
  // Which nodes of this network this one takes content from. Empty on an
  // ingest, and empty on anything not wired up yet — which is a normal state
  // the UI reports rather than a broken one.
  upstream: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // Relative share for the balancer. Meaningless until iter20 m5, stored now
  // so the shape does not change under the operator later.
  weight: { type: Number, default: 100, min: 0 },
  enabled: { type: Boolean, default: true },
  notes: { type: String, default: '' },
}, { _id: true });

// How a viewer is given a URL, and what that choice costs.
//
// Three modes, and the panel offers all three because the trade-off is the
// operator's to make, not ours:
//
//   direct   — the link points at an edge. No extra machine, nothing to run,
//              and the edge's address is in the URL the viewer holds.
//   redirect — a small node answers the link and 302s to the chosen edge. It
//              carries no media, so a cheap box will do; but the redirect
//              target is still an edge address, so hiding it needs a DNS name
//              per edge. The panel says so rather than implying otherwise.
//   proxy    — the node serves the media itself. Nothing about the edges is
//              visible, and the node now needs the bandwidth of an edge,
//              because that is what it has become.
//
// `node` is the server carrying the gateway in the last two modes. It needs an
// agent: the panel pushes it a routing table so it decides locally, because a
// gateway that asks the panel per viewer turns a panel outage into an outage.
export const GATEWAY_MODES = ['direct', 'redirect', 'proxy'];

// Which edge a viewer gets.
//   nearest      — least great-circle distance from the viewer to the edge.
//                  Needs coordinates on the edges and a geolocation database.
//   least-loaded — fewest connections reported by the edge.
//   weighted     — by the weight on each node.
//   failover     — the first healthy edge in the operator's own order.
export const GATEWAY_POLICIES = ['nearest', 'least-loaded', 'weighted', 'failover'];

const gatewaySchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  mode: { type: String, enum: GATEWAY_MODES, default: 'direct' },
  node: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', default: null },
  // The name viewers see. Without it a redirect gateway still works and still
  // shows an address; the panel reports that rather than pretending.
  domain: { type: String, default: '' },
  policy: { type: String, enum: GATEWAY_POLICIES, default: 'nearest' },
  // When no edge is healthy. Sending a viewer to a dead edge because the
  // policy picked it is the failure this exists to prevent, and silently
  // sending everyone to the origin is a different, larger one — so it is a
  // decision, made once, in the open.
  whenAllDown: { type: String, enum: ['fail', 'origin'], default: 'fail' },
}, { _id: false });

const networkSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  // Public or internal. It changes what the operator is offered later — a
  // network for staff needs no paywall and no geo balancing — and it is
  // recorded now so that choice is explicit rather than implied by whatever
  // was configured first.
  audience: { type: String, enum: ['internal', 'public'], default: 'internal' },
  nodes: { type: [nodeSchema], default: [] },
  gateway: { type: gatewaySchema, default: () => ({}) },
  createdBy: { type: String, default: '' },
}, { timestamps: true });

networkSchema.index({ name: 1 }, { unique: true });

export const DeliveryNetwork = mongoose.model('DeliveryNetwork', networkSchema);
