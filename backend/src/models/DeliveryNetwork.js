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

const networkSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  // Public or internal. It changes what the operator is offered later — a
  // network for staff needs no paywall and no geo balancing — and it is
  // recorded now so that choice is explicit rather than implied by whatever
  // was configured first.
  audience: { type: String, enum: ['internal', 'public'], default: 'internal' },
  nodes: { type: [nodeSchema], default: [] },
  createdBy: { type: String, default: '' },
}, { timestamps: true });

networkSchema.index({ name: 1 }, { unique: true });

export const DeliveryNetwork = mongoose.model('DeliveryNetwork', networkSchema);
