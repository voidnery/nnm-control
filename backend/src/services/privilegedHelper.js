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
  panelUrl, token, port = PRIVILEGED_PORT, bind = '127.0.0.1', agentBin = '/usr/local/lib/nnm-agent.mjs',
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

[ -f "$BIN" ] || { echo "the agent is not installed at $BIN — install it first"; exit 1; }

NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || { echo "node is required and was not found"; exit 1; }

umask 077
cat > "$ENV_FILE" <<EOF
NNM_PANEL='${sh(panelUrl)}'
NNM_TOKEN='${sh(token)}'
NNM_PRIVILEGED=1
PORT='${sh(port)}'
BIND='${sh(bind)}'
EOF
chmod 600 "$ENV_FILE"

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
RestartSec=2

# The whole point of the separate unit. Root that may write ten directories is
# a different thing from root.
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${rw}
# Not NoNewPrivileges: apt-get and certbot legitimately re-exec helpers.
# Everything else stays on.
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
systemctl is-active --quiet nnm-agent-privileged \\
  && echo "==> privileged helper is running on ${bind}:${port}" \\
  || { echo "==> it did not start; journalctl -u nnm-agent-privileged -n 50"; exit 1; }
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
