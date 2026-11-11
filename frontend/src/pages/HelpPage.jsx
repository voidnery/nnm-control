import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { Markdown } from '../lib/markdown.jsx';
import { PAGES, LOADERS } from '../wiki/index.js';

// The wiki, the same pages as docs/wiki in the repository (copied by backend/scripts/wiki-sync.mjs:
// the frontend image is built from frontend/ alone). Each page is its own chunk, loaded when opened.
const LANGS = ['ru', 'en'];

export default function HelpPage() {
  const { t, lang: uiLang } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const lang = LANGS.includes(params.lang) ? params.lang : (LANGS.includes(uiLang) ? uiLang : 'en');
  const page = PAGES.order.includes(params.page) ? params.page : PAGES.order[0];
  const [source, setSource] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const load = LOADERS[`${lang}/${page}`];
    setError('');
    if (!load) { setSource(''); setError(t('help.missing')); return; }
    load().then(m => setSource(m.default)).catch(e => setError(e.message));
  }, [lang, page]);

  // After the page is there: to the anchor, or to the top.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const el = id && document.getElementById(id);
    if (el) el.scrollIntoView();
    else window.scrollTo?.(0, 0);
  }, [source]);

  const ctx = useMemo(() => ({
    hrefOf: (x) => (x.kind === 'page' ? `/help/${x.lang || lang}/${x.page}${x.anchor ? `#${x.anchor}` : ''}` : `#${x.anchor}`),
    onLink: (x) => {
      if (x.kind === 'page') navigate(`/help/${x.lang || lang}/${x.page}${x.anchor ? `#${x.anchor}` : ''}`);
      else document.getElementById(x.anchor)?.scrollIntoView();
    },
  }), [lang, navigate]);

  return (
    <div className="wiki">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>{t('page.help.title')}</h1>
        <div className="row" style={{ gap: 6 }}>
          {LANGS.map(l => (
            <button key={l} className={l === lang ? 'primary' : ''} onClick={() => navigate(`/help/${l}/${page}`)}>{l.toUpperCase()}</button>
          ))}
        </div>
      </div>
      <div className="sub">{t('page.help.sub')}</div>
      <div className="wiki-layout">
        <nav className="wiki-toc panel">
          {PAGES.order.map(slug => (
            <a key={slug} href={`/help/${lang}/${slug}`} className={slug === page ? 'active' : ''}
              onClick={(e) => { e.preventDefault(); navigate(`/help/${lang}/${slug}`); }}>
              {PAGES.titles[lang]?.[slug] || slug}
            </a>
          ))}
        </nav>
        <article className="wiki-body panel">
          {error ? <div className="error-box">{error}</div> : <Markdown source={source} ctx={ctx} />}
        </article>
      </div>
    </div>
  );
}
