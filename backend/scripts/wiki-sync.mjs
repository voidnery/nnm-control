// The wiki: docs/wiki/{ru,en}/*.md is the source, readable on GitHub as it is.
//
//   node backend/scripts/wiki-sync.mjs
//
// 1. writes docs/wiki/{ru,en}/API-reference.md from the OpenAPI description (backend/src/api/openapi.js),
//    so the reference cannot describe an API that is not there;
// 2. copies the wiki into frontend/src/wiki for the Help page — the frontend image is built from
//    frontend/ alone and cannot reach docs/. Each page becomes a module exporting its text (both Vite
//    and the esbuild page smoke test load it; one chunk per page), and index.js holds the order, the
//    titles and a loader per page.
//
// tests/wiki.test.mjs fails when either is out of date, and says to run this.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openapiDocument } from '../src/api/openapi.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC = join(ROOT, 'docs', 'wiki');
export const DEST = join(ROOT, 'frontend', 'src', 'wiki');
export const LANGS = ['ru', 'en'];

// Russian names of the operations; English ones are the `summary` of the description itself.
export const RU = {
  openapi: 'Это описание',
  listEvents: 'Журнал событий — те же конверты, что уходят в webhooks (evt/1)',
  listServers: 'Серверы панели',
  getServer: 'Один сервер',
  listLiveStreams: 'Живые потоки на сервере сейчас (кодеки, разрешение, битрейт, источник, время)',
  listStreamObjects: 'Настройки потоков одного вида',
  createStreamObject: 'Создать',
  getStreamObject: 'Один объект',
  patchStreamObject: 'Изменить только переданные поля',
  replaceStreamObject: 'Заменить объект целиком',
  deleteStreamObject: 'Удалить',
  streamObjectAction: 'Перезапустить, приостановить, возобновить',
  listPlaylists: 'Плейлисты, хранимые в панели (без модели)',
  createPlaylist: 'Создать',
  getPlaylist: 'Один плейлист с моделью',
  patchPlaylist: 'Изменить только переданные поля',
  replacePlaylist: 'Заменить название, описание и модель',
  deletePlaylist: 'Удалить',
  buildPlaylist: 'Файл, который получит Nimble',
  getServerPlaylist: 'Плейлист на сервере сейчас',
  deployPlaylist: 'Развернуть плейлист на сервере',
  playlistStreamAction: 'Остановить или запустить один выходной поток плейлиста',
  playlistHistory: 'Версии, записанные на сервер, новые сверху (без содержимого)',
};

const T = {
  ru: {
    title: 'Справочник API',
    intro: 'Сгенерирован из описания OpenAPI 3.1 (`/api/v1/openapi.json`) — не правьте вручную, запустите `node backend/scripts/wiki-sync.mjs`. Как пользоваться API — на странице [API](API.md).',
    perm: 'Право', event: 'Событие', params: 'Параметры', body: 'Тело', answers: 'Ответы',
    open: 'без токена', byKind: 'по виду настроек (см. [API](API.md#права-по-видам))',
    events: 'События (webhooks)', eventsIntro: 'Каждое событие приходит POST-запросом с подписью — см. [Webhooks](Webhooks.md).',
  },
  en: {
    title: 'API reference',
    intro: 'Generated from the OpenAPI 3.1 description (`/api/v1/openapi.json`) — do not edit by hand, run `node backend/scripts/wiki-sync.mjs`. How to use the API — see [API](API.md).',
    perm: 'Permission', event: 'Event', params: 'Parameters', body: 'Body', answers: 'Answers',
    open: 'no token', byKind: 'by kind of settings (see [API](API.md#permissions-by-kind))',
    events: 'Events (webhooks)', eventsIntro: 'Every event arrives as a signed POST — see [Webhooks](Webhooks.md).',
  },
};

// Russian: the status in words, and the error codes the English description names.
const RU_STATUS = {
  200: 'успех', 201: 'создано', 204: 'удалено', 400: 'неверный запрос', 401: 'нет или неверный токен',
  403: 'не хватает права', 404: 'не найдено', 409: 'отказ до записи', 412: 'объект изменился с момента чтения',
  429: 'слишком часто, см. Retry-After', 502: 'WMSPanel или агент ответили ошибкой', 504: 'агент не ответил',
};
const RU_TAGS = {
  meta: 'описание', events: 'события', servers: 'серверы', streams: 'живые потоки', 'stream settings': 'настройки потоков',
  playlists: 'плейлисты', 'server playlist': 'плейлист на сервере',
};
const answer = (lang, code, desc) => {
  if (lang !== 'ru') return desc;
  const codes = [...new Set(String(desc).match(/`[a-z_]+`/g) || [])];
  return [RU_STATUS[code] || '', codes.join(', ')].filter(Boolean).join(': ');
};

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function apiReference(lang, spec = openapiDocument()) {
  const t = T[lang];
  const out = [`# ${t.title}`, '', t.intro, ''];
  const byTag = new Map();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = op.tags?.[0] || 'other';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method, op });
    }
  }
  for (const tag of spec.tags.map(x => x.name).filter(x => byTag.has(x))) {
    out.push(`## ${lang === 'ru' ? RU_TAGS[tag] || tag : tag}`, '');
    for (const { path, method, op } of byTag.get(tag)) {
      const summary = lang === 'ru' ? RU[op.operationId] : op.summary;
      out.push(`### ${method.toUpperCase()} ${path}`, '', `${summary}.`, '');
      if (lang === 'en' && op.description) out.push(op.description, '');
      const perm = op['x-permission'] === 'by kind' ? t.byKind : op['x-permission'] ? `\`${op['x-permission']}\`` : t.open;
      out.push(`- ${t.perm}: ${perm}`);
      if (op['x-event']) out.push(`- ${t.event}: \`${op['x-event']}\``);
      const params = (op.parameters || []).map(p => `\`${p.name}\` (${p.in})`);
      if (params.length) out.push(`- ${t.params}: ${params.join(', ')}`);
      const body = op.requestBody?.content?.['application/json']?.schema;
      if (body) out.push(`- ${t.body}: ${body.$ref ? `\`${body.$ref.split('/').pop()}\`` : 'JSON'}`);
      out.push('');
      out.push(`| ${t.answers} | |`, '|---|---|');
      for (const [code, r] of Object.entries(op.responses)) out.push(`| ${code} | ${esc(answer(lang, code, r.description))} |`);
      out.push('');
    }
  }
  out.push(`## ${t.events}`, '', t.eventsIntro, '');
  for (const type of Object.keys(spec.webhooks)) out.push(`- \`${type}\``);
  out.push('');
  return out.join('\n');
}

const titleOf = (md) => (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';

/** What frontend/src/wiki must hold: {relative path → content}. */
export function expectedCopy() {
  const order = JSON.parse(readFileSync(join(SRC, 'pages.json'), 'utf8')).order;
  const files = {};
  const titles = {};
  for (const lang of LANGS) {
    titles[lang] = {};
    for (const slug of order) {
      const md = slug === 'API-reference' ? apiReference(lang) : readFileSync(join(SRC, lang, `${slug}.md`), 'utf8');
      files[`${lang}/${slug}.js`] = `// Generated from docs/wiki/${lang}/${slug}.md by backend/scripts/wiki-sync.mjs — do not edit.\n`
        + `export default ${JSON.stringify(md)};\n`;
      titles[lang][slug] = titleOf(md);
    }
  }
  files['index.js'] = [
    '// Generated from docs/wiki by backend/scripts/wiki-sync.mjs — do not edit.',
    `export const PAGES = ${JSON.stringify({ order, titles }, null, 2)};`,
    'export const LOADERS = {',
    ...LANGS.flatMap(lang => order.map(slug => `  '${lang}/${slug}': () => import('./${lang}/${slug}.js'),`)),
    '};',
    '',
  ].join('\n');
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const lang of LANGS) writeFileSync(join(SRC, lang, 'API-reference.md'), apiReference(lang));
  if (existsSync(DEST)) rmSync(DEST, { recursive: true });
  for (const [rel, content] of Object.entries(expectedCopy())) {
    mkdirSync(dirname(join(DEST, rel)), { recursive: true });
    writeFileSync(join(DEST, rel), content);
  }
  console.log(`wiki: ${readdirSync(join(DEST, 'ru')).length} pages × ${LANGS.length} languages → frontend/src/wiki`);
}
