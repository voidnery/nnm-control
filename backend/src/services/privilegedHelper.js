// The helper that is allowed to change a machine.
//
// The agent proper runs as its own user under ProtectSystem=strict and cannot
// install packages or write /etc. That is not an oversight to route around: on
// fifteen media servers it needs two directories and nothing more, and an
// agent that could install packages would be root across the whole fleet the
// moment the panel is compromised — and the panel is reachable over plain HTTP.
//
// So the privilege lives in a second unit, and the shape of it is the point:
//
//   Separate unit         `nnm-agent-privileged`, its own service, its own
//                         socket. Disabling it takes one command and leaves an
//                         ordinary machine behind.
//
//   Installed explicitly  Not a consequence of updating the agent. Somebody
//                         decides, per machine, and the panel records who.
//
//   Only on gateways      The panel refuses to offer it on a machine whose
//                         purpose is a media server, because nothing there
//                         needs it.
//
//   Root, but not free    `ReadWritePaths` lists the directories the gateway
//                         work touches. Full control of the panel then buys
//                         nginx, certbot and their state — not /etc/passwd,
//                         not /root/.ssh, not the Nimble config on a box that
//                         happens to run both.
//
// The last one is what makes this worth the extra unit rather than a flag on
// the existing one. Root scoped to a job is a different thing from root.

// Exactly what gateway preparation touches, and nothing else. Each path is
// here because a step in `gatewayPlan` needs it; a path nobody can point at a
// step for does not belong.
// A package install cannot be sandboxed by path, and that changes where the
// limit lives.
//
// `apt-get install nginx` writes /usr/sbin, /usr/share, /var/cache/debconf,
// /var/lib/update-notifier, /var/log/apt and whatever else the package's
// maintainer scripts touch. That set belongs to the package, not to us. Every
// value of ProtectSystem makes /usr read-only — `true` already does — so there
// is no setting that permits installing a package and also constrains where it
// writes. Enumerating paths was a treadmill: each release added the ones the
// last failure named.
//
// So the filesystem sandbox comes off, and the limits that remain are the ones
// that actually hold:
//
//   * Six binaries, and no others. The helper will not run bash, curl,
//     useradd or anything not on the list — checked in its own code, against
//     the first element of every command, so a compromised panel gains
//     apt-get and certbot rather than a shell.
//   * File writes still confined to the same ten paths, checked the same way.
//     What changed is that systemd no longer enforces it; the helper does, and
//     it did all along.
//   * Loopback only, its own unit, installed per machine on purpose, removable
//     with one command.
//
// This is a real reduction and worth naming: root running apt-get can, through
// a malicious package, do anything. The honest description is no longer "root
// scoped to ten directories" but "root that can run six programs" — which is
// what installing software has always meant, and pretending otherwise was the
// mistake.
//
// Directories in the old `ReadWritePaths` must still exist for the file steps,
// so the installer keeps creating them.
//
// This is the whole of the last failure and it is worth writing down properly.
// systemd builds the mount namespace before the process runs, so a path that
// is not there yet fails the unit outright — `226/NAMESPACE`, with the reason
// buried in a journal line nobody reads on a machine nobody is sitting at. It
// restarted 740 times before anyone looked.
//
// Two consequences, and the second is the one that is easy to miss:
//
//   1. A `-` prefix makes systemd ignore a missing path. That fixes the
//      crash and nothing else.
//   2. It does not make the path writable later. The namespace is fixed at
//      start, and certbot runs *inside* it — so on a machine where
//      /etc/letsencrypt did not exist at start, certbot cannot create it,
//      because everything outside the allow-list is read-only.
//
// So the installer creates every one of these before the unit is enabled. The
// `-` stays as a second line of defence for a path this list gains and the
// script forgets, but it is not the mechanism.
export const ALLOWED_PATHS = [
  '/etc/nginx',                  // the configuration this writes
  '/etc/letsencrypt',            // certbot's certificates and account
  '/var/www/html',               // the ACME challenge webroot
  '/var/log/letsencrypt',        // certbot refuses to run without somewhere to log
  '/var/lib/letsencrypt',        // and somewhere to keep its lock
  '/var/cache/apt',              // apt's download cache
  '/var/lib/apt',                // apt's lists
  '/var/lib/dpkg',               // dpkg's database — installing writes here
  '/var/lib/systemd',            // enabling a unit
  '/etc/systemd/system',         // where an nginx drop-in would land
];

// Commands the helper will run. A fixed list, checked against the first
// element of every step: the plan already constrains this, but the plan is
// composed by the panel and the panel is the thing that might be compromised.
// Two locks with one key each are worth more than one lock with two.
export const ALLOWED_BINARIES = [
  'apt-get', 'certbot', 'nginx', 'systemctl', 'ln', 'rm',
];

export const PRIVILEGED_PORT = 8091;

// The installer, as a POSIX shell script — the same shape as the agent's own,
// for the same reason: it is read by the operator before it is run, and a
// script somebody can read is a script somebody can refuse.
export function privilegedInstaller({
  // Where the agent installer actually puts the binary. It was
  // `/usr/local/lib/nnm-agent.mjs` here and `/var/lib/nnm-agent/nnm-agent.mjs`
  // there — so the helper looked, did not find it, exited 1, and the `|| echo`
  // around it turned a hard stop into a line nobody was watching for. A
  // default that is wrong is worse than no default: it looks like a decision.
  panelUrl, token, port = PRIVILEGED_PORT, bind = '127.0.0.1',
  agentBin = '/var/lib/nnm-agent/nnm-agent.mjs',
}) {
  const sh = (v) => String(v).replace(/'/g, `'\\''`);
  const rw = ALLOWED_PATHS.join(' ');

  return `#!/bin/sh
# NNM Control — privileged helper.
#
# This installs a service that runs as root. It exists because preparing a
# gateway means installing nginx and issuing a certificate, and the ordinary
# agent is confined so that it cannot do that — deliberately, since on a media
# server it has no reason to.
#
# What limits it:
#
#   * It runs only the binaries listed in ReadWritePaths' companion check
#     inside the helper itself: ${ALLOWED_BINARIES.join(', ')}.
#   * It can write only these paths:
#       ${ALLOWED_PATHS.join('\n#       ')}
#     So even full control of the panel does not reach /etc/passwd, /root/.ssh
#     or a Nimble configuration on a machine that runs both.
#   * It listens on ${bind} only. Nothing outside this machine can reach it.
#
# To remove it entirely:
#   systemctl disable --now nnm-agent-privileged
#   rm -f /etc/systemd/system/nnm-agent-privileged.service
#
set -eu

[ "$(id -u)" = "0" ] || { echo "run this as root"; exit 1; }

UNIT=/etc/systemd/system/nnm-agent-privileged.service
ENV_FILE=/etc/nnm-agent-privileged.env
BIN='${sh(agentBin)}'

# Where the installer puts it, then the older location, then whatever the
# running unit is executing — because the one place that cannot be out of date
# is the unit that is running. This looked in one hard-coded path before, did
# not find the agent, and exited: a default that is wrong is worse than none,
# because it looks like a decision somebody made.
for candidate in "$BIN" /usr/local/lib/nnm-agent.mjs; do
  if [ -f "$candidate" ]; then BIN="$candidate"; break; fi
done
if [ ! -f "$BIN" ]; then
  FROM_UNIT=$(systemctl show -p ExecStart --value nnm-agent 2>/dev/null | tr ' ' '\n' | grep -m1 'nnm-agent\.mjs' || true)
  [ -n "$FROM_UNIT" ] && [ -f "$FROM_UNIT" ] && BIN="$FROM_UNIT"
fi
[ -f "$BIN" ] || { echo "the agent binary was not found — looked in /var/lib/nnm-agent, /usr/local/lib and the running unit"; exit 1; }
echo "==> using agent binary: $BIN"

# Where the agent's own installer puts node when the system has none, then the
# system's. Looking only at PATH found nothing on a machine the agent had
# already provisioned — it installs a private node into its state directory and
# never touches PATH — so the helper stopped with "node is required" on a box
# with a working node ten centimetres away.
#
# The unit that is running is the last resort and the most reliable: whatever
# is executing the agent right now is, by definition, a node that works.
NODE_BIN=""
for candidate in /var/lib/nnm-agent/node/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  FROM_UNIT=$(systemctl show -p ExecStart --value nnm-agent 2>/dev/null | tr ' ' '\n' | grep -m1 '/node$' || true)
  [ -n "$FROM_UNIT" ] && [ -x "$FROM_UNIT" ] && NODE_BIN="$FROM_UNIT"
fi
[ -n "$NODE_BIN" ] || { echo "node was not found — looked in the agent's state directory, in PATH, and in the running unit"; exit 1; }
echo "==> using node: $NODE_BIN"

umask 077
# The helper's environment is the agent's, plus the flag that makes it the
# helper.
#
# Copied rather than composed. The first version wrote NNM_TOKEN, PORT and BIND
# — none of which the agent reads — so the helper started with no token on the
# wrong port, polled, was ignored, and never appeared. And composing it could
# not work anyway: the agent's own env gains NNM_AGENT_SERVER_ID only after it
# enrols, and without that it does not poll the panel at all.
#
# So whatever the agent ended up with is what the helper gets, with its port
# and its flag overridden and Nimble's paths cleared — a gateway has no Nimble,
# and pointing at directories that will never exist means reporting their
# absence forever.
# Every writable path, created before the unit exists.
#
# Not in ExecStartPre: that runs inside the namespace, after it has already
# failed to be built. It has to happen here, in the installer, while the
# filesystem is still ordinary.
echo "==> creating the directories the helper is allowed to write"
for d in ${ALLOWED_PATHS.join(' ')}; do
  [ -d "$d" ] || mkdir -p "$d" || { echo "could not create $d"; exit 1; }
done

umask 077
grep -v -E "^(NNM_AGENT_PORT|NNM_PRIVILEGED|NNM_AGENT_LOGS|NNM_AGENT_LOG_DIR)=" \
  /etc/nnm-agent.env > "$ENV_FILE" 2>/dev/null || {
    echo "the agent's environment file was not found at /etc/nnm-agent.env"; exit 1; }
cat >> "$ENV_FILE" <<EOF
NNM_PRIVILEGED=1
NNM_AGENT_PORT='${sh(port)}'
NNM_AGENT_LOGS=0
EOF
chmod 600 "$ENV_FILE"

grep -q '^NNM_AGENT_TOKEN=' "$ENV_FILE" || {
  echo "the agent has no token yet — enrol it first, then install the helper"; exit 1; }

cat > "$UNIT" <<EOF
[Unit]
Description=NNM Control privileged helper
After=network.target
# Deliberately not Wants= the agent: this is a separate decision and a separate
# lifetime. Removing one must not disturb the other.

[Service]
# Root, because installing a package is root. Scoped by what follows.
User=root
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $BIN
Restart=on-failure
# Ten seconds, and a limit. At two seconds this restarted 740 times while the
# real fault went unnoticed — a unit that cannot start should be visibly
# stopped, not quietly spinning and filling a journal.
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

# Its own state directory, and not a shared one.
#
# The agent writes a log cursor into STATE_DIRECTORY at startup. Without this
# line the helper inherited nothing, fell back to /var/lib/nnm-agent, and found
# it read-only under ProtectSystem=strict — so it enabled, started, threw and
# stopped, which from the installer's point of view was "it did not start" and
# nothing more.
#
# A separate directory rather than write access to the agent's: two processes
# sharing one cursor file would each rewind the other, and the helper does not
# tail logs at all.
StateDirectory=nnm-agent-privileged

# No ProtectSystem. Installing a package writes /usr, and every value of this
# setting makes /usr read-only — so it is a choice between a sandbox that works
# and a helper that can do its job. The limits that remain are in the helper's
# own code: six permitted binaries, and file writes confined to a fixed list of
# paths. Those hold against a compromised panel, which is the threat this was
# built for; they do not hold against a malicious apt package, which nothing
# here could.
#
# What stays on is everything that does not conflict with installing software.
ProtectHome=yes
PrivateTmp=yes
# Not NoNewPrivileges: apt-get and certbot legitimately re-exec helpers.
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nnm-agent-privileged
sleep 1
if systemctl is-active --quiet nnm-agent-privileged; then
  echo "==> privileged helper is running on ${bind}:${port}"
else
  # The reason, here, rather than an instruction to go and find it. Somebody
  # reading an install log is not in a position to run journalctl — they are
  # often not even on the machine — and "it did not start" tells them nothing
  # they did not already know.
  echo "==> it did not start. The last lines from its journal:"
  journalctl -u nnm-agent-privileged -n 20 --no-pager 2>/dev/null | sed 's/^/    /'
  echo "==> and its unit status:"
  systemctl status nnm-agent-privileged --no-pager -n 0 2>/dev/null | sed 's/^/    /'
  exit 1
fi
`;
}

// Whether this machine may be offered the helper at all.
//
// Refused on a media server rather than merely discouraged: the helper's whole
// justification is that a gateway needs system changes and a media server does
// not, and an installer offered everywhere would end up everywhere.
export function privilegedEligibility(server) {
  const purpose = server?.purpose || 'nimble';
  if (purpose !== 'gateway') {
    return { ok: false, code: 'not-a-gateway', purpose };
  }
  if (!server?.agent?.enabled) {
    // The helper reuses the agent's binary and its enrolment. Without the
    // ordinary agent there is nothing to add privilege to.
    return { ok: false, code: 'no-agent' };
  }
  return { ok: true };
}

// A step the helper is willing to run. Checked here as well as in the plan,
// because the plan is composed by the panel and the panel is the thing that
// might be compromised — the helper's own list is the lock that does not
// depend on its caller being honest.
export function stepAllowed(step) {
  if (step?.kind === 'file') {
    const p = String(step.path || '');
    return ALLOWED_PATHS.some(root => p === root || p.startsWith(`${root}/`));
  }
  if (step?.kind === 'package' || step?.kind === 'command') {
    const bin = Array.isArray(step.command) ? String(step.command[0] || '') : '';
    return ALLOWED_BINARIES.includes(bin.split('/').pop());
  }
  return false;
}
