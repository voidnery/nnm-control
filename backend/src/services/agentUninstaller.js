// Taking the agent off a machine.
//
// The mirror of the installer, and it has one property the installer does not:
// there is no undo. An install that goes wrong leaves a service somebody can
// look at; an uninstall that goes wrong has already removed the thing they
// would have looked at. So this removes exactly what the installer created and
// nothing adjacent, and says what it did rather than reporting success.
//
// What it deliberately leaves behind:
//
//   Nimble's own directories   The agent wrote playlists and configs into
//                              them. Removing the agent is not a decision
//                              about the media server's content, and a script
//                              that took both would be doing something nobody
//                              asked for.
//
//   The panel's record         The server, its token and its history stay
//                              until an operator deletes them. A machine
//                              whose agent is gone is still a machine.

export function uninstallScript({ removeHelper = true, purge = false } = {}) {
  return `#!/bin/sh
# NNM Control — remove the agent.
#
# Stops and disables the service, removes the unit, the binary, the state
# directory and the environment file — which holds the token, so it goes.
#
# What this does NOT touch:
#   * /srv/nimble/conf and /srv/nimble/media — the media server's own content.
#     The agent wrote into them; that does not make them the agent's.
#   * Nimble itself, in any way.
#   * The server's entry in the panel. Delete it there if you want it gone.
#
set -u

removed=""
kept=""

stop_unit() {
  if systemctl list-unit-files 2>/dev/null | grep -q "^$1"; then
    systemctl disable --now "$1" >/dev/null 2>&1 && removed="$removed $1" || kept="$kept $1"
  fi
}

stop_unit nnm-agent.service
${removeHelper ? 'stop_unit nnm-agent-privileged.service' : '# the privileged helper was left in place by request'}

for f in /etc/systemd/system/nnm-agent.service \\
         ${removeHelper ? '/etc/systemd/system/nnm-agent-privileged.service \\\n         /etc/nnm-agent-privileged.env \\' : '\\'}
         /etc/nnm-agent.env \\
         /var/lib/nnm-agent/nnm-agent.mjs; do
  [ -e "$f" ] && rm -f "$f" && removed="$removed $f"
done

# The state directory keeps the log cursor. Removed only when asked, because a
# reinstall that resumes where it left off is usually what somebody wants, and
# re-reading a fortnight of logs is not.
${purge ? `rm -rf /var/lib/nnm-agent && removed="$removed /var/lib/nnm-agent"` : `[ -d /var/lib/nnm-agent ] && kept="$kept /var/lib/nnm-agent(state)"`}

systemctl daemon-reload >/dev/null 2>&1

echo "==> removed:${'$'}{removed:- nothing}"
[ -n "$kept" ] && echo "==> left in place:$kept"
echo "==> Nimble and its directories were not touched."

# Said last, because it is the part somebody forgets: the machine is gone from
# the panel's reach, not from the panel.
echo "==> the server is still listed in the panel; delete it there if you want it gone"
`;
}
