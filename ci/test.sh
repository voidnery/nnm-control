#!/usr/bin/env bash
# ci/test.sh — единый запуск тестов NNM-Control (ECI/1 §3). Его же зовёт gate eterix-ci:
#   test-command: bash ci/test.sh   test-format: tap   test-files: '*.test.mjs'
# Что делает:
#   1. зависимости backend и frontend строго по lock-файлам (npm ci; SKIP_INSTALL=1 — пропустить);
#   2. все тесты и аудиты репозитория одним прогоном, вывод TAP (ci/run-tests.mjs): аудиты и тесты
#      backend, тесты агента, аудиты frontend (цепочка `npm run audit`), тесты ci/ и гейт лицензий
#      (ci/license-audit.mjs --check: копилефт или неизвестная лицензия в поставке — красный);
#   3. защита от нуля: ни одного файла *.test.mjs, ни одного выполненного теста или хоть один
#      упавший — красный, даже если раннер вернул 0. Код выхода — код раннера, а не tee.
set -uo pipefail
cd "$(dirname "$0")/.."
red() { echo "ci/test.sh: КРАСНЫЙ — $*" >&2; exit 1; }

files=$(find backend/tests agent/tests ci -name '*.test.mjs' -type f | wc -l | tr -d ' ')
[ "$files" -gt 0 ] || red "не найдено ни одного тестового файла *.test.mjs"

if [ "${SKIP_INSTALL:-0}" != 1 ]; then
  (cd backend && npm ci --no-audit --no-fund --loglevel=error) || red "npm ci backend"
  (cd frontend && npm ci --no-audit --no-fund --loglevel=error) || red "npm ci frontend"
fi

out=$(mktemp)
trap 'rm -f "$out"' EXIT
node ci/run-tests.mjs 2>&1 | tee "$out"
rc=${PIPESTATUS[0]}

sum() { grep -E "^# $1 [0-9]+" "$out" | awk '{s+=$3} END {print s+0}'; }
tests=$(sum tests); fail=$(sum fail); skipped=$(sum skipped)
grep -qE '^# tests [0-9]+' "$out" || red "в выводе нет сводки «# tests N»"
echo "ci/test.sh: файлов *.test.mjs $files, тестов $tests, упало $fail, пропущено $skipped, код раннера $rc"
[ "$tests" -gt 0 ] || red "не выполнено ни одного теста — успехом это не считается"
[ "$fail" -eq 0 ] || red "есть упавшие тесты ($fail)"
[ "$rc" -eq 0 ] || { echo "ci/test.sh: КРАСНЫЙ — раннер вышел с кодом $rc" >&2; exit "$rc"; }
echo "ci/test.sh: ЗЕЛЁНЫЙ"
