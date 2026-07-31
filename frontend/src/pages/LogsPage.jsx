import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import Select from '../components/Select.jsx';
import SearchInput from '../components/SearchInput.jsx';
import { copyText } from '../lib/clipboard.js';
import { cacheGet, cacheSet, rememberFilters, recallFilters } from '../lib/logCache.js';
import { useToast } from '../toast.jsx';

// iter10 m3 — the general log warehouse.
//
// The default view is GROUPED, and that is the whole design. On the measured
// data one message accounts for 93% of a server's output — 15,237 identical
// SRT errors in 31 minutes — so a chronological list is one line repeated
// eight times a second. Grouped, the same window is 142 rows and the shape of
// what is happening is legible at a glance. Raw is one click away for when
// someone needs the sequence rather than the summary.

const LEVELS = [
  { key: 'E', label: 'Error', cls: 'lvl-e' },
  { key: 'W', label: 'Warn', cls: 'lvl-w' },
  { key: 'I', label: 'Info', cls: 'lvl-i' },
  { key: 'V', label: 'Verbose', cls: 'lvl-v' },
  { key: 'D', label: 'Debug', cls: 'lvl-d' },
];
const RANGES = [
  { key: '15m', mins: 15 }, { key: '1h', mins: 60 },
  { key: '6h', mins: 360 }, { key: '24h', mins: 1440 }, { key: 'all', mins: 0 },
];

const fmtTs = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '—');
const fmtN = (n) => new Intl.NumberFormat().format(n);

export default function LogsPage() {
  const { t } = useI18n();
  const { push } = useToast();
  const { can } = useAuth();
  const [servers, setServers] = useState([]);
  const [status, setStatus] = useState(null);

  // Coming back to a page that forgot which server and level you had picked is
  // the same annoyance as coming back to an empty table.
  const saved = recallFilters('logs', {});
  const [serverId, setServerId] = useState(saved.serverId ?? '');
  const [levels, setLevels] = useState(saved.levels ?? []);   // empty = all
  const [subs, setSubs] = useState(saved.subs ?? []);
  const [range, setRange] = useState(saved.range ?? '1h');
  const [q, setQ] = useState(saved.q ?? '');
  const [mode, setMode] = useState(saved.mode ?? 'grouped');
  const [live, setLive] = useState(false);
  const [stale, setStale] = useState(0);             // age of what is on screen

  const [facets, setFacets] = useState(null);
  const [groups, setGroups] = useState(null);
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);            // expanded template
  const [openRows, setOpenRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);

  useEffect(() => {
    api('/servers').then(setServers).catch(() => {});
    api('/logs/status').then(setStatus).catch(() => {});
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (serverId) p.set('serverId', serverId);
    if (levels.length) p.set('levels', levels.join(','));
    if (subs.length) p.set('subs', subs.join(','));
    if (q.trim()) p.set('q', q.trim());
    const r = RANGES.find(x => x.key === range);
    if (r?.mins) p.set('from', new Date(Date.now() - r.mins * 60_000).toISOString());
    return p;
  }, [serverId, levels, subs, q, range]);

  const apply = useCallback((f, data, isGrouped) => {
    setFacets(f);
    if (isGrouped) { setGroups(data); setRows(null); }
    else { setRows(data); setGroups(null); }
  }, []);

  const load = useCallback(async () => {
    const qs = params.toString();
    const key = `logs|${mode}|${qs}`;

    // Whatever was last seen for this exact query goes up in the first frame,
    // and the query still runs behind it. An out-of-date table beats an empty
    // one when someone is looking for something they just saw.
    const hit = cacheGet(key);
    if (hit) { apply(hit.data.facets, hit.data.data, mode === 'grouped'); setStale(hit.ageMs); }

    setBusy(true); setError('');
    try {
      const [f, data] = await Promise.all([
        api(`/logs/facets?${qs}`),
        mode === 'grouped' ? api(`/logs/groups?${qs}&limit=100`) : api(`/logs/search?${qs}&limit=200`),
      ]);
      apply(f, data, mode === 'grouped');
      setStale(0);
      cacheSet(key, { facets: f, data });
    } catch (e) {
      // A failed refresh must not wipe what is already readable on screen.
      setError(e.message === 'tooWide' ? t('logs.tooWide') : e.message);
    } finally { setBusy(false); }
  }, [params, mode, apply, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    rememberFilters('logs', { serverId, levels, subs, range, q, mode });
  }, [serverId, levels, subs, range, q, mode]);

  // Live follow only makes sense on the raw view; a grouped view that reshuffles
  // every few seconds is unreadable.
  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (live) timer.current = setInterval(load, 5000);
    return () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  }, [live, load]);

  const toggle = (arr, set, key) => set(arr.includes(key) ? arr.filter(x => x !== key) : [...arr, key]);

  const expand = async (g) => {
    if (open === g.template) { setOpen(null); setOpenRows(null); return; }
    setOpen(g.template); setOpenRows(null);
    try {
      const p = new URLSearchParams(params);
      p.set('template', g.template);
      p.set('subs', g.sub);
      p.set('levels', g.level);
      setOpenRows(await api(`/logs/groups/rows?${p.toString()}`));
    } catch (e) { setOpenRows({ rows: [], error: e.message }); }
  };

  const serverName = (id) => servers.find(s => s.id === id)?.name || id.slice(-6);

  return (
    <div>
      <h1>{t('logs.title')}</h1>
      <div className="sub">{t('logs.sub')}</div>

      {/* Telling someone to go and flip a switch on another page is poor when
          the panel already knows they are allowed to flip it. */}
      {status && !status.settings?.enabled && (
        <div className="error-box">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{can('settings.manage') ? t('logs.disabledCanFix') : t('logs.disabled')}</span>
            {can('settings.manage') && (
              <div className="row" style={{ flexShrink: 0 }}>
                <button className="primary" onClick={async () => {
                  try {
                    await api('/logs/collector', { method: 'POST', body: { enabled: true } });
                    setStatus(await api('/logs/status'));
                    push({ type: 'ok', message: t('logs.enabledNow') });
                    load();
                  } catch (e) { setError(e.message === 'tooWide' ? t('logs.tooWide') : e.message); }
                }}>{t('logs.enableNow')}</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select value={serverId} onChange={setServerId} style={{ minWidth: 180 }}
                  options={[{ value: '', label: t('logs.allServers') },
                            ...servers.map(s => ({ value: s.id, label: s.name }))]} />
          <Select value={range} onChange={setRange} style={{ width: 120 }}
                  options={RANGES.map(r => ({ value: r.key, label: t(`logs.range.${r.key}`) }))} />
          <SearchInput style={{ flex: 1, minWidth: 220 }} value={q} onChange={setQ}
                       placeholder={t('logs.searchPlaceholder')} />
          <button onClick={load} disabled={busy}>{busy ? '…' : t('action.refresh')}</button>
        </div>

        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="hint">{t('logs.level')}</span>
          {LEVELS.map(l => {
            const n = facets?.levels?.find(x => x.key === l.key)?.n || 0;
            return (
              <button key={l.key} className={levels.includes(l.key) ? 'primary' : ''}
                      onClick={() => toggle(levels, setLevels, l.key)} title={l.label}>
                {l.key}{n ? ` ${fmtN(n)}` : ''}
              </button>
            );
          })}
          <span style={{ width: 12 }} />
          <span className="hint">{t('logs.subsystem')}</span>
          {(facets?.subs || []).slice(0, 14).map(s => (
            <button key={s.key} className={subs.includes(s.key) ? 'primary' : ''}
                    onClick={() => toggle(subs, setSubs, s.key)}>
              {s.key} {fmtN(s.n)}
            </button>
          ))}
          {(levels.length > 0 || subs.length > 0) && (
            <button onClick={() => { setLevels([]); setSubs([]); }}>{t('logs.clearFilters')}</button>
          )}
        </div>

        <div className="row" style={{ gap: 12, marginTop: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="radio" checked={mode === 'grouped'} onChange={() => setMode('grouped')} />
            {t('logs.grouped')}
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="radio" checked={mode === 'raw'} onChange={() => setMode('raw')} />
            {t('logs.raw')}
          </label>
          {mode === 'raw' && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} />
              {t('logs.follow')}
            </label>
          )}
          {groups && (
            <span className="hint">
              {t('logs.collapsed', { records: fmtN(groups.scanned), templates: fmtN(groups.distinct) })}
              {groups.capped && <> · {t('logs.capped')}</>}
            </span>
          )}
          {stale > 0 && busy && <span className="hint">{t('logs.showingCached', { s: Math.round(stale / 1000) })}</span>}
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {mode === 'grouped' && groups && (
        <div className="panel">
          <table>
            <thead><tr>
              <th style={{ width: 90 }}>{t('logs.count')}</th>
              <th style={{ width: 70 }}>{t('logs.lvl')}</th>
              <th style={{ width: 130 }}>{t('logs.subsystem')}</th>
              <th>{t('logs.message')}</th>
              <th style={{ width: 160 }}>{t('logs.lastSeen')}</th>
            </tr></thead>
            <tbody>
              {groups.groups.map(g => (
                <>
                  <tr key={g.sub + g.level + g.template} className="tally" style={{ cursor: 'pointer' }}
                      onClick={() => expand(g)}>
                    <td className="mono"><b>{fmtN(g.count)}</b></td>
                    <td><span className={'badge ' + (g.level === 'E' ? 'err' : 'live')}>{g.level}</span></td>
                    <td className="mono">{g.sub}</td>
                    <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                      {g.template}
                      {/* Only when it could be ambiguous. On a single-server
                          view the chip would be noise on every row. */}
                      {!serverId && g.servers > 0 && (
                        <span className="srv-chip" title={(g.serverNames || []).join(', ')}>
                          {g.servers === 1 ? (g.serverNames?.[0] || '?') : t('logs.nServers', { n: g.servers })}
                        </span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtTs(g.last)}</td>
                  </tr>
                  {open === g.template && (
                    <tr key={g.template + '-rows'}>
                      <td colSpan={5} style={{ background: 'var(--panel2, rgba(0,0,0,.15))' }}>
                        {!openRows ? <div className="hint">{t('sd.loading')}</div> : (
                          <>
                            <div className="row" style={{ justifyContent: 'space-between' }}>
                              <span className="hint">{t('logs.samples', { n: openRows.rows.length })}</span>
                              <button onClick={async (e) => {
                                e.stopPropagation();
                                const text = openRows.rows.map(r => `[${r.raw}] [${r.tag}] ${r.level}: ${r.msg}`).join('\n');
                                push(await copyText(text)
                                  ? { type: 'ok', message: t('srt.copied') }
                                  : { type: 'error', message: t('copy.failed') });
                              }}>{t('srt.copy')}</button>
                            </div>
                            <pre className="mono" style={{ fontSize: 11, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                              {openRows.rows.map(r => `[${r.raw}] P${r.pid}-T${r.tid} [${r.tag}] ${r.level}: ${r.msg}${r.cont ? '\n' + r.cont : ''}`).join('\n')}
                            </pre>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {groups.groups.length === 0 && (
                <tr><td colSpan={5} className="hint">{t('logs.nothing')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {mode === 'raw' && rows && (
        <div className="panel">
          <table>
            <thead><tr>
              <th style={{ width: 160 }}>{t('logs.time')}</th>
              <th style={{ width: 40 }}></th>
              <th style={{ width: 120 }}>{t('logs.subsystem')}</th>
              {!serverId && <th style={{ width: 120 }}>{t('logs.server')}</th>}
              <th>{t('logs.message')}</th>
            </tr></thead>
            <tbody>
              {rows.rows.map(r => (
                <tr key={r.id} className="tally">
                  <td className="mono" style={{ fontSize: 12 }}>{r.raw?.replace('T', ' ') || fmtTs(r.ts)}</td>
                  <td><span className={'badge ' + (r.level === 'E' ? 'err' : 'live')}>{r.level}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.tag}</td>
                  {!serverId && <td className="mono" style={{ fontSize: 12 }}>{r.serverName || serverName(r.serverId)}</td>}
                  <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {r.msg}
                    {r.contLines > 0 && <span className="hint"> · {t('logs.plusLines', { n: r.contLines })}</span>}
                  </td>
                </tr>
              ))}
              {rows.rows.length === 0 && (
                <tr><td colSpan={serverId ? 4 : 5} className="hint">{t('logs.nothing')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
