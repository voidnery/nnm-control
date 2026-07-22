import mongoose from 'mongoose';

// Panel-side tags for WMSPanel stream objects. Kept in the panel DB (NOT in
// WMSPanel), keyed by (serverId, kind, objId), so assigning a tag never touches
// the running stream — no reload. kind ∈ udp|outgoing|livepull|incoming|
// hotswap|republish (the WMSPanel object endpoint segment).
const streamTagSchema = new mongoose.Schema({
  serverId: { type: String, required: true, index: true },
  kind: { type: String, required: true },
  objId: { type: String, required: true },
  tags: { type: [String], default: [] },
}, { timestamps: true });

streamTagSchema.index({ serverId: 1, kind: 1, objId: 1 }, { unique: true });

export const StreamTag = mongoose.model('StreamTag', streamTagSchema);
