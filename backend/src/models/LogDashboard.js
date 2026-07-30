import mongoose from 'mongoose';
import crypto from 'node:crypto';

// iter10 m5 — an operator-defined arrangement of log windows.
//
// A window here is the same thing `LogWindow` renders: a scope plus the
// filters someone tuned. Storing the configuration rather than a rendered
// result is what lets the same definition serve both the panel and a shared
// link without two code paths.
const windowSchema = new mongoose.Schema({
  id: { type: String, required: true },          // stable across reorders
  title: { type: String, default: '' },
  category: { type: String, default: 'all' },
  serverId: { type: String, default: '' },       // '' = the whole fleet
  levels: { type: [String], default: [] },       // [] = every level
  subs: { type: [String], default: [] },         // narrower than the category
  range: { type: String, default: '1h' },
  query: { type: String, default: '' },
  mode: { type: String, enum: ['grouped', 'raw'], default: 'grouped' },
  height: { type: Number, default: 240 },
  span: { type: Number, default: 1 },            // grid columns this occupies
}, { _id: false });

const dashboardSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  windows: { type: [windowSchema], default: [] },
  columns: { type: Number, default: 2 },
  refreshSec: { type: Number, default: 0 },      // 0 = manual

  // --- sharing -------------------------------------------------------------
  //
  // A shared link is read access to production logs by anyone holding the URL,
  // and Nimble writes publish URLs — which carry stream keys — into its log.
  // So sharing is OFF until someone turns it on, the token is stored only as a
  // hash, it can be revoked without touching the dashboard, and it may expire.
  //
  // What the token does NOT grant is just as important: it answers only for
  // the windows stored on this dashboard. It cannot be turned into a query for
  // anything else, because the public route ignores filter parameters entirely
  // and reads them from here.
  shareEnabled: { type: Boolean, default: false },
  shareTokenHash: { type: String, default: '', index: true },
  shareExpiresAt: { type: Date, default: null },
  shareCreatedAt: { type: Date, default: null },
  shareCreatedBy: { type: String, default: '' },
  shareHits: { type: Number, default: 0 },
  shareLastAt: { type: Date, default: null },

  createdBy: { type: String, default: '' },
}, { timestamps: true });

export const hashShareToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
export const newShareToken = () => crypto.randomBytes(24).toString('base64url');

export const LogDashboard = mongoose.model('LogDashboard', dashboardSchema);
