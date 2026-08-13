import { privilegedInstaller, PRIVILEGED_PORT } from './privilegedHelper.js';

// iter11 m1 — the script an operator runs on a Nimble box.
//
// Deliberately plain POSIX sh and short enough to read before running. Nothing
// here is obfuscated and nothing is minified, because the operator is being
// asked to run it as root and "just pipe it to bash" is not an argument.
//
// What it does NOT do, on purpose:
//   * it never receives a credential from the panel. The agent's token is
//     generated here, on the server, and only then reported back
//   * it never touches Nimble: no config edit, no restart, no service change
//   * it writes to exactly three paths — the binary, the env file and the
//     unit — and refuses to overwrite an existing env file unless asked

const sh = (s) => String(s).replace(/'/g, `'\\''`);

/**
 * @param {object} o
 * @param {string} o.panelUrl   how the SERVER reaches the panel
 * @param {string} o.ticket     one-time enrollment ticket
 */
export function installScript(o) {
  const {
    panelUrl, ticket,
    // iter12 m5 — loopback by default. Nothing connects to the agent any
    // more, so a listening socket on the network would be attack surface with
    // no purpose. What remains is a local diagnostic surface: this installer
    // uses it to check the agent came up, and so can an operator with a shell.
    agentPort = 8090, bind = '127.0.0.1', purpose = 'nimble', token = '',
    logDir = '/var/log/nimble',
    confDir = '/srv/nimble/conf',
    mediaDir = '/srv/nimble/media/gallery',
  } = o;

  return `#!/bin/sh
# NNM Control agent installer — generated for one server, valid once.
#
# Read this before running it. It installs a small Node service that can read
# and write files under two directories and read logs from a third. It does
# not touch Nimble Streamer, its config, or its service.
set -eu

PANEL='${sh(panelUrl)}'
TICKET='${sh(ticket)}'
PORT='${sh(agentPort)}'
BIND='${sh(bind)}'
LOG_DIR='${sh(logDir)}'
CONF_DIR='${sh(confDir)}'
MEDIA_DIR='${sh(mediaDir)}'

# iter14 - the agent lives where it can rewrite itself.
#
# systemd's StateDirectory is created and owned by the service user, so an
# agent there can replace its own file and exit for systemd to restart it. Under
# /usr/local/bin it could not: ProtectSystem=strict makes /usr read-only, and
# a self-update would fail halfway. An agent installed the old way keeps
# working and simply reports that it cannot update itself.
STATE_DIR=/var/lib/nnm-agent
BIN=$STATE_DIR/nnm-agent.mjs
ENV_FILE=/etc/nnm-agent.env
UNIT=/etc/systemd/system/nnm-agent.service
RUN_USER=nimble

die() { echo "nnm-agent install: $1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (try: sudo sh -)"
command -v curl >/dev/null 2>&1 || die "curl is required"
# ---- Node, if the box has none -----------------------------------------
#
# Refusing to install because a dependency is missing puts the work back on
# the operator for something the installer can do itself. But installing Node
# system-wide on a live broadcast server is worse: it can collide with
# whatever is already there, and nothing about this agent justifies changing
# the machine's own toolchain.
#
# So Node is fetched into the agent's own directory. Official build, checksum
# verified against the release manifest, unpacked beside the agent and used
# only by it. Nothing outside $STATE_DIR is touched, and removing the agent
# removes it.
NODE_VERSION=v22.20.0
NODE_BIN=""

node_ok() {
  command -v "$1" >/dev/null 2>&1 || return 1
  # 18 is the floor: the agent uses fetch and AbortSignal.timeout.
  v=$("$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null) || return 1
  [ -n "$v" ] && [ "$v" -ge 18 ] 2>/dev/null
}

if node_ok node; then
  NODE_BIN=$(command -v node)
  echo "using the system node: $NODE_BIN"
elif node_ok "$STATE_DIR/node/bin/node"; then
  NODE_BIN="$STATE_DIR/node/bin/node"
  echo "using the node installed earlier by this agent"
else
  case "$(uname -m)" in
    x86_64|amd64) NARCH=x64 ;;
    aarch64|arm64) NARCH=arm64 ;;
    armv7l) NARCH=armv7l ;;
    *) die "no Node on this machine and no official build for $(uname -m) — install Node 18+ and re-run" ;;
  esac
  TARBALL="node-$NODE_VERSION-linux-$NARCH.tar.xz"
  BASE="https://nodejs.org/dist/$NODE_VERSION"
  echo "no usable node found; fetching $TARBALL"

  command -v tar >/dev/null 2>&1 || die "tar is required to unpack node"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  curl -4fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL" || die "could not download node from $BASE"
  # The manifest is signed for the release; matching against it is what makes
  # an interrupted or substituted download fail loudly instead of installing.
  curl -4fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || die "could not download the node checksum manifest"
  # Exact field match, not a regex. The manifest lists several formats per
  # architecture, and an anchored grep works here only because a trailing
  # dollar before a quote happens to be literal in sh — too subtle for
  # something whose failure mode is installing the wrong file.
  WANT=$(awk -v f="$TARBALL" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")
  [ -n "$WANT" ] || die "node checksum manifest has no entry for $TARBALL"
  GOT=$(sha256sum "$TMP/$TARBALL" | awk '{print $1}')
  [ "$WANT" = "$GOT" ] || die "node checksum mismatch — refusing to install"

  install -d -m 0755 "$STATE_DIR"
  rm -rf "$STATE_DIR/node.new"
  mkdir -p "$STATE_DIR/node.new"
  tar -xJf "$TMP/$TARBALL" -C "$STATE_DIR/node.new" --strip-components=1 || die "could not unpack node"
  rm -rf "$STATE_DIR/node"
  mv "$STATE_DIR/node.new" "$STATE_DIR/node"
  NODE_BIN="$STATE_DIR/node/bin/node"
  node_ok "$NODE_BIN" || die "the node that was installed does not run"
  echo "node $NODE_VERSION installed under $STATE_DIR/node (nothing outside it was changed)"
fi

# The version gate lives in node_ok(), which is what chose $NODE_BIN above —
# and it is the only place that knows WHICH node was chosen. The check that
# used to stand here called node by bare name, which is exactly the thing that
# may not exist: it survived the change that made Node optional and failed with
# "node: not found" after the install had already succeeded.
[ -n "$NODE_BIN" ] || die "no usable node was found or installed"

id "$RUN_USER" >/dev/null 2>&1 || RUN_USER=root
echo "==> installing as user: $RUN_USER"

# --- binary -----------------------------------------------------------------
echo "==> fetching agent"
install -d -m 0755 -o "$RUN_USER" -g "$RUN_USER" "$STATE_DIR" 2>/dev/null || mkdir -p "$STATE_DIR"
curl -4fsS "$PANEL/api/agents/install/$TICKET/nnm-agent.mjs" -o "$BIN.new" \\
  || die "could not fetch the agent from $PANEL (is the panel reachable from this server?)"
head -n 1 "$BIN.new" | grep -q '^#!' || die "downloaded file does not look like the agent"
mv "$BIN.new" "$BIN"
chmod 0755 "$BIN"
chown "$RUN_USER:$RUN_USER" "$BIN" 2>/dev/null || true
# An agent installed before iter14 lives here; leave nothing behind that
# systemd might still be pointed at.
rm -f /usr/local/bin/nnm-agent 2>/dev/null || true

# --- token ------------------------------------------------------------------
# Generated HERE. The panel has never seen it and cannot derive it.
if [ -f "$ENV_FILE" ] && [ "\${NNM_FORCE:-0}" != "1" ]; then
  echo "==> $ENV_FILE exists, keeping the current token (set NNM_FORCE=1 to regenerate)"
  TOKEN=$(sed -n 's/^NNM_AGENT_TOKEN=//p' "$ENV_FILE" | head -n 1)
  [ -n "$TOKEN" ] || die "$ENV_FILE has no NNM_AGENT_TOKEN; remove it or set NNM_FORCE=1"
else
  if command -v openssl >/dev/null 2>&1; then
    TOKEN=$(openssl rand -hex 24)
  else
    TOKEN=$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
NNM_AGENT_TOKEN=$TOKEN
NNM_AGENT_BIND=$BIND
NNM_AGENT_PORT=$PORT
NNM_AGENT_CONF_DIR=$CONF_DIR
NNM_AGENT_MEDIA_DIR=$MEDIA_DIR
NNM_AGENT_LOG_DIR=$LOG_DIR
NNM_AGENT_PANEL_URL=$PANEL
EOF
  chmod 600 "$ENV_FILE"
  echo "==> wrote $ENV_FILE"
fi

install -d -o "$RUN_USER" -g "$RUN_USER" "$CONF_DIR" "$MEDIA_DIR" 2>/dev/null || true

# --- service ----------------------------------------------------------------
READONLY_LOGS=""
[ -d "$LOG_DIR" ] && READONLY_LOGS="ReadOnlyPaths=$LOG_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=NNM Control file agent
After=network.target

[Service]
User=$RUN_USER
EnvironmentFile=$ENV_FILE
# iter12 m2 - the agent keeps its own log cursor here, so a restart resumes
# where it left off instead of at the end of the file. systemd creates it with
# the right ownership and exports STATE_DIRECTORY.
StateDirectory=nnm-agent
ExecStart=$NODE_BIN $BIN
# A self-update ends with a deliberate non-zero exit so that systemd starts the
# new code. Without on-failure the agent would update itself and stay down.
Restart=on-failure
RestartSec=2
ReadWritePaths=$CONF_DIR $MEDIA_DIR
$READONLY_LOGS
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nnm-agent >/dev/null 2>&1 || systemctl restart nnm-agent

# --- verify locally before telling the panel anything -----------------------
echo "==> waiting for the agent to answer"
i=0
while [ $i -lt 20 ]; do
  if curl -4fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  i=$((i+1)); sleep 0.5
done
[ $i -lt 20 ] || die "agent did not come up; check: journalctl -u nnm-agent -n 50"

HEALTH=$(curl -4fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health")
VERSION=$(echo "$HEALTH" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||0)}catch{console.log(0)}})')

# --- report back ------------------------------------------------------------
# No address is sent. The panel does not need one: from here the agent calls
# in, which is what makes this work behind NAT with no port forwarding.
echo "==> enrolling with the panel"

# The token goes through the environment, never through argv — arguments are
# visible in the process list to every user on the box.
BODY=$(TOKEN="$TOKEN" "$NODE_BIN" -e '
  const [t,h,v]=process.argv.slice(1);
  process.stdout.write(JSON.stringify({ticket:t,agentToken:process.env.TOKEN,hostname:h,agentVersion:Number(v)}));
' "$TICKET" "$(hostname)" "$VERSION")

ENROLL=$(curl -4fsS -X POST "$PANEL/api/agents/enroll" \\
  -H 'Content-Type: application/json' --data-binary "$BODY") \\
  || die "enrollment call failed — the agent is installed and running, but the panel did not accept it. Add it by hand in Agents, or issue a new ticket."

# The panel replies with this server's id. Without it the agent has no way to
# say who it is when it calls in, so it is written to the env file and the
# service restarted to pick it up. From here on the agent connects OUT to the
# panel and never needs an address of its own.
SERVER_ID=$(echo "$ENROLL" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).serverId||""))}catch{}})')
[ -n "$SERVER_ID" ] || die "the panel accepted the agent but returned no server id"

if grep -q '^NNM_AGENT_SERVER_ID=' "$ENV_FILE"; then
  sed -i "s|^NNM_AGENT_SERVER_ID=.*|NNM_AGENT_SERVER_ID=$SERVER_ID|" "$ENV_FILE"
else
  echo "NNM_AGENT_SERVER_ID=$SERVER_ID" >> "$ENV_FILE"
fi
systemctl restart nnm-agent

echo "==> waiting for the agent to reach the panel"
i=0
while [ $i -lt 20 ]; do
  journalctl -u nnm-agent -n 20 --no-pager 2>/dev/null | grep -q 'panel=' && break
  i=$((i+1)); sleep 0.5
done

${purpose === 'gateway' ? `
# ---- the privileged helper, on a gateway machine only ----------------------
#
# This install already runs as root over SSH, so the helper goes in with it
# rather than being a second thing somebody has to remember on a machine whose
# whole purpose needs it. On any other purpose this block is simply absent from
# the script — not skipped at runtime, absent, so a media server's installer
# has no privileged path in it to go wrong.
#
# What it is and what limits it is written into the unit below; the short
# version is root scoped by ReadWritePaths to nginx, certbot and apt.
echo
echo "==> installing the privileged helper (this machine's purpose is a gateway)"
# The helper copies the agent's environment on the machine, so nothing about
# the token passes through this script. An earlier version substituted it here
# and got the variable names wrong; there is now no substitution to get wrong.
cat > /tmp/nnm-privileged.sh <<'PRIVEOF'
${privilegedInstaller({ panelUrl, port: PRIVILEGED_PORT, bind })}
PRIVEOF
if sh /tmp/nnm-privileged.sh; then
  HELPER_OK=1
else
  HELPER_OK=0
  echo "==> THE PRIVILEGED HELPER DID NOT INSTALL (the agent itself is fine)"
  echo "    the reason is in the lines just above this one"
fi
rm -f /tmp/nnm-privileged.sh
` : `
# No privileged helper: this machine's purpose is "${purpose}", and a media
# server has no reason to be able to install packages from the panel. The block
# is absent rather than disabled — there is nothing here to switch on by
# accident.
`}
echo
${purpose === 'gateway' ? `if [ "\${HELPER_OK:-1}" = "0" ]; then
  echo "==> done, WITH ONE FAILURE: the agent is installed and enrolled, the privileged helper is not."
else
  echo "==> done. The agent and the privileged helper are installed and enrolled."
fi` : `echo "==> done. The agent is installed, enabled and enrolled."`}
echo "    service : systemctl status nnm-agent"
echo "    logs    : journalctl -u nnm-agent -f"
echo "    token   : $ENV_FILE (root only, never leaves this machine except to the panel at enrollment)"
echo
echo "    This agent connects OUT to $PANEL. Nothing needs to reach it:"
echo "    no port forward, no public address, no firewall hole."
echo "    It listens on $BIND:$PORT for local diagnostics only." 
`;
}
