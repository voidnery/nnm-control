// The wiki for the GitHub Wiki tab. That is a separate git repository with no folders, so the same page
// in two languages cannot keep one name: here docs/wiki/ru/Playlists.md becomes ru-Playlists.md and
// en/Playlists.md en-Playlists.md, every link is rewritten to the wiki's form (`ru-Playlists#anchor`),
// Home.md is a choice of language and _Sidebar.md lists both.
//
//   node backend/scripts/wiki-export.mjs [folder]     (default: ../nnm-control.wiki, next to this repo)
//
// The folder is a clone of https://github.com/voidnery/nnm-control.wiki.git; commit and push it after.
// docs/wiki stays the source — what is edited in the Wiki tab is overwritten by the next export.
// tests/wiki.test.mjs holds the export: unique names, every link and anchor leading somewhere.
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SRC, ROOT, LANGS, apiReference } from './wiki-sync.mjs';
import { linkTarget } from '../../frontend/src/lib/markdownParse.js';

export const wikiName = (lang, slug) => `${lang}-${slug}`;
// What an export owns in the folder, and so removes before writing: a page dropped from docs/wiki
// disappears from the Wiki tab too. Anything else there (and .git) is left alone.
export const OWNED = (file) => /^(ru|en)-[A-Za-z0-9-]+\.md$/.test(file) || ['Home.md', '_Sidebar.md', '_Footer.md'].includes(file);

const NOTE = {
  ru: 'Сгенерировано из `docs/wiki` репозитория — правьте там, правки здесь перезапишет следующая выгрузка.',
  en: 'Generated from `docs/wiki` in the repository — edit there; changes made here are overwritten by the next export.',
};
const LANG_NAME = { ru: 'Русский', en: 'English' };

/** A link as the wiki needs it, or the link untouched (web, unknown). */
export function wikiHref(href, lang) {
  const t = linkTarget(href);
  if (t.kind !== 'page') return href;
  return wikiName(t.lang || lang, t.page) + (t.anchor ? `#${t.anchor}` : '');
}

/** Rewrites the links of one page; code blocks and inline code are left as written. */
export function rewriteLinks(md, lang) {
  let fenced = false;
  return md.split('\n').map(line => {
    if (/^```/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.split(/(`[^`]*`)/).map((part, i) => (i % 2
      ? part
      : part.replace(/\]\(([^)\s]+)\)/g, (_, href) => `](${wikiHref(href, lang)})`))).join('');
  }).join('\n');
}

const titleOf = (md) => (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';

/** What the wiki repository must hold: {file name → content}. */
export function wikiExport() {
  const order = JSON.parse(readFileSync(join(SRC, 'pages.json'), 'utf8')).order;
  const files = {};
  const titles = {};
  for (const lang of LANGS) {
    titles[lang] = {};
    for (const slug of order) {
      const md = slug === 'API-reference' ? apiReference(lang) : readFileSync(join(SRC, lang, `${slug}.md`), 'utf8').replace(/\r\n/g, '\n');
      files[`${wikiName(lang, slug)}.md`] = rewriteLinks(md, lang);
      titles[lang][slug] = titleOf(md);
    }
  }
  files['Home.md'] = [
    '# NNM-Control',
    '',
    ...LANGS.map(lang => `- **[${LANG_NAME[lang]}](${wikiName(lang, 'Home')})**`),
    '',
    `${NOTE.ru}`,
    '',
    `${NOTE.en}`,
    '',
  ].join('\n');
  files['_Sidebar.md'] = LANGS.flatMap(lang => [
    `**${LANG_NAME[lang]}**`,
    '',
    ...order.map(slug => `- [${titles[lang][slug]}](${wikiName(lang, slug)})`),
    '',
  ]).join('\n');
  files['_Footer.md'] = `${NOTE.ru}  \n${NOTE.en}\n`;
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = resolve(process.argv[2] || join(ROOT, '..', 'nnm-control.wiki'));
  if (!existsSync(dir)) {
    console.error(`wiki-export: no folder ${dir} — clone https://github.com/voidnery/nnm-control.wiki.git there first, or name the folder`);
    process.exit(1);
  }
  if (!existsSync(join(dir, '.git'))) console.warn(`wiki-export: ${dir} is not a git clone — writing anyway`);
  for (const f of readdirSync(dir).filter(OWNED)) rmSync(join(dir, f));
  const files = wikiExport();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  console.log(`wiki-export: ${Object.keys(files).length} files → ${dir}`);
}
