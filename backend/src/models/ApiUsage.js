import mongoose from 'mongoose';

// What this panel has spent of the WMSPanel daily budget.
//
// WMSPanel does not report a remaining quota — no header, no endpoint — so the
// only number available is the one we keep ourselves. Two consequences, and
// both are stated in the UI rather than hidden:
//
//   * this counts what THIS PANEL spent. The account is shared: another panel,
//     a script, or someone in the WMSPanel web UI spends from the same budget
//     and is invisible here. So it is a floor, not a balance.
//   * the day boundary is assumed to be UTC midnight, because WMSPanel does not
//     publish when it resets.
//
// Persisted rather than counted in memory: a panel restart at midday would
// otherwise report a fraction of what had really been spent, which is the
// number an operator would most like to trust and least be able to.
const apiUsageSchema = new mongoose.Schema({
  // 'YYYY-MM-DD' in UTC.
  day: { type: String, required: true, unique: true },
  calls: { type: Number, default: 0 },
  // Broken down so a spike can be attributed rather than merely noticed.
  byPath: { type: mongoose.Schema.Types.Mixed, default: {} },
  firstAt: { type: Date, default: Date.now },
  lastAt: { type: Date, default: Date.now },
}, { timestamps: true });

// A fortnight is enough to see a pattern and short enough to stay small.
apiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 86400 });

export const ApiUsage = mongoose.model('ApiUsage', apiUsageSchema);

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

// The published account limit. Not discoverable from the API, so it lives here
// as a constant and is overridable for accounts on a different plan.
export const DAILY_LIMIT = Number(process.env.WMSPANEL_DAILY_LIMIT || 15000);
