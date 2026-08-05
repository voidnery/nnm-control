import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import SearchInput from './SearchInput.jsx';
import { copyText } from '../lib/clipboard.js';
import { cacheGet, cacheSet, cacheKey } from '../lib/logCache.js';
import IconButton from './IconButton.jsx';

// iter10 m4 — one log window.
//
// Self-contained on purpose: it owns its filters, its polling and its state,
// and takes only a scope and a size. That is what lets the categorical page
// render seven of them side by side, and what will let m5 let an operator
// place any number of them on a dashboard of their own without this component
// learning anything about dashboards.
//
// Grouped by default for the same reason as the general view: on the measured
// data one message is 93% of a server's output, so a chronological list of a
// busy category is one line repeated eight times a second.

const LEVELS = ['E', 'W', 'I', 'V', 'D'];
const RANGES = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440, all: 0 };
const fmtN = (n) => new Intl.NumberFormat().format(n);
const hhmmss = (d) => (d ? new Date(d).toISOString().slice(11, 19) : '—');

export default function LogWindow({
  title,
  category = 'all',
  serverId = '',
  initialLevels = [],
  initialRange = '1h',
  initialQuery = '',
  height = 260,
  refreshMs = 0,
  onRemove = null,
  onConfigChange = null,
  onEdit = null,
  // iter10 m5 — a shared dashboard fetches through a token route where the
  // filters live in the database, not in the query string. Injecting the
  // fetch keeps that one component rather than two that drift.
  fetchData = null,
  controls = true,
}) {
  const { t } = useI18n();
  const { push } = useToast();
  const [levels, setLevels] = useState(initialLevels);
  const [range, setRange] = useState(initialRange);
  const [q, setQ] = useState(initialQuery);
  const [mode, setMode] = useState('grouped');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [openRows, setOpenRows] = useState(null);
  const timer = useRef(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (category && category !== 'all') p.set('category', category);
    if (serverId) p.set('serverId', serverId);
    if (levels.length) p.set('levels', levels.join(','));
    if (q.trim()) p.set('q', q.trim());
    const mins = RANGES[range];
    if (mins) p.set('from', new Date(Date.now() - mins * 60_000).toISOString());
    return p.toString();
  }, [category, serverId, levels, q, range]);

  // m5 will persist whatever the operator tuned, so the window reports its own
  // configuration rather than the dashboard having to reach inside it.
  useEffect(() => {
    onConfigChange?.({ category, levels, range, query: q, mode });
  }, [category, levels, range, q, mode, onConfigChange]);

  const load = useCallback(async () => {
    // A dashboard of seven windows meant seven blank panes on every visit.
    // Each window shows its own last answer immediately and refreshes behind
    // it; a shared link, whose fetch is token-scoped, is not cached here.
    const key = fetchData ? null : cacheKey('win', { mode, serverId, category, levels, range, query: q });
    if (key) {
      const hit = cacheGet(key);
      if (hit) setData(hit.data);
    }
    setBusy(true); setError('');
    try {
      const d = fetchData
        ? await fetchData({ mode })
        : await api(mode === 'grouped' ? `/logs/groups?${qs}&limit=40` : `/logs/search?${qs}&limit=120`);
      setData(d);
      if (key) cacheSet(key, d);
    } catch (e) {
      // Keep whatever is on screen: a failed refresh should not empty a window
      // an operator is reading.
      setError(e.message === 'tooWide' ? t('logs.tooWide') : e.message);
    } finally { setBusy(false); }
  }, [qs, mode, fetchData, t, serverId, category, levels, range, q]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (refreshMs > 0) timer.current = setInterval(load, refreshMs);
    return () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  }, [refreshMs, load]);

  const toggleLevel = (l) => setLevels(levels.includes(l) ? levels.filter(x => x !== l) : [...levels, l]);

  const expand = async (g) => {
    if (fetchData) return;                 // shared views are read-only summaries
    if (open === g.template) { setOpen(null); setOpenRows(null); return; }
    setOpen(g.template); setOpenRows(null);
    try {
      const p = new URLSearchParams(qs);
      p.set('template', g.template);
      p.set('subs', g.sub);
      p.set('levels', g.level);
      setOpenRows(await api(`/logs/groups/rows?${p.toString()}`));
    } catch (e) { setOpenRows({ rows: [], error: e.message }); }
  };

  const copyAll = async () => {
    const text = mode === 'grouped'
      ? (data?.groups || []).map(g => `${g.count}\t${g.level}\t${g.sub}\t${g.template}`).join('\n')
      : (data?.rows || []).map(r => `[${r.raw}] [${r.tag}] ${r.level}: ${r.msg}`).join('\n');
    push(await copyText(text) ? { type: 'ok', message: t('srt.copied') } : { type: 'error', message: t('copy.failed') });
  };

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <b style={{ whiteSpace: 'nowrap' }}>{title || t(`logs.cat.${category}`)}</b>
        <div className="row" style={{ gap: 4 }}>
          {controls && LEVELS.map(l => (
            <button key={l} className={levels.includes(l) ? 'primary' : ''}
                    style={{ padding: '2px 6px', fontSize: 11 }}
                    onClick={() => toggleLevel(l)}>{l}</button>
          ))}
          {controls && (
            <select value={range} onChange={e => setRange(e.target.value)} style={{ fontSize: 11 }}>
              {Object.keys(RANGES).map(k => <option key={k} value={k}>{t(`logs.range.${k}`)}</option>)}
            </select>
          )}
          {controls && (
            <button style={{ padding: '2px 6px', fontSize: 11 }}
                    onClick={() => setMode(mode === 'grouped' ? 'raw' : 'grouped')}>
              {mode === 'grouped' ? t('logs.grouped') : t('logs.raw')}
            </button>
          )}
          <button style={{ padding: '2px 6px', fontSize: 11 }} onClick={load} disabled={busy}>
            {busy ? '…' : '⟳'}
          </button>
          {controls && <button style={{ padding: '2px 6px', fontSize: 11 }} onClick={copyAll}>{t('srt.copy')}</button>}
          {onEdit && (
            <IconButton action="edit" style={{ padding: '2px 6px', fontSize: 11 }} onClick={onEdit} />
          )}
          {onRemove && (
            <button className="danger" style={{ padding: '2px 6px', fontSize: 11 }} onClick={onRemove}>×</button>
          )}
        </div>
      </div>

      {controls && (
        <div style={{ marginTop: 6 }}>
          <SearchInput value={q} onChange={setQ} placeholder={t('logs.searchPlaceholder')} />
        </div>
      )}

      {error && <div className="error-box" style={{ marginTop: 6 }}>{error}</div>}

      <div style={{ marginTop: 6, height, overflow: 'auto', minWidth: 0 }}>
        {mode === 'grouped' ? (
          <table style={{ width: '100%' }}>
            <tbody>
              {(data?.groups || []).map(g => (
                <Fragment key={g.sub + g.level + g.template}>
                  <tr key={g.sub + g.level + g.template} className="tally" style={{ cursor: 'pointer' }}
                      onClick={() => expand(g)}>
                    <td className="mono" style={{ width: 70, fontSize: 12 }}><b>{fmtN(g.count)}</b></td>
                    <td style={{ width: 34 }}>
                      <span className={'badge ' + (g.level === 'E' ? 'err' : 'live')}>{g.level}</span>
                    </td>
                    <td className="mono" style={{ width: 110, fontSize: 11 }}>{g.sub}</td>
                    <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {g.template}
                      {!serverId && g.servers > 0 && (
                        <span className="srv-chip" title={(g.serverNames || []).join(', ')}>
                          {g.servers === 1 ? (g.serverNames?.[0] || '?') : t('logs.nServers', { n: g.servers })}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open === g.template && (
                    <tr key={g.template + '-x'}>
                      <td colSpan={4}>
                        <pre className="mono" style={{ fontSize: 10, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                          {!openRows ? '…' : openRows.rows.map(r =>
                            `[${r.raw}] [${r.tag}] ${r.level}: ${r.msg}`).join('\n') || t('logs.nothing')}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {data && !data.groups?.length && (
                <tr><td className="hint" style={{ fontSize: 12 }}>{t('logs.nothing')}</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table style={{ width: '100%' }}>
            <tbody>
              {(data?.rows || []).map(r => (
                <tr key={r.id} className="tally">
                  <td className="mono" style={{ width: 62, fontSize: 11 }}>{hhmmss(r.ts)}</td>
                  <td style={{ width: 34 }}>
                    <span className={'badge ' + (r.level === 'E' ? 'err' : 'live')}>{r.level}</span>
                  </td>
                  <td className="mono" style={{ width: 100, fontSize: 11 }}>{r.tag}</td>
                  <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {r.msg}
                    {!serverId && r.serverName && <span className="srv-chip">{r.serverName}</span>}
                  </td>
                </tr>
              ))}
              {data && !data.rows?.length && (
                <tr><td className="hint" style={{ fontSize: 12 }}>{t('logs.nothing')}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {mode === 'grouped' && data && (
        <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>
          {t('logs.collapsed', { records: fmtN(data.scanned || 0), templates: fmtN(data.distinct || 0) })}
          {data.capped && <> · {t('logs.capped')}</>}
        </div>
      )}
    </div>
  );
}
