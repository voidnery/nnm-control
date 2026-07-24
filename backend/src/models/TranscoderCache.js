import mongoose from 'mongoose';

// Scenario shape cached per transcoder. The list of transcoders is one API call,
// but the pipelines of each are one call EACH — far too expensive to fetch on
// every screen refresh against a 15 000 calls/day account budget. So details are
// pulled on demand and reused, which also lets fleet health be derived from the
// panel's own metrics at no API cost at all.
const transcoderCacheSchema = new mongoose.Schema({
  transcoderId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  wmspanelServerId: { type: String, default: '' },
  panelServerId: { type: String, default: '' },
  videoCount: { type: Number, default: 0 },
  audioCount: { type: Number, default: 0 },
  inputs: { type: [String], default: [] },    // "app/stream"
  outputs: { type: [String], default: [] },   // "app/stream"
  fetchedAt: { type: Date, default: Date.now },
}, { versionKey: false });

export const TranscoderCache = mongoose.model('TranscoderCache', transcoderCacheSchema);
