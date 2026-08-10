import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { formatValue } from './TimeChart.jsx';
import { filterLabel, ioLabel, codecLabel, configuredBitrate } from '../lib/pipelineLayout.js';
import PipelineBoard from './PipelineBoard.jsx';

// A scenario drawn the way it is operated: source -> processing -> encoders,
// with what each endpoint is actually pushing right now. The live figures come
// from the panel's own collector, which is the part WMSPanel's scenario view
// has no equivalent of.

function LiveBadge({ live, path }) {
  const { t } = useI18n();
  const v = path ? live?.[path] : null;
  if (!v) return <span className="gnode-live off" title={t('tg.noData')}>—</span>;
  const stale = Date.now() - new Date(v.ts).getTime() > 60_000;
  if (v.bandwidth == null) return <span className="gnode-live off">—</span>;
  return (
    <span className={'gnode-live' + (stale ? ' stale' : ' on')}
          title={stale ? t('tg.stale', { at: new Date(v.ts).toLocaleTimeString() }) : ''}>
      {formatValue(v.bandwidth, 'bps')}
    </span>
  );
}

function Node({ kind, title, sub, extra, live, path }) {
  return (
    <div className={'gnode ' + kind}>
      <div className="gnode-title mono">{title}</div>
      {sub && <div className="gnode-sub">{sub}</div>}
      {extra && <div className="gnode-sub dim">{extra}</div>}
      {path !== undefined && <LiveBadge live={live} path={path} />}
    </div>
  );
}

function Pipeline({ pl, live, kind, index }) {
  const { t } = useI18n();
  return (
    <PipelineBoard
      pipeline={pl} kind={kind} index={index}
      renderInput={(i, { index: n }) => (
        <Node key={`in${n}:${i.id || ''}`} kind="in" title={ioLabel(i)} sub={i.type || ''}
              live={live} path={i.app && i.stream ? `${i.app}/${i.stream}` : null} />
      )}
      renderFilter={(f, { section, index: n }) => (
        <Node key={`${section}${n}`} kind={section === 'split' ? 'split' : 'flt'}
              title={filterLabel(f)}
              sub={section === 'split' ? t('tg.fanOut', { n: (pl.outputs || []).length }) : null} />
      )}
      renderOutput={(o, { index: n }) => (
        <Node key={`out${n}:${o.id || ''}`} kind={kind === 'audio' ? 'out audio' : 'out'}
              title={ioLabel(o)} sub={codecLabel(o)}
              extra={configuredBitrate(o) ? t('tg.configured', { v: configuredBitrate(o) }) : null}
              live={live} path={o.app && o.stream ? `${o.app}/${o.stream}` : null} />
      )}
    />
  );
}

export default function TranscoderGraph({ transcoderId }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try { setData(await api(`/wmspanel/transcoders/${transcoderId}/graph`)); setError(''); }
    catch (e) { setError(e.message); }
  }, [transcoderId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [live, load]);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="hint">{t('sd.loading')}</div>;

  const match = (pl) => !filter ||
    JSON.stringify([...(pl.inputs || []), ...(pl.outputs || [])]).toLowerCase().includes(filter.toLowerCase());
  const video = (data.video || []).filter(match);
  const audio = (data.audio || []).filter(match);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className={'badge ' + (data.transcoder.paused ? 'warn' : 'ok')}>
            {data.transcoder.paused ? t('tg.paused') : t('tg.running')}
          </span>
          <span className="hint">{data.panelServerName || data.transcoder.serverId}</span>
          <span className="hint">{t('tg.counts', { v: (data.video || []).length, a: (data.audio || []).length })}</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input style={{ maxWidth: 220 }} placeholder={t('tg.filter')} value={filter} onChange={e => setFilter(e.target.value)} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> {t('stats.live')}
          </label>
          <button onClick={load}>{t('action.refresh')}</button>
        </div>
      </div>

      {!data.liveAvailable && (
        <div className="hint" style={{ marginBottom: 8 }}>
          {data.panelServerId ? t('tg.noMetrics') : t('tg.noMapping')}
        </div>
      )}

      {video.length > 0 && <div className="gsection">{t('tg.video')}</div>}
      {video.map((pl, n) => <Pipeline key={`v${n}:${pl.id || ''}`} pl={pl} live={data.live} kind="video" index={n} />)}
      {audio.length > 0 && <div className="gsection">{t('tg.audio')}</div>}
      {audio.map((pl, n) => <Pipeline key={`a${n}:${pl.id || ''}`} pl={pl} live={data.live} kind="audio" index={n} />)}

      {video.length === 0 && audio.length === 0 && (
        <div className="panel hint">{filter ? t('tg.noMatch') : t('tc.noPipelines')}</div>
      )}
    </div>
  );
}
