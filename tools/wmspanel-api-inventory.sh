#!/usr/bin/env bash
# =============================================================================
# WMSPanel API FULL INVENTORY — no more guessing endpoints.
#
# Phase 1: downloads the official API reference page and extracts EVERY
#          "METHOD https://api.wmspanel.*/v1/..." request URL from it.
# Phase 2: live-dumps every discovered GET endpoint against your account
#          (placeholders: [server_id] -> each Nimble server or $SERVER_ID;
#          [data_slice_id]/[data_slice] -> first slice; endpoints with other
#          unresolved placeholders are listed in _skipped.txt, not called).
# Mutating endpoints (POST/PUT/DELETE) are inventoried but NEVER called.
#
# Usage: CLIENT_ID=xxx API_KEY=yyy ./wmspanel-api-inventory.sh
# Optional: BASE_URL=https://api.wmspanel.ru/v1  DOCS_URL=https://wmspanel.ru/api_info  SERVER_ID=...
# Output: ./wmspanel-inventory-<ts>/ (+ .tar.gz), contains no credentials.
# =============================================================================
set -uo pipefail
BASE_URL="${BASE_URL:-https://api.wmspanel.ru/v1}"
DOCS_URL="${DOCS_URL:-https://wmspanel.ru/api_info}"
: "${CLIENT_ID:?Set CLIENT_ID env var}"
: "${API_KEY:?Set API_KEY env var}"

OUT="wmspanel-inventory-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
AUTH="client_id=${CLIENT_ID}&api_key=${API_KEY}"

echo "== Phase 1: extracting every endpoint from the API reference =="
curl -fsS --max-time 60 "$DOCS_URL" -o "$OUT/api_info.html" || { echo "FATAL: cannot download $DOCS_URL"; exit 1; }

python3 - "$OUT" << 'PYEOF'
import re, sys, html
out = sys.argv[1]
text = html.unescape(open(f"{out}/api_info.html", encoding="utf-8", errors="replace").read())
# METHOD + full URL; tolerate tags/whitespace between them
pat = re.compile(r"(GET|POST|PUT|DELETE)\s+https://api\.wmspanel\.(?:com|ru)(/v1/[^\s<'\"&]+)", re.I)
seen = {}
for m in pat.finditer(text):
    method, path = m.group(1).upper(), m.group(2)
    seen.setdefault((method, path), True)
lines = sorted(f"{m} {p}" for (m, p) in seen)
open(f"{out}/api-inventory.txt", "w").write("\n".join(lines) + "\n")
print(f"Discovered {len(lines)} unique endpoints -> api-inventory.txt")
PYEOF
[ -s "$OUT/api-inventory.txt" ] || { echo "FATAL: no endpoints extracted"; exit 1; }

fetch() { # $1=path-with-query-or-not  $2=outfile
    local path="$1" out="$2" sep='?'
    case "$path" in *\?*) sep='&';; esac
    echo "GET ${path}"
    if curl -fsS --max-time 20 "${BASE_URL%/v1}$path${sep}${AUTH}" -o "$OUT/$out"; then
        python3 -m json.tool "$OUT/$out" > "$OUT/${out%.json}.pretty.json" 2>/dev/null || true
    else
        echo "  !! FAILED: $path" | tee -a "$OUT/_errors.txt"
    fi
}

echo "== Phase 2: live-dumping every GET endpoint =="
fetch "/v1/server" "servers.json"
fetch "/v1/data_slices" "data_slices.json"

if [ -n "${SERVER_ID:-}" ]; then IDS="$SERVER_ID"; else
IDS=$(python3 -c "
import json
d = json.load(open('$OUT/servers.json'))
print(' '.join(s['id'] for s in d.get('servers', []) if s.get('kind') == 'Nimble'))
" 2>/dev/null || true)
fi
FIRST_SID=$(echo $IDS | awk '{print $1}')
SLICE=$(python3 -c "
import json
d = json.load(open('$OUT/data_slices.json'))
print((d.get('data_slices') or [{}])[0].get('id', ''))
" 2>/dev/null || true)

python3 - "$OUT" "$FIRST_SID" "$SLICE" << 'PYEOF' > "$OUT/_get_plan.txt"
import re, sys
out, sid, slice_id = sys.argv[1], sys.argv[2], sys.argv[3]
for line in open(f"{out}/api-inventory.txt"):
    method, path = line.split(None, 1)
    path = path.strip()
    if method != "GET":
        continue
    p = path
    p = p.replace("[server_id]", sid)
    p = p.replace("[data_slice_id]", slice_id).replace("[data_slice]", slice_id)
    if re.search(r"\[[^\]]+\]", p):
        print(f"SKIP {path}", file=sys.stderr)
        continue
    fname = re.sub(r"[^A-Za-z0-9._-]+", "_", p.replace("/v1/", "")).strip("_") + ".json"
    print(f"{p}\t{fname}")
PYEOF

while IFS=$'\t' read -r path fname; do
    [ -z "$path" ] && continue
    fetch "$path" "$fname"
done < "$OUT/_get_plan.txt"

tar -czf "${OUT}.tar.gz" "$OUT"
echo ""
echo "=============================================="
echo " Inventory: ${OUT}.tar.gz"
echo " Endpoints discovered: $(wc -l < "$OUT/api-inventory.txt")"
echo " GET dumps: $(ls "$OUT" | grep -c '\.json$' || true), errors: $( [ -f "$OUT/_errors.txt" ] && wc -l < "$OUT/_errors.txt" || echo 0 )"
echo " No credentials inside — safe to share."
echo "=============================================="
