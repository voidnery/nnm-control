// The wiki (docs/wiki, shown in the panel on the Help page). What can drift is held here: the two
// languages against each other, the copy the frontend builds from, the API reference against the API,
// links and anchors, and the names the wiki promises to explain — every event, every permission,
// every menu entry.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, DEST, LANGS, ROOT, apiReference, expectedCopy, RU } from '../scripts/wiki-sync.mjs';
import { openapiDocument } from '../src/api/openapi.js';
import { EVENT_TYPES } from '../src/services/events.js';
import { PERMISSIONS } from '../src/permissions.js';
import { parse, linkTarget, slugify } from '../../frontend/src/lib/markdownParse.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};
const SYNC = 'run: node backend/scripts/wiki-sync.mjs';
const order = JSON.parse(readFileSync(join(SRC, 'pages.json'), 'utf8')).order;
const page = (lang, slug) => readFileSync(join(SRC, lang, `${slug}.md`), 'utf8');
const all = (lang) => order.map(s => page(lang, s)).join('\n');

// Links and heading ids, through the parser the Help page renders with.
const textsOf = (blocks) => blocks.flatMap(b => {
  if (b.type === 'code' || b.type === 'rule') return [];
  if (b.type === 'quote') return textsOf(b.blocks);
  if (b.type === 'table') return [...b.head, ...b.rows.flat()];
  if (b.type === 'list') return b.items.flatMap(i => [i.text, ...i.children]);
  return [b.text];
});
const linksOf = (md) => textsOf(parse(md)).flatMap(t => [...String(t).matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map(m => m[1]));
const anchorsOf = (md) => new Set(parse(md).filter(b => b.type === 'heading').map(b => b.id));

console.log('\nPAGES:');

await check('every page is there in both languages, and nothing else is', () => {
  for (const lang of LANGS) {
    const files = readdirSync(join(SRC, lang)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
    assert.deepEqual(files, [...order].sort(), lang);
  }
});

await check('each page links to itself in the other language', () => {
  for (const slug of order.filter(s => s !== 'API-reference')) {
    assert.ok(page('ru', slug).includes(`(../en/${slug}.md)`), `ru/${slug}`);
    assert.ok(page('en', slug).includes(`(../ru/${slug}.md)`), `en/${slug}`);
  }
});

await check('the two languages have the same sections, page by page', () => {
  for (const slug of order) {
    const count = (lang) => parse(page(lang, slug)).filter(b => b.type === 'heading').map(b => b.level).join('');
    assert.equal(count('ru'), count('en'), slug);
  }
});

await check('every link leads to a page that exists, and every anchor to a heading on it', () => {
  const bad = [];
  for (const lang of LANGS) {
    for (const slug of order) {
      for (const href of linksOf(page(lang, slug))) {
        const t = linkTarget(href);
        if (t.kind === 'web') continue;
        if (t.kind === 'none') { bad.push(`${lang}/${slug}: ${href}`); continue; }
        const toLang = t.lang || lang;
        const toPage = t.kind === 'page' ? t.page : slug;
        if (!order.includes(toPage)) { bad.push(`${lang}/${slug}: ${href}`); continue; }
        if (t.anchor && !anchorsOf(page(toLang, toPage)).has(t.anchor)) bad.push(`${lang}/${slug}: ${href} (no heading)`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

console.log('\nWHAT IT PROMISES TO EXPLAIN:');

await check('every event type, in both languages', () => {
  for (const lang of LANGS) {
    const text = page(lang, 'Events-and-reactions');
    assert.deepEqual(EVENT_TYPES.filter(t => !text.includes(`\`${t}\``)), [], lang);
  }
});

await check('every permission, in both languages', () => {
  for (const lang of LANGS) {
    const text = page(lang, 'Access');
    assert.deepEqual(PERMISSIONS.map(p => p.key).filter(k => !text.includes(`\`${k}\``)), [], lang);
  }
});

await check('every menu entry of the panel, by the name the menu shows', () => {
  const app = readFileSync(join(ROOT, 'frontend/src/App.jsx'), 'utf8');
  const i18n = readFileSync(join(ROOT, 'frontend/src/i18n.jsx'), 'utf8');
  const keys = [...app.matchAll(/key: '(nav\.[a-zA-Z]+)'/g)].map(m => m[1]).filter(k => k !== 'nav.help');
  assert.ok(keys.length > 15);
  const missing = [];
  for (const key of keys) {
    const values = [...i18n.matchAll(new RegExp(`'${key.replace('.', '\\.')}': '([^']+)'`, 'g'))].map(m => m[1]);
    const [en, ru] = values;
    if (!all('en').includes(en)) missing.push(`en ${key} «${en}»`);
    if (!all('ru').includes(ru)) missing.push(`ru ${key} «${ru}»`);
  }
  assert.deepEqual(missing, []);
});

console.log('\nGENERATED AND COPIED:');

await check('the API reference is the API as it is now', () => {
  for (const lang of LANGS) assert.equal(page(lang, 'API-reference'), apiReference(lang), `${lang} — ${SYNC}`);
});

await check('every operation has its Russian name', () => {
  const ids = Object.values(openapiDocument().paths).flatMap(o => Object.values(o).map(x => x.operationId));
  assert.deepEqual(ids.filter(id => !RU[id]), []);
});

await check('the Help page carries exactly the wiki (frontend/src/wiki)', () => {
  const want = expectedCopy();
  for (const [rel, content] of Object.entries(want)) {
    assert.ok(existsSync(join(DEST, rel)), `${rel} missing — ${SYNC}`);
    assert.equal(readFileSync(join(DEST, rel), 'utf8'), content, `${rel} differs — ${SYNC}`);
  }
  for (const lang of LANGS) {
    const extra = readdirSync(join(DEST, lang)).filter(f => !want[`${lang}/${f}`]);
    assert.deepEqual(extra, [], `stale files — ${SYNC}`);
  }
});

await check('and the panel shows it: route, menu entry, smoke test', () => {
  const app = readFileSync(join(ROOT, 'frontend/src/App.jsx'), 'utf8');
  assert.ok(app.includes('<Route path="/help/:lang/:page" element={<HelpPage />} />'));
  assert.ok(app.includes("{ to: '/help', key: 'nav.help' }"), 'visible to everyone');
  assert.ok(readFileSync(join(ROOT, 'frontend/scripts/pages-smoke.mjs'), 'utf8').includes("['HelpPage','/help']"));
});

console.log('\nTHE RENDERER:');

await check('links: the web, anchors, wiki pages in either language — and nothing else', () => {
  assert.equal(linkTarget('https://example.net/x').kind, 'web');
  assert.deepEqual(linkTarget('#токен'), { kind: 'anchor', anchor: 'токен' });
  assert.deepEqual(linkTarget('API.md#token'), { kind: 'page', page: 'API', lang: '', anchor: 'token' });
  assert.deepEqual(linkTarget('../en/Home.md'), { kind: 'page', page: 'Home', lang: 'en', anchor: '' });
  for (const evil of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', '../../etc/passwd.md', 'vbscript:x']) {
    assert.equal(linkTarget(evil).kind, 'none', evil);
  }
});

await check('blocks: headings with ids, code kept verbatim, tables, nested lists', () => {
  const b = parse('# Права по видам\n\n```bash\ncurl -s "$P" | x\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - sub\n- two\n\ntext\nmore');
  assert.deepEqual(b.map(x => x.type), ['heading', 'code', 'table', 'list', 'para']);
  assert.equal(b[0].id, 'права-по-видам');
  assert.equal(b[1].text, 'curl -s "$P" | x');
  assert.deepEqual(b[2].rows, [['1', '2']]);
  assert.deepEqual(b[3].items, [{ text: 'one', children: ['sub'] }, { text: 'two', children: [] }]);
  assert.equal(b[4].text, 'text more');
  assert.equal(slugify('Permissions by kind'), 'permissions-by-kind');
});

await check('the renderer never sets HTML', () => {
  const src = readFileSync(join(ROOT, 'frontend/src/lib/markdown.jsx'), 'utf8');
  assert.ok(!src.includes('dangerouslySetInnerHTML'));
});

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
