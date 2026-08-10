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
# Output: ./wmspanel-inventory-<ts>/ (+ .tar.gz).
#
# RUN THIS ON THE PANEL HOST. WMSPanel checks the caller's IP against the
# whitelist in Control -> API setup, so correct keys from an unlisted machine
# fail on every single call — which is what happened the first time, and the
# script hid the reason.
#
# SECRETS: client_id and api_key are never written, but the dumps themselves
# carry stream keys, republish logins and passwords, push credentials and
# licence keys. Those are redacted on write (see redact() below) and listed in
# _redactions.txt. Read that file before sharing the archive.
# =============================================================================
set -uo pipefail
# Every one of the 505 request examples in the official reference uses .com.
BASE_URL="${BASE_URL:-https://api.wmspanel.com/v1}"
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

# Anything that is a credential in a dump. Matched on the key, because the
# values are exactly what must not be guessed at.
SECRET_KEYS='password|passwd|login|token|api_key|secret|license|dest_strm|push_login|push_password'

redact() { # $1=json file — rewrites in place, appends to _redactions.txt
    SECRET_KEYS="$SECRET_KEYS" python3 - "$1" "$OUT/_redactions.txt" << 'PYEOF'
import json, os, re, sys
src, log = sys.argv[1], sys.argv[2]
keys = re.compile(os.environ["SECRET_KEYS"], re.I)
hits = []
def walk(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}" if path else k
            if keys.search(k) and isinstance(v, str) and v:
                hits.append(p); node[k] = "***REDACTED***"
            else:
                walk(v, p)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]")
try:
    data = json.load(open(src, encoding="utf-8"))
except Exception:
    sys.exit(0)
walk(data)
if hits:
    json.dump(data, open(src, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    with open(log, "a", encoding="utf-8") as f:
        for h in sorted(set(hits)):
            f.write(f"{os.path.basename(src)}\t{h}\n")
PYEOF
}

AUTH_FAILED=0
fetch() { # $1=path-with-query-or-not  $2=outfile
    local path="$1" out="$2" sep='?' code body
    case "$path" in *\?*) sep='&';; esac
    echo "GET ${path}"
    # No -f: it throws away the body, and the body is where WMSPanel explains
    # itself. The status is captured instead so a failure names its own cause.
    code="$(curl -sS --max-time 20 -o "$OUT/$out" -w '%{http_code}' \
            "${BASE_URL%/v1}$path${sep}${AUTH}" 2>>"$OUT/_curl.log" || echo 000)"
    if [ "$code" = "200" ]; then
        redact "$OUT/$out"
        python3 -m json.tool "$OUT/$out" > "$OUT/${out%.json}.pretty.json" 2>/dev/null || true
        return 0
    fi
    body="$(head -c 300 "$OUT/$out" 2>/dev/null | tr -d '\n')"
    rm -f "$OUT/$out"
    echo "  !! HTTP $code  $path" | tee -a "$OUT/_errors.txt"
    [ -n "$body" ] && echo "     $body" | tee -a "$OUT/_errors.txt"
    case "$code" in
      401|403)
        AUTH_FAILED=1
        cat >&2 << EOF

  Authorization was refused, so every remaining call would fail the same way.
  Three things to check, in this order:
    1. Are you on the panel host? WMSPanel matches the caller's IP against the
       whitelist in Control -> API setup. Correct keys from another machine
       fail exactly like wrong ones.
    2. Is Pull API enabled for the account, in the same place?
    3. Is BASE_URL the host your account lives on? Currently: $BASE_URL

EOF
        ;;
      000) echo "     (no response — DNS, firewall or timeout)" | tee -a "$OUT/_errors.txt" ;;
    esac
    return 1
}

echo "== Phase 2: live-dumping every GET endpoint =="
fetch "/v1/server" "servers.json" || true
# One failed probe is enough. Grinding through fifty more turns one cause into
# fifty identical lines and buries it.
if [ "$AUTH_FAILED" = "1" ]; then
    echo "Stopping: the first call was refused. Nothing further would tell you more."
    exit 2
fi
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
