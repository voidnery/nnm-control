import re, glob, sys

CHECKS = [
  (re.compile(r'(?<![\w.])t\('),      [re.compile(r'\bt\b\s*=\s*useI18n\('), re.compile(r'const\s*\{[^}]*\bt\b[^}]*\}\s*=\s*useI18n\('), re.compile(r'function\s+\w+\s*\([^)]*\bt\b[^)]*\)'), re.compile(r'\(\s*[^)]*\bt\b[^)]*\)\s*=>')], 't'),
  (re.compile(r'(?<![\w.])can\('),    [re.compile(r'const\s*\{[^}]*\bcan\b[^}]*\}\s*=\s*useAuth\(')], 'can'),
  (re.compile(r'(?<![\w.])push\('),   [re.compile(r'const\s*\{[^}]*\bpush\b[^}]*\}\s*=\s*useToast\(')], 'push'),
  (re.compile(r'(?<![\w.])confirm\('),[re.compile(r'\bconfirm\b\s*=\s*useConfirm\(')], 'confirm'),
]

def regions(src):
    lines = src.split('\n'); starts=[]
    for i,l in enumerate(lines):
        if re.match(r'(export\s+)?(default\s+)?function\s+\w+\s*\(', l) or \
           re.match(r'(export\s+)?const\s+[A-Z]\w*\s*=\s*(\([^)]*\)|\w+)\s*=>', l):
            starts.append(i)
    starts.append(len(lines))
    for k in range(len(starts)-1):
        yield lines[starts[k]], '\n'.join(lines[starts[k]:starts[k+1]])

problems=[]
for f in glob.glob('src/**/*.jsx', recursive=True):
    for header, body in regions(open(f).read()):
        nm = re.search(r'(?:function|const)\s+(\w+)', header); nm = nm.group(1) if nm else '?'
        for use_re, decl_res, label in CHECKS:
            if use_re.search(body) and not any(d.search(body) for d in decl_res):
                problems.append(f"{f} :: {nm} uses {label}()")
if problems:
    print("REAL HOOK-BINDING PROBLEMS:")
    for p in problems: print("  ✗", p)
    sys.exit(1)

# `t` is a popular local name (t = test result, t = transcoder). If a block binds
# `t` to a non-function and still calls t('key'), the value is invoked as a
# function -> blank screen (this shipped once). Scan only the block that owns the
# declaration: start at the declaring line and stop when its block closes.
DECL_T = re.compile(r"(?:const|let|var)\s+t\s*=\s*(.*)$")
USE_T = re.compile(r"(?<![\w.$])t\(\s*['\"]")

shadow = []
for f in sorted(glob.glob('src/**/*.jsx', recursive=True)):
    lines = open(f).read().split('\n')
    for i, l in enumerate(lines):
        m = DECL_T.search(l)
        if not m:
            continue
        rhs = m.group(1).lstrip()
        # `t` bound to a function (i18n handle or a fallback arrow) is fine.
        if rhs.startswith('useI18n') or rhs.startswith('(') or '=>' in rhs.split(';')[0]:
            continue
        depth = 0
        for j in range(i, len(lines)):
            if j > i and USE_T.search(lines[j]):
                shadow.append(f"{f}:{j+1}: t('...') called where line {i+1} binds `t` to a value")
            depth += lines[j].count('{') - lines[j].count('}')
            if depth < 0:
                break

if shadow:
    print("SHADOWED t() USAGE:")
    for x in shadow: print("  ✗", x)
    sys.exit(1)

print("hook-binding audit: OK")
