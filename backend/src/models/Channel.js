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
