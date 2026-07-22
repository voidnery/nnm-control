#!/usr/bin/env bash
# =============================================================================
# WMSPanel transcoder-scenario structure dump — walks the whole "Scenario"
# API subtree so NNM Control can build pipeline editors from the REAL schema
# instead of guessing.
#
# Tree walked (per transcoder):
#   GET /transcoder                                         (list)
#   GET /transcoder/{id}                                    (full scenario)
#   GET /transcoder/{id}/pipeline/{video|audio}/{pid}       (each pipeline)
#   GET /transcoder/{id}/pipeline/{v|a}/{pid}/input/{iid}
#   GET /transcoder/{id}/pipeline/{v|a}/{pid}/filter/{fid}
#   GET /transcoder/{id}/pipeline/{v|a}/{pid}/output/{oid}
#   GET /licenses/transcoder                                (license view)
#
# Usage (env vars keep the key out of shell history):
#   CLIENT_ID=xxx API_KEY=yyy ./wmspanel-transcoder-dump.sh
# Optional:
#   BASE_URL=https://api.wmspanel.com/v1   (default: .com — transcoders live there)
#   MAX_TRANSCODERS=5                      (how many scenarios to walk deeply)
#
# Output: ./wmspanel-transcoder-<ts>/ + a .tar.gz next to it.
#   *.json           — raw responses (MAY contain stream keys/urls — private!)
#   _schema.txt      — merged field schema per object type, VALUES REDACTED
#                      (safe to share — this is what the editor is built from)
# =============================================================================
set -uo pipefail

BASE_URL="${BASE_URL:-https://api.wmspanel.com/v1}"
: "${CLIENT_ID:?Set CLIENT_ID env var}"
: "${API_KEY:?Set API_KEY env var}"
MAX_TRANSCODERS="${MAX_TRANSCODERS:-5}"

OUT="wmspanel-transcoder-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
AUTH="client_id=${CLIENT_ID}&api_key=${API_KEY}"

fetch() { # $1=path $2=outfile
    local path="$1" out="$2" sep='?'
    case "$path" in *\?*) sep='&';; esac
    echo "GET ${path}"
    if curl -fsS --max-time 20 "${BASE_URL}${path}${sep}${AUTH}" -o "$OUT/$out"; then
        python3 -m json.tool "$OUT/$out" > "$OUT/${out%.json}.pretty.json" 2>/dev/null || true
    else
        echo "  !! FAILED: $path" | tee -a "$OUT/_errors.txt"
        return 1
    fi
}

echo "== Transcoder list =="
fetch "/transcoder" "transcoder-list.json" || { echo "FATAL: cannot list transcoders (creds/whitelist/BASE_URL — note transcoders are usually on .com)"; exit 1; }
fetch "/licenses/transcoder" "licenses-transcoder.json" || true

# Walk each transcoder scenario and its pipeline sub-objects.
python3 - "$OUT" "$BASE_URL" "$AUTH" "$MAX_TRANSCODERS" << 'PY'
import json, sys, os, urllib.request, urllib.error

out, base, auth, maxn = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

def get(path, outfile):
    sep = '&' if '?' in path else '?'
    url = f"{base}{path}{sep}{auth}"
    print(f"GET {path}")
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            data = r.read()
        open(os.path.join(out, outfile), 'wb').write(data)
        try:
            obj = json.loads(data)
            json.dump(obj, open(os.path.join(out, outfile.replace('.json', '.pretty.json')), 'w'),
                      ensure_ascii=False, indent=2)
            return obj
        except Exception:
            return None
    except Exception as e:
        open(os.path.join(out, '_errors.txt'), 'a').write(f"FAILED {path}: {e}\n")
        print(f"  !! FAILED: {path}: {e}")
        return None

lst = json.load(open(os.path.join(out, 'transcoder-list.json')))
tcs = lst.get('transcoders') or lst.get('transcoder') or []
print(f"  {len(tcs)} transcoder(s); walking up to {maxn} deeply")

for tc in tcs[:maxn]:
    tid = tc.get('id')
    if not tid:
        continue
    scen = get(f"/transcoder/{tid}", f"scenario-{tid}.json")
    if not scen:
        continue
    t = scen.get('transcoder') or scen
    pipelines = t.get('pipelines') or t.get('pipeline') or []
    # pipelines may be a list of {id, type, ...} or split video/audio arrays
    def walk_pipeline(kind, pl):
        pid = pl.get('id')
        if not pid:
            return
        get(f"/transcoder/{tid}/pipeline/{kind}/{pid}", f"pipeline-{kind}-{pid}.json")
        for io in ('input', 'filter', 'output'):
            for item in (pl.get(io + 's') or pl.get(io) or []):
                iid = item.get('id') if isinstance(item, dict) else None
                if iid:
                    get(f"/transcoder/{tid}/pipeline/{kind}/{pid}/{io}/{iid}",
                        f"{kind}-{io}-{iid}.json")
    if isinstance(pipelines, list):
        for pl in pipelines:
            kind = (pl.get('type') or pl.get('kind') or '').lower()
            if kind not in ('video', 'audio'):
                # try both if unknown
                for k in ('video', 'audio'):
                    walk_pipeline(k, pl)
            else:
                walk_pipeline(kind, pl)
    elif isinstance(pipelines, dict):
        for kind in ('video', 'audio'):
            for pl in (pipelines.get(kind) or []):
                walk_pipeline(kind, pl)
PY

# Build a redacted schema summary from all pretty JSON files.
python3 - "$OUT" << 'PY'
import json, sys, os, glob
out = sys.argv[1]

def typ(v):
    if isinstance(v, bool): return 'bool'
    if isinstance(v, int): return 'int'
    if isinstance(v, float): return 'float'
    if isinstance(v, str): return 'string'
    if isinstance(v, list): return 'array'
    if isinstance(v, dict): return 'object'
    if v is None: return 'null'
    return type(v).__name__

def walk(obj, prefix, acc):
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            acc[key] = typ(v)
            if isinstance(v, (dict, list)):
                walk(v, key, acc)
    elif isinstance(obj, list) and obj:
        walk(obj[0], prefix + '[]', acc)

groups = {}
for f in sorted(glob.glob(os.path.join(out, '*.pretty.json'))):
    name = os.path.basename(f)
    # group by object type prefix (scenario / pipeline-video / video-input / ...)
    grp = name.split('.')[0]
    grp = '-'.join(grp.split('-')[:2]) if '-' in grp else grp
    try: obj = json.load(open(f))
    except Exception: continue
    acc = {}
    walk(obj, '', acc)
    g = groups.setdefault(grp, {})
    g.update(acc)

lines = ["WMSPanel transcoder-scenario field schema (values redacted — safe to share)", "=" * 70, ""]
for grp in sorted(groups):
    lines.append(f"### {grp}")
    for k in sorted(groups[grp]):
        lines.append(f"  {k}: {groups[grp][k]}")
    lines.append("")
open(os.path.join(out, '_schema.txt'), 'w').write('\n'.join(lines))
print(f"schema written: {len(groups)} object group(s)")
PY

tar -czf "${OUT}.tar.gz" "$OUT"
echo ""
echo "=============================================="
echo " Transcoder dump complete: ${OUT}.tar.gz"
echo " Files: $(ls "$OUT" | wc -l), errors: $( [ -f "$OUT/_errors.txt" ] && wc -l < "$OUT/_errors.txt" || echo 0 )"
echo ""
echo " SHARE SAFELY: $OUT/_schema.txt  (field names + types, values redacted)"
echo " KEEP PRIVATE: the *.json raw files may contain stream keys / RTMP URLs."
echo "=============================================="
