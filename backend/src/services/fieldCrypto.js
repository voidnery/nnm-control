// At-rest encryption for sensitive fields (WMSPanel API key, server tokens).
// AES-256-GCM; key derived from the panel's JWT secret (already generated at
// install and persisted in /etc/nnm-control/nnm-control.env — it MUST stay
// stable, otherwise encrypted fields become unreadable and have to be
// re-entered). Legacy plaintext values are read transparently and get
// encrypted on their next save.
import crypto from 'crypto';
import { config } from '../config.js';

const KEY = crypto.scryptSync(String(config.jwtSecret || 'nnm-insecure-default'), 'nnm-control-field-enc-v1', 32);
const PREFIX = 'enc:v1:';

export function encryptField(v) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);
  if (s.startsWith(PREFIX)) return s; // already encrypted
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return PREFIX + [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptField(v) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);
  if (!s.startsWith(PREFIX)) return s; // legacy plaintext
  try {
    const [ivB, tagB, dataB] = s.slice(PREFIX.length).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  } catch {
    // wrong key (JWT secret changed) — treat as unreadable, force re-entry
    return '';
  }
}
