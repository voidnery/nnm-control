import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { formatValue } from './TimeChart.jsx';
import { layoutPipeline, filterLabel, ioLabel, codecLabel, configuredBitrate } from '../lib/pipelineLayout.js';

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

function Pipeline({ pl, live, kind }) {
  const { t } = useI18n();
  const L = layoutPipeline(pl);
  return (
    <div className="gpipe">
      <div className="gcol">
        <div className="gcol-h">{t('tg.source')}</div>
        {L.inputs.map((i, n) => (
          <Node key={i.id || n} kind="in" title={ioLabel(i)} sub={i.type || ''}
                live={live} path={i.app && i.stream ? `${i.app}/${i.stream}` : null} />
        ))}
        {!L.inputs.length && <div className="hint">—</div>}
      </div>

      <div className="garrow">→</div>

      <div className="gcol wide">
        <div className="gcol-h">{t('tg.processing')}</div>
        {L.pre.map((f, n) => <Node key={n} kind="flt" title={filterLabel(f)} />)}
        {L.split && <Node kind="split" title={filterLabel(L.split)} sub={t('tg.fanOut', { n: L.outputs.length })} />}
        {L.post.length > 0 && (
          <div className="gbranchbox">
            <div className="gbranch-h">{t('tg.perBranch')}</div>
            {L.post.map((f, n) => <Node key={n} kind="flt" title={filterLabel(f)} />)}
            <div className="hint gbranch-note">{t('tg.branchUnknown')}</div>
          </div>
        )}
        {!L.pre.length && !L.split && !L.post.length && <div className="hint">{t('tg.passthrough')}</div>}
      </div>

      <div className="garrow">→</div>

      <div className="gcol">
        <div className="gcol-h">{t('tg.encoders')}</div>
        {L.outputs.map((o, n) => (
          <Node key={o.id || n} kind={kind === 'audio' ? 'out audio' : 'out'}
                title={ioLabel(o)} sub={codecLabel(o)}
                extra={configuredBitrate(o) ? t('tg.configured', { v: configuredBitrate(o) }) : null}
                live={live} path={o.app && o.stream ? `${o.app}/${o.stream}` : null} />
        ))}
        {!L.outputs.length && <div className="hint">—</div>}
      </div>
    </div>
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
      {video.map(pl => <Pipeline key={pl.id} pl={pl} live={data.live} kind="video" />)}
      {audio.length > 0 && <div className="gsection">{t('tg.audio')}</div>}
      {audio.map(pl => <Pipeline key={pl.id} pl={pl} live={data.live} kind="audio" />)}

      {video.length === 0 && audio.length === 0 && (
        <div className="panel hint">{filter ? t('tg.noMatch') : t('tc.noPipelines')}</div>
      )}
    </div>
  );
}
