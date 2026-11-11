// A small Markdown renderer for the wiki (docs/wiki, shown on the Help page).
//
// Only what the wiki uses: headings, paragraphs, lists (one level of nesting), fenced code, tables,
// quotes, rules; inline code, bold, italic, links. It builds React elements and never sets HTML, so a
// page cannot carry a script; a link is followed only if it is http(s), an anchor or another wiki page.
import { Fragment } from 'react';
import { linkTarget, parse } from './markdownParse.js';

export { slugify, linkTarget, parse } from './markdownParse.js';

// ---- inline ----
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;

export function inline(text, ctx = {}, keyBase = 'i') {
  const out = [];
  let last = 0;
  let n = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}${n++}`;
    if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<b key={key}>{inline(tok.slice(2, -2), ctx, key)}</b>);
    else if (tok.startsWith('[')) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const target = linkTarget(href);
      const kids = inline(label, ctx, key);
      if (target.kind === 'web') out.push(<a key={key} href={target.href} target="_blank" rel="noopener noreferrer">{kids}</a>);
      else if (target.kind === 'none') out.push(<span key={key}>{kids}</span>);
      else {
        out.push(<a key={key} href={ctx.hrefOf ? ctx.hrefOf(target) : '#'}
          onClick={(e) => { if (ctx.onLink) { e.preventDefault(); ctx.onLink(target); } }}>{kids}</a>);
      }
    } else out.push(<i key={key}>{inline(tok.slice(1, -1), ctx, key)}</i>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Block({ b, ctx, k }) {
  switch (b.type) {
    case 'heading': {
      const H = `h${Math.min(b.level + 0, 4)}`;
      return <H id={b.id}>{inline(b.text, ctx, k)}</H>;
    }
    case 'code': return <pre className="mono wiki-code"><code>{b.text}</code></pre>;
    case 'rule': return <hr />;
    case 'quote': return <blockquote className="wiki-note">{b.blocks.map((x, j) => <Block key={j} b={x} ctx={ctx} k={`${k}q${j}`} />)}</blockquote>;
    case 'table': return (
      <div className="wiki-table"><table>
        <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(c, ctx, `${k}h${j}`)}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c, ctx, `${k}r${j}c${x}`)}</td>)}</tr>)}</tbody>
      </table></div>
    );
    case 'list': {
      const L = b.ordered ? 'ol' : 'ul';
      return (
        <L>{b.items.map((it, j) => (
          <li key={j}>{inline(it.text, ctx, `${k}l${j}`)}
            {it.children.length > 0 && <ul>{it.children.map((c, x) => <li key={x}>{inline(c, ctx, `${k}l${j}c${x}`)}</li>)}</ul>}
          </li>
        ))}</L>
      );
    }
    default: return <p>{inline(b.text, ctx, k)}</p>;
  }
}

/** `ctx`: {onLink(target), hrefOf(target)} for links to other pages and anchors. */
export function Markdown({ source, ctx }) {
  const blocks = parse(source);
  return <Fragment>{blocks.map((b, j) => <Block key={j} b={b} ctx={ctx || {}} k={`b${j}`} />)}</Fragment>;
}
