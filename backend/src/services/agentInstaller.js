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
 * @param {string} o.baseUrl    how the PANEL will reach the agent
 */
export function installScript(o) {
  const {
    panelUrl, ticket, baseUrl = '',
    agentPort = 8090, bind = '0.0.0.0',
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
BASE_URL='${sh(baseUrl)}'
PORT='${sh(agentPort)}'
BIND='${sh(bind)}'
LOG_DIR='${sh(logDir)}'
CONF_DIR='${sh(confDir)}'
MEDIA_DIR='${sh(mediaDir)}'

BIN=/usr/local/bin/nnm-agent
ENV_FILE=/etc/nnm-agent.env
UNIT=/etc/systemd/system/nnm-agent.service
RUN_USER=nimble

die() { echo "nnm-agent install: $1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (try: sudo sh -)"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v node >/dev/null 2>&1 || die "node is required (Node 18+); install it and re-run"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node 18+ required, found $(node -v)"

id "$RUN_USER" >/dev/null 2>&1 || RUN_USER=root
echo "==> installing as user: $RUN_USER"

# --- binary -----------------------------------------------------------------
echo "==> fetching agent"
curl -4fsS "$PANEL/api/agents/install/$TICKET/nnm-agent.mjs" -o "$BIN.new" \\
  || die "could not fetch the agent from $PANEL (is the panel reachable from this server?)"
head -n 1 "$BIN.new" | grep -q '^#!' || die "downloaded file does not look like the agent"
mv "$BIN.new" "$BIN"
chmod 0755 "$BIN"

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
    TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
NNM_AGENT_TOKEN=$TOKEN
NNM_AGENT_BIND=$BIND
NNM_AGENT_PORT=$PORT
NNM_AGENT_CONF_DIR=$CONF_DIR
NNM_AGENT_MEDIA_DIR=$MEDIA_DIR
NNM_AGENT_LOG_DIR=$LOG_DIR
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
ExecStart=$(command -v node) $BIN
Restart=on-failure
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
VERSION=$(echo "$HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||0)}catch{console.log(0)}})')

# --- report back ------------------------------------------------------------
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
fi
echo "==> enrolling with the panel as $BASE_URL"

# The token goes through the environment, never through argv — arguments are
# visible in the process list to every user on the box.
BODY=$(TOKEN="$TOKEN" node -e '
  const [t,b,h,v]=process.argv.slice(1);
  process.stdout.write(JSON.stringify({ticket:t,agentToken:process.env.TOKEN,baseUrl:b,hostname:h,agentVersion:Number(v)}));
' "$TICKET" "$BASE_URL" "$(hostname)" "$VERSION")

curl -4fsS -X POST "$PANEL/api/agents/enroll" \\
  -H 'Content-Type: application/json' --data-binary "$BODY" \\
  || die "enrollment call failed — the agent is installed and running, but the panel did not accept it. Add it by hand in Agents, or issue a new ticket."

echo
echo "==> done. The agent is installed, enabled and enrolled."
echo "    service : systemctl status nnm-agent"
echo "    logs    : journalctl -u nnm-agent -f"
echo "    token   : $ENV_FILE (root only, never leaves this machine except to the panel at enrollment)"
`;
}
