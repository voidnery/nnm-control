import mongoose from 'mongoose';
import crypto from 'node:crypto';

// iter11 m1 — installing an agent without handing the panel root on the fleet.
//
// The panel never learns an SSH credential and never pushes anything. Instead
// an operator asks for a ticket, runs one command on the box, and the box
// calls back. Everything the ticket can do is bounded:
//
//   * it is single-use and short-lived
//   * it names exactly one server, decided before it was issued
//   * it can only ever set that server's agent connection — no other route
//     accepts it
//   * only its SHA-256 is stored, so a database dump does not yield working
//     tickets
//
// The agent's own token is generated ON the server by the installer and has
// never existed inside the panel until the box reports it. That means a
// compromised panel database contains no credential that was ever valid for a
// server it had not already enrolled.

const enrollmentSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  // Where the panel expects to reach the agent afterwards. The operator sets
  // it, because only they know how their network is arranged; the enrol
  // callback may override it with what the box actually reports.
  baseUrlHint: { type: String, default: '' },
  // How the SERVER reaches the PANEL. Resolved once, when the ticket is
  // issued, and stored — the installer is regenerated on every fetch and its
  // SHA-256 is published to the operator, so it must not depend on anything
  // that could differ between the two moments.
  panelUrl: { type: String, default: '' },
  logDir: { type: String, default: '/var/log/nimble' },
  confDir: { type: String, default: '/srv/nimble/conf' },
  mediaDir: { type: String, default: '/srv/nimble/media/gallery' },
  agentPort: { type: Number, default: 8090 },
  bind: { type: String, default: '0.0.0.0' },

  expiresAt: { type: Date, required: true },
  createdBy: { type: String, default: '' },
  // Lifecycle, kept explicit so the UI can say which stage a stalled install
  // reached rather than just "nothing happened".
  status: { type: String, enum: ['pending', 'fetched', 'enrolled', 'revoked'], default: 'pending' },
  fetchedAt: { type: Date, default: null },
  fetchedFrom: { type: String, default: '' },
  enrolledAt: { type: Date, default: null },
  enrolledFrom: { type: String, default: '' },
  reportedHostname: { type: String, default: '' },
  reportedVersion: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
}, { timestamps: true });

// Expired tickets are worthless; Mongo removes them rather than leaving a
// growing table of dead hashes.
enrollmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const hashTicket = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
export const newTicket = () => crypto.randomBytes(32).toString('hex');

export const AgentEnrollment = mongoose.model('AgentEnrollment', enrollmentSchema);
