#!/usr/bin/env python3
"""Every t('key') used in the UI must exist in BOTH dictionaries, otherwise the
fallback renders the raw key (e.g. "wo.port") to the user. Also reports keys
present in EN but missing in RU and vice versa."""
import re, sys, glob

src_i18n = open('src/i18n.jsx').read()

# STRINGS = { en: {...}, ru: {...} } — slice by the language markers so the
# parser doesn't depend on brace matching in a large file.
def block(lang, nxt):
    a = src_i18n.index(f'\n  {lang}: {{')
    b = src_i18n.index(f'\n  {nxt}: {{') if nxt else src_i18n.index('\nconst I18nCtx')
    return set(re.findall(r"'([a-zA-Z0-9_.]+)'\s*:", src_i18n[a:b]))

en = block('en', 'ru')
ru = block('ru', None)
if not en or not ru:
    print('could not parse dictionaries'); sys.exit(2)

used = set()
for f in glob.glob('src/**/*.jsx', recursive=True):
    for m in re.finditer(r"\bt\(\s*'([a-zA-Z0-9_.]+)'", open(f).read()):
        used.add(m.group(1))
    for m in re.finditer(r"\bt\(\s*'([a-zA-Z0-9_.]+)'\s*\+", open(f).read()):
        used.discard(m.group(1))  # dynamic key building, can't check statically

missing_en = sorted(k for k in used if k not in en)
missing_ru = sorted(k for k in used if k not in ru)
only_en = sorted(k for k in (en - ru) if k in used)

bad = 0
if missing_en:
    bad += len(missing_en); print('✗ used but missing from EN dictionary:'); [print('   ', k) for k in missing_en]
if missing_ru:
    bad += len(missing_ru); print('✗ used but missing from RU dictionary:'); [print('   ', k) for k in missing_ru]
if only_en:
    print('note: EN-only keys in use (RU falls back to English):'); [print('   ', k) for k in only_en]

if bad:
    print(f'\n{bad} problem(s).'); sys.exit(1)
print(f'i18n key audit: OK ({len(used)} keys used, EN {len(en)} / RU {len(ru)})')
