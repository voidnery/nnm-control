import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';

// Resolves the effective permission set for a user document.
export async function resolvePermissions(user) {
  if (user.roleType === 'superadmin' || user.roleType === 'admin') return ['*'];
  if (user.roleType === 'custom' && user.roleId) {
    const role = await Role.findById(user.roleId).lean();
    return role ? role.permissions : [];
  }
  return [];
}

export function hasPerm(perms, key) {
  return perms.includes('*') || perms.includes(key);
}

// JWT auth: expects "Authorization: Bearer <token>".
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token' });
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'User inactive or missing' });
    req.user = user;
    req.perms = await resolvePermissions(user);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requirePerm(key) {
  return (req, res, next) => {
    if (!req.perms || !hasPerm(req.perms, key)) {
      return res.status(403).json({ error: `Missing permission: ${key}` });
    }
    next();
  };
}
