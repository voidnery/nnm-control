import mongoose from 'mongoose';
import { encryptField, decryptField } from '../services/fieldCrypto.js';

// Singleton system settings document.
const settingsSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  wmspanel: {
    // Base URL is manageable: api.wmspanel.com and api.wmspanel.ru mirrors exist.
    baseUrl: { type: String, default: 'https://api.wmspanel.com/v1' },
    clientId: { type: String, default: '' },
    apiKey: { type: String, default: '', set: encryptField, get: decryptField },
  },
  // 'wmspanel' — persistent changes via WMSPanel Control API (primary mode).
  // 'native'   — backup mode via Nimble native API (ephemeral rules; limited).
  controlPlane: { type: String, enum: ['wmspanel', 'native'], default: 'native' },
  // Show the SRT settings helper (latency/maxbw/buffers calculator) on SRT tabs.
  srtHelperEnabled: { type: Boolean, default: true },
}, { timestamps: true });

settingsSchema.statics.load = async function () {
  let doc = await this.findOne({ singleton: 'main' });
  if (!doc) doc = await this.create({ singleton: 'main' });
  return doc;
};

export const Settings = mongoose.model('Settings', settingsSchema);
