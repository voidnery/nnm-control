import mongoose from 'mongoose';
import { encryptField, decryptField } from '../services/fieldCrypto.js';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  // 'superadmin' — exactly one, created at bootstrap; 'admin' — full access;
  // 'custom' — permissions come from roleId.
  roleType: { type: String, enum: ['superadmin', 'admin', 'custom'], required: true },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
  active: { type: Boolean, default: true },
  // Two-factor auth (TOTP). secret & pendingSecret are encrypted at rest;
  // backupCodes are bcrypt hashes (single-use, spliced out when consumed).
  twoFactor: {
    enabled: { type: Boolean, default: false },
    secret: { type: String, default: '', set: encryptField, get: decryptField },
    pendingSecret: { type: String, default: '', set: encryptField, get: decryptField },
    backupCodes: { type: [String], default: [] },
  },
  // Per-user UI preferences (profile settings).
  preferences: {
    theme: { type: String, enum: ['system', 'dark', 'light'], default: 'system' },
    lang: { type: String, enum: ['en', 'ru'], default: 'en' },
    functionModalWidth: { type: String, enum: ['narrow', 'default', 'wide', 'xwide'], default: 'default' },
  },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
