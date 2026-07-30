import mongoose from 'mongoose';

// iter12 m1 — the unit of work in the inverted transport.
//
// Until now the panel opened a connection to the agent, which meant every
// agent needed a routable address. That is fine for servers sitting next to
// the panel and impossible for a machine on someone's LAN behind NAT — and
// it made the panel's install dialog spend most of its space asking the
// operator to describe their network to us.
//
// Now the panel writes a task and waits; the agent, which only ever makes
// outbound connections, picks it up and reports back. Nothing has to be
// reachable except the panel, which is reachable by definition.
//
// `route` is deliberately the agent's own route key ('GET /health',
// 'PUT /config'). The agent already dispatches on exactly that string, so the
// set of things a task can ask for is the set of things the agent could
// already do — there is no second surface to keep in step, and no way to
// express a task the agent has no handler for.
const agentTaskSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true, index: true },
  route: { type: String, required: true },
  query: { type: mongoose.Schema.Types.Mixed, default: null },
  body: { type: mongoose.Schema.Types.Mixed, default: null },

  // queued  -> waiting for an agent to claim it
  // claimed -> handed to an agent, awaiting its result
  // done    -> the agent answered
  // failed  -> the agent answered with an error
  // expired -> nobody claimed it, or nobody answered, before the deadline
  status: { type: String, enum: ['queued', 'claimed', 'done', 'failed', 'expired'], default: 'queued', index: true },

  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: '' },

  // Recorded so a stalled task can be told apart from a stalled agent — the
  // distinction NET-Control's agent debugging turned on, where "the agent is
  // broken" and "the panel never handed the task over" looked identical until
  // the two timestamps were compared.
  createdBy: { type: String, default: '' },
  claimedAt: { type: Date, default: null },
  claimedBy: { type: String, default: '' },        // agent instance id
  finishedAt: { type: Date, default: null },
  deadlineAt: { type: Date, required: true },
}, { timestamps: true });

agentTaskSchema.index({ serverId: 1, status: 1, createdAt: 1 });
// Finished tasks are diagnostic history, not state. An hour is long enough to
// investigate an install that went wrong and short enough not to accumulate.
agentTaskSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

export const AgentTask = mongoose.model('AgentTask', agentTaskSchema);
