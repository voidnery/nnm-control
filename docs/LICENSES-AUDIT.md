# Аудит лицензий зависимостей NNM-Control

Дата: 2026-10-24. Версия продукта: 1.31.1. Основание: HQ D-0012 шаг 1, N-0011 оговорка 2, поручение T-0012.
Повторить: `npm ci` в `backend/` и `frontend/`, затем `node ci/license-audit.mjs --bundle` (полная
таблица всех пакетов) и `node ci/license-audit.mjs --check` (гейт, его же запускает `ci/test.sh`).

## 1. Итог

**Продукт можно распространять закрытым.** Среди всего, что попадает к клиенту, копилефта (GPL, AGPL,
LGPL, MPL, EPL, CDDL, SSPL, CC-BY-SA) и пакетов без лицензии нет. Заменять ничего не нужно.

| | Пакетов | В поставке | Копилефт / без лицензии в поставке |
|---|---|---|---|
| backend | 117 | 110 | 0 |
| frontend | 206 | 11 (вошли в бандл по факту сборки) | 0 |
| **всего** | **323** | **121** | **0** |

Условия, без которых закрытая поставка нарушила бы чужие лицензии, — §5. Главное: тексты лицензий
поставляемых пакетов едут в пакете (`/usr/share/doc/nnm-control/THIRD-PARTY-NOTICES`, собирает
`build.sh`), ссылка на DB-IP в интерфейсе остаётся.

## 2. Как получено

1. **Lock-файлы.** В `main` (1.31.1) `backend/package-lock.json` и `frontend/package-lock.json` были
   **пустыми файлами (0 байт)** — с итерации 1.28.0 (backend) и 1.22.0 (frontend); в истории они то
   пустели, то возвращались. Восстановлены последние полные: backend из `2525252` (1.25.1), frontend
   из `01df8bf` (1.21.1). Зависимости в `package.json` с тех пор не менялись (сверено поле за полем);
   `npm install --package-lock-only` изменил только поле `version` корня (→ 1.31.1). `npm ci` проходит
   в обоих каталогах: backend — 114 пакетов, frontend — 159.
2. **Перечень.** `ci/license-audit.mjs` читает каждый пакет lock-файла (прямой и транзитивный),
   берёт лицензию из lock, при её отсутствии — из `package.json` установленного пакета, и сверяет с
   установленным.
3. **Что в поставке.**
   - backend — production-зависимости без optional: ровно их ставит `build.sh`
     (`npm ci --omit=dev --omit=optional`) в `/opt/nnm-control/backend/node_modules`;
   - frontend — пакеты, которые Rollup реально включил в бандл (`--bundle` собирает SPA и
     перечисляет модули); без `--bundle` в поставку записываются все production-зависимости (40) —
     так считает гейт, строже факта.
4. **Гейт.** `--check` краснеет, если в поставке копилефт, «non-free» или неизвестная лицензия.
   Классификатор понимает SPDX-выражения: `A OR B` — по лучшему варианту, `A AND B` — по худшему
   (`ci/license-audit.test.mjs`, 10 проверок). Диверсия: `express` в lock-файле помечен
   `GPL-3.0` → `--check` дал `✗ backend express@4.22.2: GPL-3.0 (strong-copyleft)`, код 1; после
   отката — код 0.

## 3. Лицензии по группам

| Каталог | Лицензия | В поставке | Не в поставке |
|---|---|---|---|
| backend | MIT | 96 | 4 (dev: acorn, acorn-walk, js-yaml; optional: nan) |
| backend | Apache-2.0 | 5 (mongodb, mongodb-connection-string-url, bson, kareem, ecdsa-sig-formatter) | — |
| backend | BSD-3-Clause | 4 (bcrypt-pbkdf, buffer-equal-constant-time, qs, tiny-lru) | — |
| backend | ISC | 3 (inherits, semver, setprototypeof) | — |
| backend | BSD-2-Clause | 1 (webidl-conversions) | — |
| backend | Unlicense | 1 (tweetnacl) | — |
| backend | Python-2.0 | — | 1 (argparse — dev, через js-yaml) |
| backend | не указана в lock | — | 2 (buildcheck, cpu-features — optional, нативные, у ssh2; не ставятся; у автора — MIT) |
| frontend | MIT | 10 (react, react-dom, scheduler, react-router, react-router-dom, @remix-run/router, three, uplot, qrcode, dijkstrajs) | 173 (Vite, Rollup, esbuild, jsdom и их зависимости) |
| frontend | Apache-2.0 | 1 (hls.js) | 2 |
| frontend | ISC | — | 14 |
| frontend | BSD-2-Clause, BSD-3-Clause | — | 2 + 2 |
| frontend | CC-BY-4.0 | — | 1 (caniuse-lite — данные для сборщика) |
| frontend | MIT-0 | — | 1 |

Полная таблица (пакет, версия, лицензия, область, в поставке, класс) — вывод
`node ci/license-audit.mjs --bundle`; в документ не копируется, чтобы не расходиться с lock-файлами.

## 4. Не npm: что ещё распространяется или используется

| Компонент | Лицензия | Как попадает к клиенту | Вывод |
|---|---|---|---|
| `agent/nnm-agent.mjs`, `tools/*.sh`, `packaging/*` | собственный код | в пакете | только стандартные модули Node; чужого кода нет |
| `frontend/src/assets/countries.json` | Natural Earth 1:110m — public domain | в бандле | ограничений нет; ссылка в интерфейсе (GlobePanel) — по желанию |
| база геолокации DB-IP Lite | CC BY 4.0 | скачивает панель клиента по запросу оператора, в пакет не входит | обязательна ссылка на db-ip.com рядом с результатами — есть (DeliveryGeoPanel, DeliveryNetworkPanel), стережёт `frontend/scripts/attribution-audit.mjs` |
| `backend/tests/fixtures/geoip/*.mmdb` | MaxMind-DB test-data, MIT | только тесты | в пакет не входят |
| MongoDB Community Server (образ `mongo`) | SSPL-1.0 | **стоковый образ** с Docker Hub, клиент тянет сам; в пакете только ссылка на образ | SSPL §13 обязывает только тех, кто предлагает MongoDB как сервис; база внутри собственного продукта под это не попадает |
| образы `node`, `nginx` (стоковые) | Node — MIT, nginx — BSD-2-Clause; пакеты ОС внутри (Debian/Alpine) — в т.ч. GPL | стоковые образы с Docker Hub, клиент тянет сам | мы их не распространяем — обязательств нет |
| образы `ghcr.io/voidnery/nnm-control-api` / `-web` (**старый путь**) | наш код + слои `node:22-alpine` / `nginx:1.27-alpine` (BusyBox, apk-tools — GPL-2.0) | **публикуем мы** в GHCR | распространение GPL-бинарников ОС: обязанность дать исходники по запросу (обычная практика — ссылка на исходники Alpine). Тонкий пакет (стоковые образы по дайджесту) это снимает — см. §5 п.3 |
| «Nimble Streamer», «WMSPanel», Softvelum | товарные знаки | в тексте | только как указание совместимости, не в названии и логотипе (N-0011) |

## 5. Условия закрытой поставки (что сделать, а не что заменить)

1. **Тексты лицензий в пакете.** MIT, BSD, ISC и Apache-2.0 требуют, чтобы уведомление об авторском
   праве и текст лицензии ехали с копиями. В `node_modules` backend они лежат в самих пакетах; бандл
   frontend минифицирован. Поэтому `build.sh` кладёт
   `/usr/share/doc/nnm-control/THIRD-PARTY-NOTICES` (`ci/license-audit.mjs --notices`): 147 пакетов,
   у двух (`cookie-signature`, `sift`, оба MIT) файла лицензии нет — записано название лицензии.
   Apache-2.0 NOTICE-файлы попадают туда же, если есть в пакете.
2. **Ссылка на DB-IP** в интерфейсе остаётся (CC BY 4.0) — её стережёт аудит, менять не нужно.
3. **Старые образы GHCR** после перевода клиентов на DIST-Control перестать публиковать: они
   распространяют GPL-бинарники Alpine от имени voidnery. В тонком пакете образы ОС стоковые и
   берутся клиентом с Docker Hub по дайджесту.
4. **Гейт в CI** (`ci/test.sh` → `license-audit.mjs --check`): новая зависимость с копилефтом в
   поставке делает gate красным до выпуска.
5. **Версии ≤ 1.31.1 остаются MIT** для всех, кто их получил (N-0011 оговорка 1); в
   `docs/LICENSE-2.0-draft.txt` это сказано явно.

## 6. Что мешает и чем заменить

Ничего. Пакетов для замены нет.

Наблюдать: `ssh2` тянет optional-нативные `cpu-features` и `buildcheck` (MIT у автора, в lock без
поля license). В поставку они не идут (`--omit=optional`), и `build.sh` отказывает, если в production
`node_modules` появится нативный код (`*.node`) — иначе пакет не мог бы быть `Architecture: all`.
