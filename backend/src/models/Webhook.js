import mongoose from 'mongoose';
import { encryptField, decryptField } from '../services/fieldCrypto.js';

// Events (evt/1) and their delivery to webhook subscriptions — docs/api/PROPOSAL-nnm-api-1.md §3,
// eterix-contracts/evt-1.md. Thirty days of each: enough to look back on an incident and to replay,
// bounded so a busy fleet cannot fill the disk (the audit log did, twice).

// The envelope as sent, kept so GET /api/v1/events and a redelivery send exactly the same bytes'
// worth of content. `type` and `occurredAt` are indexed for the listing.
const eventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true, index: true },
  occurredAt: { type: Date, required: true },
  envelope: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });
eventSchema.index({ occurredAt: -1 });
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });
export const Event = mongoose.model('Event', eventSchema);

// The secret signs every delivery, so it has to be readable by the panel: encrypted at rest like the
// WMSPanel key (fieldCrypto), shown to the operator once, at creation.
const subscriptionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true },
  secret: { type: String, required: true, set: encryptField, get: decryptField },
  // Empty — every type. `stream_object.*` — every type of that object.
  types: { type: [String], default: [] },
  allowHttp: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
  consecutiveFailures: { type: Number, default: 0 },
  disabledReason: { type: String, default: '' },
  createdBy: { type: String, default: '' },
}, { timestamps: true, toJSON: { getters: false } });
export const WebhookSubscription = mongoose.model('WebhookSubscription', subscriptionSchema);

const deliverySchema = new mongoose.Schema({
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  eventId: { type: String, required: true },
  type: { type: String, default: '' },
  // pending → ok | failed (retrying) → given_up; skipped — refused before sending (SSRF, disabled).
  status: { type: String, default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  nextAt: { type: Date, default: () => new Date(), index: true },
  lastAt: { type: Date, default: null },
  lastCode: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
  response: { type: String, default: '' },
}, { timestamps: true });
deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });
export const WebhookDelivery = mongoose.model('WebhookDelivery', deliverySchema);
