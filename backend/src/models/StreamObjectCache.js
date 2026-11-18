import mongoose from 'mongoose';

// The panel's own copy of a WMSPanel list of stream settings (one kind on one server), which the
// external API (/api/v1) reads instead of WMSPanel. Filled whenever the panel reads that list for its
// own screens, refreshed for the API only as often as services/apiBudget.js allows, and updated in
// place after a write through the API. Keyed by WMSPanel's server id and the client's list call.
const streamObjectCacheSchema = new mongoose.Schema({
  sid: { type: String, required: true },
  list: { type: String, required: true },
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
  fetchedAt: { type: Date, default: Date.now },
}, { versionKey: false });

streamObjectCacheSchema.index({ sid: 1, list: 1 }, { unique: true });

export const StreamObjectCache = mongoose.model('StreamObjectCache', streamObjectCacheSchema);
