import mongoose from 'mongoose';

// A cross-server, cross-protocol grouping of stream objects, kept in the panel
// DB. Membership is label-style: one object may belong to several categories.
// `title` is a display snapshot so a member stays readable if the object is
// removed on the server side.
const memberSchema = new mongoose.Schema({
  serverId: { type: String, required: true },
  kind: { type: String, required: true },   // udp|outgoing|livepull|incoming|republish|hotswap
  objId: { type: String, required: true },
  title: { type: String, default: '' },
}, { _id: false });

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  color: { type: String, default: '' },
  members: { type: [memberSchema], default: [] },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

categorySchema.index({ name: 1 }, { unique: true });

export const Category = mongoose.model('Category', categorySchema);
