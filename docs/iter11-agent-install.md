# iter11 — installing agents, and what NAT actually breaks

## The finding that shaped this

The request was "install over SSH, or give the operator a link for boxes on a
local network or behind NAT". Checking the transport first changed the shape of
the answer.

`services/agentClient.js` only ever does `fetch(agent.baseUrl + …)`. Every
operation — health, config read/write, media, and the log tail added in iter10
— runs **panel → agent**. There is no path in which the agent initiates
anything.

So an install link fixes **installation** behind NAT and nothing else. The
moment the agent is installed, the panel still has to open a connection to it,
and behind NAT it cannot. Making the panel work with an agent it cannot reach
means the agent must dial *out* and the panel must send work down that
connection — a different transport, not a different installer. That is a
milestone of its own, not a footnote to this one.

This iteration therefore does the part that is genuinely useful in every
topology, and says plainly when the result will not work:

* installing is now one command instead of a documented six-step procedure
* the panel checks, immediately after enrollment, whether it can actually
  reach what was just installed — and reports the two directions separately

## What was built

**A ticket, not a credential.** The operator asks for a ticket bound to one
server. It is 32 random bytes, single-use, expires in 30 minutes, and only its
SHA-256 is stored. A database dump yields no usable ticket.

**The agent's token is created on the server.** The installer generates it with
`openssl rand -hex 24` (or Node's crypto if openssl is absent), writes it to a
mode-600 env file, and only then reports it to the panel. The panel has never
held a credential that was valid for a machine it had not already enrolled.
That is the property that makes this safe to expose: the two unauthenticated
routes cannot leak anything, because there is nothing there to leak.

**The installer is readable.** Plain POSIX sh, generated per ticket, offered in
the dialog as a link before it is offered as a command. Asking someone to pipe
a script into root's shell and then obfuscating it would be indefensible.

It refuses to run without root, curl and Node 18+. It does not touch Nimble —
no config edit, no restart, no service change. It keeps an existing token
unless `NNM_FORCE=1`. It writes exactly three paths, and the unit it installs
carries `ProtectSystem=strict`, `NoNewPrivileges`, `ReadWritePaths` limited to
the config and media trees, and `ReadOnlyPaths` on the log directory. Then it
verifies the agent answers on loopback **before** telling the panel anything.

**Two questions, answered separately.** Enrollment proves the server reached
the panel. `POST /servers/:id/agent/verify` proves the panel reached the agent.
The dialog shows both, and when the second fails with a private address it says
what that means instead of leaving the operator to guess.

## Packaging defect found on the way

The api image copied only `backend/src`. The panel now has to serve
`agent/nnm-agent.mjs` to the server being enrolled, and that file was not in
the image — the install route would have returned 500 in production while
working perfectly in the repo. The api build context is the repository root
now, with a root `.dockerignore` so the wider context does not drag
`node_modules` and the git history into every layer.

## Why SSH is m2, and what it will cost

SSH install is a thin wrapper once this exists: connect, run the same
one-liner, done. Worth stating the trade before building it.

Installing requires root. A panel that can install over SSH is a panel that can
become root on all 13 broadcast servers, which means compromise of the panel
becomes compromise of the fleet. Today that is not true: the worst an attacker
with the panel's database gets is the agents' tokens, and an agent can read and
write two directories and read logs — bad, but bounded.

The mitigation is to **never store the SSH credential**. Hold it for one
operation, in memory, and discard it. The operator pastes a key or password per
install, the same way they would type it into a terminal. That keeps the blast
radius where it is today while removing the manual step, and it is what m2
should do.

## Not in scope

* **Reverse transport for NAT.** The real fix for unreachable agents. Needs an
  agent-initiated persistent connection, request multiplexing over it, and
  backpressure for the log stream, which at the measured 13 KB/s per server is
  the part that will actually be hard.
* **Unattended fleet install.** One ticket, one server, on purpose. Batch
  enrollment with a shared ticket would trade exactly the property that makes
  this design defensible.
