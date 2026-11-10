import mongoose from 'mongoose';

// A token for the external API (/api/v1, docs/api/PROPOSAL-nnm-api-1.md §2.2).
//
// Shown once, at creation, as `nnm_<tokenId>_<secret>`; only the SHA-256 of the secret is kept, so a
// database dump yields no working token. `tokenId` is public — it names the token in the audit log
// and in the panel without revealing anything that authenticates.
const apiTokenSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  tokenId: { type: String, required: true, unique: true },
  secretHash: { type: String, required: true },
  // A subset of the issuer's rights at the moment of issue, never one of NEVER_FOR_TOKENS.
  permissions: { type: [String], default: [] },
  allowCidrs: { type: [String], default: [] },
  expiresAt: { type: Date, default: null },
  ratePerMin: { type: Number, default: 600 },
  createdBy: { type: String, default: '' },
  lastUsedAt: { type: Date, default: null },
  lastUsedIp: { type: String, default: '' },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });

export const ApiToken = mongoose.model('ApiToken', apiTokenSchema);
