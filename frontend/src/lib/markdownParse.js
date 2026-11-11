// The Markdown of the wiki as plain data: no React, so the wiki test (backend/tests/wiki.test.mjs)
// checks links and anchors with the very code the Help page renders with. markdown.jsx draws it.

export const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[`*_[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

/** What a link points at: {kind: 'web'|'anchor'|'page'|'none', page?, anchor?, href?}. */
export function linkTarget(href) {
  const h = String(href || '').trim();
  if (/^https?:\/\//i.test(h)) return { kind: 'web', href: h };
  if (h.startsWith('#')) return { kind: 'anchor', anchor: h.slice(1) };
  // `../en/Home.md` is the same page in the other language.
  const m = h.match(/^(?:\.\/|\.\.\/([a-z]{2})\/)?([A-Za-z0-9-]+)\.md(?:#(.*))?$/);
  if (m) return { kind: 'page', page: m[2], lang: m[1] || '', anchor: m[3] || '' };
  return { kind: 'none' };
}

// ---- blocks ----
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isTableSep = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** Markdown → a list of blocks (plain data, tested on its own). */
export function parse(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```\s*([\w-]*)\s*$/))) {
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: m[1], text: code.join('\n') });
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2].trim(), id: slugify(m[2]) });
      i++;
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
    } else if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
    } else if (line.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parse(q.join('\n')) });
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const lm = lines[i].match(LIST_ITEM);
        if (lm && lm[1].length < 2) items.push({ text: lm[3], children: [] });
        else if (lm) items.at(-1).children.push(lm[3]);
        else {
          // A continuation line of the item above.
          const last = items.at(-1);
          if (last.children.length) last.children[last.children.length - 1] += ` ${lines[i].trim()}`;
          else last.text += ` ${lines[i].trim()}`;
        }
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i])
        && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) p.push(lines[i++].trim());
      blocks.push({ type: 'para', text: p.join(' ') });
    }
  }
  return blocks;
}

