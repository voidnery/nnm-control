import mongoose from 'mongoose';

// Every version of a playlist file this panel has seen on a server.
//
// The content is kept, not just a hash. A hash tells you the file changed; it
// does not let you put back the one that worked, and putting it back at 3am is
// the entire reason this record exists. These are a few kilobytes of JSON —
// cheap next to a broadcast going to silence.
//
// Includes what was on the server BEFORE the panel first wrote to it. Without
// that, the first rollback has nothing to roll back to, which is exactly the
// moment it is most likely to be wanted: the first deploy is the one most
// likely to be wrong.
const playlistDeploySchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true, index: true },
  filename: { type: String, required: true },
  content: { type: String, required: true },
  sha256: { type: String, required: true, index: true },
  bytes: { type: Number, default: 0 },

  // 'panel' — written from here. 'captured' — found on the server and recorded
  // before it was replaced, author unknown by definition.
  origin: { type: String, enum: ['panel', 'captured'], default: 'panel' },
  by: { type: String, default: '' },
  note: { type: String, default: '' },
  // Which stored playlist it came from, when it came from one.
  playlistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist', default: null },
  // What the check said at the time. A deploy forced past missing files is a
  // fact worth keeping: it explains an outage nobody could otherwise account
  // for.
  missingAtDeploy: { type: [String], default: [] },
  forced: { type: Boolean, default: false },
}, { timestamps: true });

playlistDeploySchema.index({ serverId: 1, createdAt: -1 });

export const PlaylistDeploy = mongoose.model('PlaylistDeploy', playlistDeploySchema);
