import mongoose from 'mongoose';

// A stored Nimble Playout playlist authored in the panel's builder. There is
// no WMSPanel API for playlists (native Nimble feature), so these live in the
// panel DB for authoring/versioning; operators export/apply the JSON to Nimble.
const playlistSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  // The builder model (root { SyncInterval, Tasks[] }) with UI _id/_kind kept.
  model: { type: mongoose.Schema.Types.Mixed, default: () => ({ _kind: 'root', SyncInterval: null, Tasks: [] }) },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

export const Playlist = mongoose.model('Playlist', playlistSchema);
