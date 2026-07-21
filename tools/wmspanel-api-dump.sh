#!/usr/bin/env bash
# =============================================================================
# WMSPanel API structure dump — collects raw JSON of all object kinds NNM
# Control works with (and may work with later), for pinning exact field names.
#
# Usage (env vars keep the key out of shell history):
#   CLIENT_ID=xxx API_KEY=yyy ./wmspanel-api-dump.sh
# Optional:
#   BASE_URL=https://api.wmspanel.ru/v1   (default: .ru)
#   SERVER_ID=<wmspanel server id>        (default: all Nimble servers)
#
# Output: ./wmspanel-dump-<timestamp>/ + a single .tar.gz next to it.
# The dump contains NO credentials — safe to share.
# =============================================================================
set -uo pipefail

BASE_URL="${BASE_URL:-https://api.wmspanel.ru/v1}"
: "${CLIENT_ID:?Set CLIENT_ID env var}"
: "${API_KEY:?Set API_KEY env var}"

OUT="wmspanel-dump-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
AUTH="client_id=${CLIENT_ID}&api_key=${API_KEY}"

fetch() { # $1=path $2=outfile
    local path="$1" out="$2" sep='?'
    case "$path" in *\?*) sep='&';; esac
    echo "GET ${path}"
    if curl -fsS --max-time 20 "${BASE_URL}${path}${sep}${AUTH}" -o "$OUT/$out"; then
        # pretty-print alongside raw (best-effort)
        python3 -m json.tool "$OUT/$out" > "$OUT/${out%.json}.pretty.json" 2>/dev/null || true
    else
        echo "  !! FAILED: $path" | tee -a "$OUT/_errors.txt"
    fi
}

echo "== Account-level =="
fetch "/server" "servers.json"
fetch "/data_slices" "data_slices.json"

if [ ! -s "$OUT/servers.json" ]; then
    echo "FATAL: could not fetch server list (check creds / whitelist / BASE_URL)"
    exit 1
fi

# Nimble server ids (or the single one provided)
if [ -n "${SERVER_ID:-}" ]; then
    IDS="$SERVER_ID"
else
    IDS=$(python3 - "$OUT/servers.json" << 'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
for s in data.get('servers', []):
    if s.get('kind') == 'Nimble':
        print(s['id'])
PYEOF
)
fi

# Per-server object kinds. Unknown/unavailable endpoints just land in _errors.txt
# — that's useful information too (tells us what the account/API exposes).
ENDPOINTS="rtmp/republish mpegts/udp mpegts/outgoing mpegts/incoming hotswap"
# PROBE: candidate endpoints for the full live-streams view (all protocols,
# codecs, uptime — what WMSPanel UI shows as "Живые потоки"). Read-only GETs;
# 404s land in _errors.txt harmlessly and are useful signal themselves.
PROBE_ENDPOINTS="streams livestreams live_streams rtmp/streams rtmp/stream_info media_info"
for sid in $IDS; do
    echo "== Server $sid =="
    fetch "/server/${sid}" "server-${sid}.json"
    for ep in $ENDPOINTS; do
        fetch "/server/${sid}/${ep}" "server-${sid}-$(echo "$ep" | tr '/' '_').json"
    done
    for ep in $PROBE_ENDPOINTS; do
        fetch "/server/${sid}/${ep}" "probe-${sid}-$(echo "$ep" | tr '/' '_').json"
    done
done

# Account-level stream queries with kind variants (deep stats)
SLICE=$(python3 -c "import json;d=json.load(open('$OUT/data_slices.json'));print((d.get('data_slices') or [{}])[0].get('id',''))" 2>/dev/null || true)
if [ -n "$SLICE" ]; then
    FIRST_SID=$(echo $IDS | awk '{print $1}')
    for kind in "" active live vod all; do
        suffix=${kind:-none}
        fetch "/streams?data_slice=${SLICE}&server=${FIRST_SID}&server_kind=nimble$( [ -n "$kind" ] && echo "&kind=${kind}" )" "probe-streams-kind-${suffix}.json"
    done
fi

tar -czf "${OUT}.tar.gz" "$OUT"
echo ""
echo "=============================================="
echo " Dump complete: ${OUT}.tar.gz"
echo " Files: $(ls "$OUT" | wc -l), errors: $( [ -f "$OUT/_errors.txt" ] && wc -l < "$OUT/_errors.txt" || echo 0 )"
echo " The archive contains no credentials — safe to share."
echo "=============================================="
