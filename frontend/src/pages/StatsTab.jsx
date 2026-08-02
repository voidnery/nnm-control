import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Select from '../components/Select.jsx';
import SearchInput from '../components/SearchInput.jsx';
import Plot from '../components/Plot.jsx';

const RANGES = [15, 60, 360, 1440, 4320];   // minutes; the last matches 3-day retention
const GROUP_ORDER = ['streams', 'republish', 'srt', 'server'];
// Not every numeric field is a measurement. Identifiers and ports are numbers
// but charting them is meaningless, and totals like bytes_sent only ever climb —
// drawn raw they dwarf every other series on a shared axis (a 10 Gb ramp next to
// a 10 Mbps line). So each counter is classified and handled accordingly.
const IDENT = /^(owner|id|.*_id|port|.*_port)$/i;
const CUMULATIVE = /(^bytes_|_bytes$|^packets?_|_packets?$|^pkt|_count$|_total$|_errors?$)/i;
export const classify = (m) =>
  IDENT.test(m) ? 'ident' : CUMULATIVE.test(m) ? 'counter' : 'gauge';

const isRate = (m) => /bandwidth|bitrate|bps/i.test(m);
// What a metric is measured in. The fallback was an empty string for anything
// that was not a rate or a counter, so RTT read "9.81" and a byte total read
// "29,000,000,000" — figures the reader has to guess the unit of.
const unitFor = (m) => {
  if (/mbpsRate|mbpsBandwidth/i.test(m)) return 'Mbps';   // Nimble reports these in megabits already
  if (/rtt|msRTT|_ms$/i.test(m)) return 'ms';
  if (/bytes/i.test(m)) return 'B';
  if (/packets|NAKs|_flow$|_congestion$|_flight$/i.test(m)) return 'pkt';
  if (/_pct$|percent/i.test(m)) return '%';
  if (isRate(m)) return 'bps';
  return classify(m) === 'counter' ? '/s' : '';
};

// A total is only useful as "how fast is it moving"; convert to per-second and
// drop the step where a counter resets (restart) instead of drawing a cliff.
export function toRate(points, idx) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (new Date(points[i].ts) - new Date(points[i - 1].ts)) / 1000;
    const a = points[i - 1].v[idx], b = points[i].v[idx];
    const ok = dt > 0 && typeof a === 'number' && typeof b === 'number' && b >= a;
    out.push({ ts: points[i].ts, v: [ok ? (b - a) / dt : null] });
  }
  return out;
}

export default function StatsTab({ serverId }) {
  const { t } = useI18n();
  const [subjects, setSubjects] = useState(null);
  const [subject, setSubject] = useState('');
  const [metrics, setMetrics] = useState([]);
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState(true);
  const [health, setHealth] = useState(null);
  const [showHealth, setShowHealth] = useState(false);
  // iter16 m3 — everything at once, which is what a Charts tab is for.
  const [mode, setMode] = useState('summary');
  const [summary, setSummary] = useState(null);
  const [showIdle, setShowIdle] = useState(false);

  const loadSubjects = useCallback(async () => {
    try {
      const d = await api(`/stats/${serverId}/subjects`);
      setSubjects(d.subjects || []);
      setSubject(s => s || d.subjects?.[0]?.subject || '');
    } catch (e) { setError(e.message); }
  }, [serverId]);
  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  // Why this server has little or nothing: fetched alongside the subjects so an
  // empty tab can explain itself instead of just looking broken.
  const loadHealth = useCallback(async () => {
    try {
      const d = await api('/stats/_health');
      setHealth((d.servers || []).find(x => x.serverId === String(serverId)) || null);
    } catch { setHealth(null); }
  }, [serverId]);
  useEffect(() => { loadHealth(); }, [loadHealth]);
  useEffect(() => { if (subjects && subjects.length === 0) setShowHealth(true); }, [subjects]);

  const current = useMemo(() => (subjects || []).find(s => s.subject === subject) || null, [subjects, subject]);

  // Default to the most useful counters for the subject instead of an empty chart.
  useEffect(() => {
    if (!current) return;
    const chartable = current.metrics.filter(m => classify(m) !== 'ident');
    const preferred = chartable.filter(isRate).slice(0, 1);
    setMetrics(preferred.length ? preferred : chartable.slice(0, 1));
  }, [current]);

  const loadSeries = useCallback(async () => {
    if (!subject || !metrics.length) { setData(null); return; }
    try {
      const q = new URLSearchParams({ subject, metrics: metrics.join(','), minutes: String(minutes) });
      setData(await api(`/stats/${serverId}/series?${q}`));
      setError('');
    } catch (e) { setError(e.message); }
  }, [serverId, subject, metrics, minutes]);
  useEffect(() => { loadSeries(); }, [loadSeries]);

  // Live view refreshes on the collection cadence; long ranges do not need it.
  useEffect(() => {
    if (!live || minutes > 360) return;
    const id = setInterval(loadSeries, 10_000);
    return () => clearInterval(id);
  }, [live, minutes, loadSeries]);

  // The rate metric, whichever this build calls it. Discovered from what a
  // subject holds rather than named here — that mistake has been made twice
  // in this epic and cost a release each time.
  const rateKeyOf = (subj) => (subj?.metrics || [])
    .find(k => /rate|bitrate|bandwidth/i.test(k) && !/max/i.test(k)) || null;

  // Which subjects the summary draws.
  //
  // A server here carries seventy SRT subjects and half are disconnected
  // sockets holding a retry counter. Drawing all of them is seventy charts of
  // nothing, and the ones worth looking at are lost among them. So: subjects
  // that have a rate metric at all, and by default only those. The rest are
  // counted and one click away — hiding a thing without saying it exists is
  // the failure mode to avoid here.
  const summarisable = useMemo(() => (subjects || [])
    .filter(x => x.group === 'srt' && rateKeyOf(x)), [subjects]);

  const loadSummary = useCallback(async () => {
    if (mode !== 'summary' || !summarisable.length) return;
    const keys = [...new Set(summarisable.map(rateKeyOf))].slice(0, 4);
    try {
      const d = await api(`/stats/${serverId}/multi`
        + `?subjects=${summarisable.map(x => encodeURIComponent(x.subject)).join(',')}`
        + `&metrics=${keys.join(',')}&minutes=${minutes}`);
      setSummary(d);
      setError('');
    } catch (e) { setError(e.message); }
  }, [serverId, mode, summarisable, minutes]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => {
    if (!live || mode !== 'summary') return undefined;
    const id = setInterval(loadSummary, 15_000);
    return () => clearInterval(id);
  }, [live, mode, loadSummary]);

  // Busiest first: on a screen that cannot hold everything, the streams moving
  // the most traffic are the ones worth the space.
  const summaryRows = useMemo(() => {
    const rows = (summary?.series || []).map(sr => {
      const bps = (sr.latest || []).find(v => Number.isFinite(v)) ?? null;
      return { ...sr, bps: bps != null && bps < 1000 ? bps * 1e6 : bps };
    });
    rows.sort((a, b) => (b.bps ?? -1) - (a.bps ?? -1));
    return rows;
  }, [summary]);

  const carrying = summaryRows.filter(r => (r.bps ?? 0) > 200_000);
  const idle = summaryRows.filter(r => (r.bps ?? 0) <= 200_000);

  const shown = (subjects || []).filter(s =>
    !filter || `${s.label} ${s.subject}`.toLowerCase().includes(filter.toLowerCase()));
  const grouped = GROUP_ORDER
    .map(g => ({ g, items: shown.filter(s => s.group === g) }))
    .filter(x => x.items.length);


  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      {/* Two children, always: the empty span used to be a spacer holding the
          layout together. Made explicit so the shape does not depend on which
          branch rendered. */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        {/* Summary first: "how is everything" is the question this tab is
            opened with, and picking one stream out of seventy is the follow-up,
            not the opening move. */}
        <div className="row pair" style={{ gap: 6 }}>
          <button className={mode === 'summary' ? 'primary' : ''} onClick={() => setMode('summary')}>
            {t('stats.modeSummary')}
          </button>
          <button className={mode === 'one' ? 'primary' : ''} onClick={() => setMode('one')}>
            {t('stats.modeOne')}
          </button>
          <span className="hint">{subjects && subjects.length === 0 ? t('stats.none') : ''}</span>
        </div>
        <div className="row" style={{ flexShrink: 0 }}>
          <button className="linklike" onClick={() => { setShowHealth(v => !v); loadHealth(); }}>
            {showHealth ? t('stats.hideHealth') : t('stats.showHealth')}
          </button>
        </div>
      </div>

      {showHealth && (
        <div className="panel" style={{ marginBottom: 10 }}>
          <b>{t('stats.healthTitle')}</b>
          {!health ? (
            <div className="hint" style={{ marginTop: 6 }}>{t('stats.healthNone')}</div>
          ) : (
            <>
              <div className="hint" style={{ marginTop: 4 }}>
                {t('stats.healthAt', { at: new Date(health.at).toLocaleTimeString(), n: health.samples })}
              </div>
              {health.error && <div className="error-box" style={{ marginTop: 6 }}>{health.error}</div>}
              <div className="kv-grid" style={{ marginTop: 6 }}>
                {Object.entries(health.report || {}).map(([ep, r]) => (
                  <Fragment key={ep}>
                    <div className="kv-k" key={ep + 'k'}>{ep}</div>
                    <div className="kv-v" key={ep + 'v'}>
                      {/* A count on its own reads as health. Sixty disconnected
                          sockets make sixty subjects that hold a retry counter
                          and nothing to draw — and then the charts are empty
                          for a reason this line called fine. */}
                      {r.status === 'ok' && (
                        <span>
                          <span className={'lamp ' + (r.withData ? 'on' : 'warn')} />
                          {t('stats.hOk', { n: r.count })}
                          {r.withData !== undefined && (
                            <span className="hint" style={{ marginLeft: 6 }}>
                              {r.withData
                                ? t('stats.hWithData', { n: r.withData })
                                : t('stats.hNoData')}
                            </span>
                          )}
                        </span>
                      )}
                      {r.status === 'empty' && <span className="hint">— {r.hint}</span>}
                      {r.status === 'error' && <span><span className="lamp off" />{r.error}</span>}
                    </div>
                  </Fragment>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>{t('stats.healthHint')}</div>
              {/* Said where the question arises. The control-plane banner sits
                  at the top of the page and was read as covering this too. */}
              <div className="hint" style={{ marginTop: 2 }}>{t('stats.healthPlane')}</div>
            </>
          )}
        </div>
      )}

      {mode === 'summary' && (
        <div>
          <div className="row" style={{ gap: 12, marginBottom: 8, alignItems: 'center' }}>
            <span className="hint">
              {t('stats.sumCarrying', { n: carrying.length, total: summarisable.length })}
            </span>
            {idle.length > 0 && (
              <button className="linklike" onClick={() => setShowIdle(v => !v)}>
                {showIdle ? t('stats.sumHideIdle') : t('stats.sumShowIdle', { n: idle.length })}
              </button>
            )}
            <button onClick={loadSummary}>{t('action.refresh')}</button>
          </div>

          {!summarisable.length && <div className="panel hint">{t('stats.sumNothing')}</div>}

          {/* Small multiples, sized so a whole fleet's worth fits without
              scrolling past the interesting ones. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {(showIdle ? summaryRows : carrying).map(r => (
              <div key={r.subject} className="panel" style={{ padding: 8, minWidth: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={r.subject}>
                    {r.label || r.subject}
                  </span>
                  <span className="mono" style={{ fontSize: 12, flexShrink: 0,
                                                  color: (r.bps ?? 0) > 200_000 ? 'inherit' : 'var(--warn)' }}>
                    {r.bps == null ? '—'
                      : r.bps >= 1e6 ? `${(r.bps / 1e6).toFixed(1)} Mb/s`
                      : `${(r.bps / 1e3).toFixed(0)} kb/s`}
                  </span>
                </div>
                {/* Clicking through to one stream is the follow-up question,
                    so the card answers it. */}
                <div style={{ cursor: 'pointer' }}
                     onClick={() => { setSubject(r.subject); setMode('one'); }}>
                  <Plot points={r.points.map(p => ({
                    ts: p.ts,
                    v: [(() => { const x = p.v.find(y => Number.isFinite(y));
                                 return x == null ? null : (x < 1000 ? x * 1e6 : x); })()],
                  }))} series={[t('wo.histRate')]} unit="bps" height={90} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
                                    display: mode === 'summary' ? 'none' : undefined }}>
        <div style={{ flex: '0 0 280px' }}>
          <SearchInput value={filter} onChange={setFilter} placeholder={t('stats.filterSubjects')} />
          <div className="panel" style={{ marginTop: 6, maxHeight: 420, overflow: 'auto', padding: 6 }}>
            {grouped.map(({ g, items }) => (
              <div key={g} style={{ marginBottom: 8 }}>
                <div className="hint" style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '.5px' }}>{t('stats.group.' + g)}</div>
                {items.map(s => (
                  <div key={s.subject}
                       className={'cselect-opt' + (s.subject === subject ? ' selected' : '')}
                       style={{ fontSize: 12 }}
                       onClick={() => setSubject(s.subject)}>
                    {s.label || s.subject}
                  </div>
                ))}
              </div>
            ))}
            {grouped.length === 0 && <div className="hint" style={{ fontSize: 12 }}>—</div>}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 320 }}>
          <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 150 }}>
              <Select value={String(minutes)} onChange={v => setMinutes(Number(v))}
                      options={RANGES.map(m => ({ value: String(m), label: t('stats.range', { m: m < 60 ? `${m}m` : `${Math.round(m / 60)}h` }) }))} />
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> {t('stats.live')}
            </label>
            <button onClick={() => { loadSubjects(); loadSeries(); }}>{t('action.refresh')}</button>
            {data?.bucketMs > 0 && (
              <span className="hint" style={{ marginLeft: 'auto' }}>{t('stats.bucketed', { s: Math.round(data.bucketMs / 1000) })}</span>
            )}
          </div>

          {metrics.length === 0 && <div className="panel hint">{t('stats.pickCounter')}</div>}
          {metrics.map((m, i) => {
            const kind = classify(m);
            const pts = kind === 'counter' ? toRate(data?.points || [], i)
              : (data?.points || []).map(p => ({ ts: p.ts, v: [p.v[i]] }));
            return (
              <div key={m} style={{ marginBottom: 12 }}>
                <div className="hint" style={{ fontSize: 12, marginBottom: 2 }}>
                  {m}{kind === 'counter' ? ` · ${t('stats.asRate')}` : ''}
                </div>
                <Plot points={pts} series={[m]} unit={unitFor(m)}
                      height={metrics.length > 2 ? 150 : 220} emptyText={t('stats.noPoints')} />
              </div>
            );
          })}

          {current && (
            <div style={{ marginTop: 10 }}>
              <div className="hint" style={{ marginBottom: 4 }}>{t('stats.metrics')}</div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                {current.metrics.filter(m => classify(m) !== 'ident').map(m => (
                  <button key={m}
                          className={'tagchip' + (metrics.includes(m) ? ' on' : '')}
                          onClick={() => setMetrics(ms => ms.includes(m) ? ms.filter(x => x !== m) : [...ms, m])}>
                    {m}{classify(m) === 'counter' ? ' /s' : ''}
                  </button>
                ))}
                {current.metrics.some(m => classify(m) === 'ident') && (
                  <span className="hint" style={{ fontSize: 11, alignSelf: 'center' }}>
                    {t('stats.identsHidden', { list: current.metrics.filter(m => classify(m) === 'ident').join(', ') })}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
