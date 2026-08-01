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
    // iter15 m5 — dashboard layout.
    //
    // This block is a TYPED sub-schema, so mongoose discards any key it does
    // not declare — silently. Writing `preferences.dashboard` therefore
    // appeared to succeed and vanished on save, and the dashboard reverted to
    // its defaults on every reload. Declared as Mixed because the shape is a
    // UI concern and the route validates it by allow-list before it gets here.
    dashboard: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
