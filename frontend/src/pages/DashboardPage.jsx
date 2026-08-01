import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Plot from '../components/Plot.jsx';
import Select from '../components/Select.jsx';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';
import { cacheGet, cacheSet, cacheKey } from '../lib/logCache.js';

// iter15 m3 — the dashboard as a wall of charts.
//
// The list it replaces answered "which servers exist", which the Servers page
// answers better. What an operator opens a dashboard for is "is anything wrong
// right now", and a number that has been the same for an hour cannot say that
// — only its shape over time can.
//
// The list was also the navigation, so the card IS the link: its header goes
// to the server and nothing has to be found again.

const METRICS = [
  'cpu_pct', 'cpu_steal_pct', 'cpu_iowait_pct',
  'mem_used_pct', 'swap_used_pct',
  'net_rx_bps', 'net_tx_bps',
];
const I = Object.fromEntries(METRICS.map((m, i) => [m, i]));
const KEY_COLORS = ['#3fb6a8', '#e0a83c', '#7aa7ff', '#e04545', '#9d7ae0', '#4fc36a'];

const RANGES = [
  { key: '15m', mins: 15 }, { key: '1h', mins: 60 },
  { key: '6h', mins: 360 }, { key: '24h', mins: 1440 },
];
const ALL_CHARTS = ['cpu', 'mem', 'net', 'streams'];
// 0 is manual. The floor matches the sampling interval — refreshing faster
// than the agents report only redraws the same points.
const REFRESH = [0, 10, 15, 30, 60, 300];
const STREAM_LIMITS = [3, 6, 12, 24];

// What an operator sees before they have chosen anything. Everything on, an
// hour, two columns: a dashboard whose defaults hide things is one where a
// fault can be missed by someone who never opened the settings.
const DEFAULTS = { charts: ALL_CHARTS, range: '1h', columns: '2', refreshSec: 15, streamLimit: 6 };

const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(0)}%` : '—');
const bps = (v) => {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mb/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} kb/s`;
  return `${v.toFixed(0)} b/s`;
};
const agoText = (iso) => {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};
const isSilent = (s) => Boolean(s.lastContactAt) && Date.now() - new Date(s.lastContactAt).getTime() > 70_000;

const pickSeries = (points, keys) => points.map(p => ({ ts: p.ts, v: keys.map(k => p.v[I[k]]) }));

// iter15 m4 — the streams of one server as ONE chart with several series.
//
// Six charts per card would be seventy-eight more uPlot instances on a page
// that already carries thirty-nine, and it would be the worse picture anyway:
// streams are read against each other — which one dropped while the others
// held — and separate axes make that comparison impossible.
//
// The series arrive on their own timelines, so they are aligned onto the union
// of their timestamps. A stream that was not reporting at a given moment gets
// null there, never 0: a stopped stream and a stream at zero bitrate are
// different events, and drawing them the same way hides the one that matters.
export function alignStreams(streams) {
  const withData = streams.filter(s => s.points?.length);
  if (!withData.length) return { points: [], series: [] };

  const stamps = new Set();
  for (const s of withData) for (const p of s.points) stamps.add(new Date(p.ts).getTime());
  const xs = [...stamps].sort((a, b) => a - b);

  const byStream = withData.map(s => {
    const m = new Map();
    for (const p of s.points) m.set(new Date(p.ts).getTime(), p.v[0]);
    return m;
  });

  return {
    points: xs.map(x => ({
      ts: new Date(x).toISOString(),
      v: byStream.map(m => (m.has(x) ? m.get(x) : null)),
    })),
    series: withData.map(s => s.label),
  };
}

function Big({ label, value, warn }) {
  return (
    <div style={{ minWidth: 66 }}>
      <div className="hint" style={{ fontSize: 11 }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, color: warn ? 'var(--warn)' : 'inherit' }}>{value}</div>
    </div>
  );
}

function ChartRow({ title, points, series, unit }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="hint" style={{ fontSize: 11, marginBottom: 1 }}>
        {title}
        {series.map((s, i) => (
          <span key={`${i}:${s}`} className="chart-key" style={{ color: KEY_COLORS[i % KEY_COLORS.length] }}> ■ {s}</span>
        ))}
      </div>
      <Plot points={points} series={series} unit={unit} height={110} />
    </div>
  );
}

function StreamsSection({ card, t }) {
  const aligned = useMemo(() => alignStreams(card?.streams || []), [card]);
  if (!card) return null;

  if (!card.total) {
    // Nothing publishing is a normal state on a standby box, and saying so is
    // better than an empty chart that looks like a fault.
    return <div className="hint" style={{ marginTop: 8, fontSize: 12 }}>{t('db.noStreams')}</div>;
  }

  const noRate = card.streams.filter(x => !x.metric).length;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="hint" style={{ fontSize: 11, marginBottom: 1 }}>
        {t('db.streamsTitle', { n: card.total })}
        {card.shown < card.total && <> · {t('db.streamsTop', { n: card.shown })}</>}
      </div>
      {aligned.points.length
        ? <Plot points={aligned.points} series={aligned.series} unit="bps" height={120} />
        : <div className="hint" style={{ fontSize: 12 }}>{t('db.streamsNoRate')}</div>}
      <div className="hint" style={{ fontSize: 11, marginTop: 2, wordBreak: 'break-word' }}>
        {aligned.series.map((name, i) => (
          <span key={`${i}:${name}`} style={{ color: KEY_COLORS[i % KEY_COLORS.length], marginRight: 10 }}>■ {name}</span>
        ))}
      </div>
      {/* A stream Nimble reports without any bitrate field still exists; it
          just cannot be plotted, and hiding it would be a lie by omission. */}
      {noRate > 0 && <div className="hint" style={{ fontSize: 11 }}>{t('db.streamsNoMetric', { n: noRate })}</div>}
    </div>
  );
}

// What is left of the WMSPanel daily budget.
//
// Deliberately not a bare number: "11 200 left" is reassuring at 09:00 and
// alarming at 23:00, and only the rate tells them apart. So the bar shows what
// is spent, and the line under it says where the day is heading at the current
// rate — which is the question actually being asked.
function QuotaBox({ q, t }) {
  if (!q) return null;
  const pct = Math.min(100, q.pctUsed);
  // Amber once the projection would overrun; red once it already has.
  const over = q.projected != null && q.projected > q.limit;
  const spent = q.remaining === 0;
  const tone = spent ? 'var(--err, #e04545)' : over ? 'var(--warn)' : 'var(--accent)';
  const hours = Math.floor(q.resetsInMs / 3_600_000);
  const mins = Math.round((q.resetsInMs % 3_600_000) / 60_000);

  return (
    <div className="panel quota" title={q.top.map(x => `${x.path}: ${x.calls}`).join('\n')}
         style={{ padding: '8px 12px', minWidth: 230 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <span className="hint" style={{ fontSize: 11 }}>{t('db.quota')}</span>
        <span className="mono" style={{ fontSize: 15, color: tone }}>
          {new Intl.NumberFormat().format(q.remaining)}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--line)', margin: '5px 0 4px' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: tone, transition: 'width .3s' }} />
      </div>
      <div className="hint" style={{ fontSize: 10.5, lineHeight: 1.35 }}>
        {t('db.quotaUsed', { used: new Intl.NumberFormat().format(q.used), limit: new Intl.NumberFormat().format(q.limit) })}
        {' · '}{t('db.quotaResets', { h: hours, m: mins })}
        {q.projected != null && (
          <div style={{ color: over ? 'var(--warn)' : 'inherit' }}>
            {over
              ? t('db.quotaOver', { n: new Intl.NumberFormat().format(q.projected) })
              : t('db.quotaProjected', { n: new Intl.NumberFormat().format(q.projected) })}
          </div>
        )}
        {/* A floor, not a balance — WMSPanel reports no remaining quota, and
            the account is shared. Better said than assumed. */}
        <div style={{ opacity: .8 }}>{t('db.quotaPanelOnly')}</div>
      </div>
    </div>
  );
}

function ServerCard({ s, streams, t, charts }) {
  const latest = s.latest || [];
  const silent = isSilent(s);
  return (
    <div className="panel" style={{ minWidth: 0 }}>
      {/* The header is the link, so the card keeps the navigation the list
          used to provide. */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Link to={`/servers/${s.id}`} style={{ fontSize: 16, fontWeight: 600 }}>{s.name}</Link>
          <div className="hint mono" style={{ fontSize: 11 }}>{s.host || '—'}</div>
        </div>
        <div className="row" style={{ gap: 8, flexShrink: 0, alignItems: 'baseline' }}>
          {!s.agent
            ? <span className="hint">{t('db.noAgent')}</span>
            : silent
              ? <span className="badge err">{t('db.silent', { ago: agoText(s.lastContactAt) })}</span>
              : <span className="hint">{t('db.seen', { ago: agoText(s.lastContactAt) })}</span>}
        </div>
      </div>

      {/* Current values first: the question is "is anything wrong now", and the
          charts are there to say whether it has been. */}
      <div className="row" style={{ gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
        <Big label="CPU" value={pct(latest[I.cpu_pct])} warn={latest[I.cpu_pct] > 85} />
        <Big label={t('db.mem')} value={pct(latest[I.mem_used_pct])} warn={latest[I.mem_used_pct] > 90} />
        {/* Any swap in use on a streaming box is worth a colour: it means the
            machine has already run out once. */}
        <Big label="SWAP" value={pct(latest[I.swap_used_pct])} warn={latest[I.swap_used_pct] > 5} />
        <Big label={`↓ ${t('db.rx')}`} value={bps(latest[I.net_rx_bps])} />
        <Big label={`↑ ${t('db.tx')}`} value={bps(latest[I.net_tx_bps])} />
      </div>

      {!s.agent ? (
        <div className="hint" style={{ marginTop: 10 }}>
          {t('db.noAgentHint')} <Link to="/agents">{t('nav.agents')}</Link>
        </div>
      ) : !s.points.length ? (
        <div className="hint" style={{ marginTop: 10 }}>{t('db.noSamples')}</div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {charts.includes('cpu') && (
            <ChartRow title={t('db.cpuTitle')}
                      points={pickSeries(s.points, ['cpu_pct', 'cpu_steal_pct', 'cpu_iowait_pct'])}
                      series={[t('db.cpuBusy'), 'steal', 'iowait']} unit="%" />
          )}
          {charts.includes('mem') && (
            <ChartRow title={t('db.memTitle')}
                      points={pickSeries(s.points, ['mem_used_pct', 'swap_used_pct'])}
                      series={[t('db.mem'), 'swap']} unit="%" />
          )}
          {charts.includes('net') && (
            <ChartRow title={t('db.netTitle')}
                      points={pickSeries(s.points, ['net_rx_bps', 'net_tx_bps'])}
                      series={[t('db.rx'), t('db.tx')]} unit="bps" />
          )}
        </div>
      )}

      {charts.includes('streams') && <StreamsSection card={streams} t={t} />}
    </div>
  );
}

// The settings dialog. Kept apart from the toolbar because these are set once
// and then left alone, while the range is reached for constantly — mixing the
// two makes the frequent thing harder to find.
function DashboardSettings({ cfg, onChange, onClose, t }) {
  const toggle = (c) => {
    const next = cfg.charts.includes(c) ? cfg.charts.filter(x => x !== c) : [...cfg.charts, c];
    // Order matters for reading, so it follows the canonical list rather than
    // the order the boxes happened to be ticked in.
    onChange({ charts: ALL_CHARTS.filter(x => next.includes(x)) });
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{t('db.settings')}</h3>

      <label>{t('db.whichCharts')}</label>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {ALL_CHARTS.map(c => (
          <label key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={cfg.charts.includes(c)} onChange={() => toggle(c)} />
            {t(`db.chart.${c}`)}
          </label>
        ))}
      </div>
      {cfg.charts.length === 0 && (
        <div className="hint" style={{ color: 'var(--warn)' }}>{t('db.noChartsWarn')}</div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <div>
          <label>{t('db.range')}</label>
          <Select value={cfg.range} onChange={v => onChange({ range: v })}
                  options={RANGES.map(r => ({ value: r.key, label: t(`logs.range.${r.key}`) }))} />
        </div>
        <div>
          <label>{t('db.columns')}</label>
          <Select value={cfg.columns} onChange={v => onChange({ columns: v })}
                  options={['1', '2', '3'].map(n => ({ value: n, label: n }))} />
        </div>
        <div>
          <label>{t('db.refresh')}</label>
          <Select value={String(cfg.refreshSec)} onChange={v => onChange({ refreshSec: Number(v) })}
                  options={REFRESH.map(n => ({ value: String(n), label: n ? `${n}s` : t('db.manual') }))} />
          <div className="hint">{t('db.refreshHint')}</div>
        </div>
        <div>
          <label>{t('db.streamLimit')}</label>
          <Select value={String(cfg.streamLimit)} onChange={v => onChange({ streamLimit: Number(v) })}
                  options={STREAM_LIMITS.map(n => ({ value: String(n), label: String(n) }))} />
          <div className="hint">{t('db.streamLimitHint')}</div>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
        <button onClick={() => onChange({ ...DEFAULTS })}>{t('db.reset')}</button>
        <button className="primary" onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}

export default function DashboardPage() {
  const { t } = useI18n();
  const { user, refreshUser } = useAuth();

  // Saved on the account, so a wall display and a laptop can be set up
  // differently and neither loses its layout on reload — which the in-memory
  // filters used until now did.
  // What the operator just chose, before the server has confirmed it.
  //
  // The range is reached for constantly, and making it wait on a PUT and then
  // a GET meant the dropdown appeared not to respond — and did nothing at all
  // if either call failed. The choice applies now; persistence catches up, and
  // a failed save reverts it rather than leaving the screen disagreeing with
  // the account.
  const [pending, setPending] = useState(null);

  const saved = useMemo(() => {
    const s = user?.preferences?.dashboard || {};
    return {
      ...DEFAULTS,
      ...s,
      charts: Array.isArray(s.charts) ? ALL_CHARTS.filter(c => s.charts.includes(c)) : DEFAULTS.charts,
    };
  }, [user]);
  const cfg = useMemo(() => ({ ...saved, ...(pending || {}) }), [saved, pending]);

  const [settings, setSettings] = useState(false);
  const [quota, setQuota] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const patch = useCallback(async (next) => {
    const optimistic = { ...(pending || {}), ...next };
    setPending(optimistic);
    try {
      await api('/auth/me/preferences', { method: 'PUT', body: { dashboard: { ...saved, ...optimistic } } });
      await refreshUser();
      // Cleared only once the account agrees, so the two cannot disagree.
      setPending(null);
      setError('');
    } catch (e) {
      setPending(null);
      setError(e.message);
    }
  }, [saved, pending, refreshUser]);

  const load = useCallback(async () => {
    const mins = RANGES.find(r => r.key === cfg.range)?.mins || 60;
    // The same treatment as the log views: whatever was last seen goes up in
    // the first frame while the query runs behind it, so coming back to the
    // dashboard is never a blank wall.
    const hit = cacheGet(cacheKey('dash', { range: cfg.range, limit: cfg.streamLimit }));
    if (hit) setData(hit.data);
    setBusy(true);
    try {
      // Two requests, not two per card: the fleet answers both questions in
      // one pass each.
      const [d, st, q] = await Promise.all([
        api(`/stats/host?minutes=${mins}&metrics=${METRICS.join(',')}`),
        api(`/stats/streams?minutes=${mins}&limit=${cfg.streamLimit}`).catch(() => null),
        // Never allowed to break the dashboard: it is a readout, not the point
        // of the page.
        api('/stats/api-quota').catch(() => null),
      ]);
      setQuota(q && q.enabled !== false ? q : null);
      const merged = { ...d, streamsByServer: Object.fromEntries((st?.servers || []).map(x => [x.id, x])) };
      setData(merged);
      cacheSet(cacheKey('dash', { range: cfg.range, limit: cfg.streamLimit }), merged);
      setError('');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, [cfg.range, cfg.streamLimit]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    // 0 means the operator asked for manual: honour it rather than picking a
    // default they did not choose.
    if (cfg.refreshSec > 0) timer.current = setInterval(load, cfg.refreshSec * 1000);
    return () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  }, [load, cfg.refreshSec]);

  const servers = data?.servers || [];
  const summary = useMemo(() => {
    const withAgent = servers.filter(s => s.agent);
    return {
      reporting: withAgent.filter(s => s.points.length && !isSilent(s)).length,
      silent: withAgent.filter(isSilent).length,
      noAgent: servers.length - withAgent.length,
    };
  }, [servers]);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>{t('page.dashboard.title')}</h1>
          <div className="sub">{t('db.sub')}</div>
        </div>
        <div className="row" style={{ gap: 16, flexShrink: 0 }}>
          <QuotaBox q={quota} t={t} />
          {/* The range is reached for constantly, so it stays in the toolbar;
              everything set once and left alone is behind the button. */}
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className="hint">{t('db.range')}</span>
            <Select value={cfg.range} onChange={v => patch({ range: v })} style={{ width: 130 }}
                    options={RANGES.map(r => ({ value: r.key, label: t(`logs.range.${r.key}`) }))} />
          </div>
          <button onClick={() => setSettings(true)}>{t('db.settings')}</button>
          <button onClick={load} disabled={busy}>{busy ? '…' : t('action.refresh')}</button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {data && (
        <div className="row" style={{ gap: 10, margin: '10px 0', flexWrap: 'wrap' }}>
          <span className="badge live">{t('db.sReporting', { n: summary.reporting })}</span>
          {summary.silent > 0 && <span className="badge err">{t('db.sSilent', { n: summary.silent })}</span>}
          {summary.noAgent > 0 && <span className="hint">{t('db.sNoAgent', { n: summary.noAgent })}</span>}
        </div>
      )}

      {data && servers.length === 0 && (
        <div className="panel">{t('db.noServers')} <Link to="/servers">{t('db.servers')}</Link></div>
      )}

      {/* Generous by default. A chart squeezed into a third of a narrow window
          says nothing, so the grid falls back to fewer columns rather than
          shrinking past the point of being readable. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(${cfg.columns === '1' ? 640 : cfg.columns === '2' ? 460 : 360}px, 1fr))`,
        gap: 12,
      }}>
        {servers.map(s => (
          <ServerCard key={s.id} s={s} streams={data?.streamsByServer?.[s.id] || null}
                      t={t} charts={cfg.charts} />
        ))}
      </div>

      {settings && (
        <DashboardSettings cfg={cfg} onChange={patch} onClose={() => setSettings(false)} t={t} />
      )}
    </div>
  );
}
