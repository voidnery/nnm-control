import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Select from '../components/Select.jsx';
import SearchInput from '../components/SearchInput.jsx';
import TimeChart from '../components/TimeChart.jsx';

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
const unitFor = (m) => (isRate(m) ? 'bps' : classify(m) === 'counter' ? '/s' : '');

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

  const shown = (subjects || []).filter(s =>
    !filter || `${s.label} ${s.subject}`.toLowerCase().includes(filter.toLowerCase()));
  const grouped = GROUP_ORDER
    .map(g => ({ g, items: shown.filter(s => s.group === g) }))
    .filter(x => x.items.length);


  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        {subjects && subjects.length === 0
          ? <span className="hint">{t('stats.none')}</span>
          : <span />}
        <button className="linklike" onClick={() => { setShowHealth(v => !v); loadHealth(); }}>
          {showHealth ? t('stats.hideHealth') : t('stats.showHealth')}
        </button>
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
                  <>
                    <div className="kv-k" key={ep + 'k'}>{ep}</div>
                    <div className="kv-v" key={ep + 'v'}>
                      {r.status === 'ok' && <span><span className="lamp on" />{t('stats.hOk', { n: r.count })}</span>}
                      {r.status === 'empty' && <span className="hint">— {r.hint}</span>}
                      {r.status === 'error' && <span><span className="lamp off" />{r.error}</span>}
                    </div>
                  </>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>{t('stats.healthHint')}</div>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
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
                <TimeChart points={pts} series={[m]} unit={unitFor(m)}
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
