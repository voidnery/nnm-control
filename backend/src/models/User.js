import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  // 'superadmin' — exactly one, created at bootstrap; 'admin' — full access;
  // 'custom' — permissions come from roleId.
  roleType: { type: String, enum: ['superadmin', 'admin', 'custom'], required: true },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
  active: { type: Boolean, default: true },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
