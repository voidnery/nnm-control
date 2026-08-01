import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import Modal, { backdropClose } from '../components/Modal.jsx';
import Plot from '../components/Plot.jsx';
import { Link } from 'react-router-dom';
import Select from '../components/Select.jsx';
import SrtHelper from '../components/SrtHelper.jsx';
import { useConfirm } from '../confirm.jsx';
import { useStreamTags, TagFilterBar, TagChips } from '../components/StreamTags.jsx';
import { useStreamCopy, CopyCheckbox, CopySelectionBar, CopyModal } from '../components/StreamCopy.jsx';
import { PlaybackModal, usePlaybackEndpoints } from '../components/StreamPlayback.jsx';
import SearchInput from '../components/SearchInput.jsx';

// WMSPanel stream-object tabs (canonical schemas pinned from the live dump):
// - UDP/SRT outputs: source_streams[{application, stream, pmt/video/audio pid}]
// - MPEGTS outgoing: application/stream + native delivery status ('synced')
// - Hot swap: original/substitute pairs + emergency toggle
// Manual edits here are direct PUTs; WMSPanel delivers them to Nimble on its
// ~30s sync cycle — use Refresh to observe.

function useObjects(serverId, kind) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try { setData(await api(`/wmspanel/server/${serverId}/${kind}`)); }
    catch (e) { setError(e.message); setData({}); }
  };
  useEffect(() => { load(); }, [serverId]);
  return { data, error, setError, load };
}

const SyncNote = () => (
  <div className="hint" style={{ marginBottom: 10 }}>
    Changes are delivered to the Nimble instance on WMSPanel's ~30s sync cycle — hit Refresh to observe.
  </div>
);

// ---------------------------------------------------------------- UDP / SRT
// iter16 m1 — live values for objects WMSPanel configured.
//
// The panel has been polling Nimble's native stats for its charts all along;
// what was missing was the pairing, and the columns for it were already drawn
// and always empty. The join happens server-side, so a row here just reads a
// number.
//
// Failing to match is reported rather than rendered as dashes: an unmatched
// object and an offline stream look identical in a table, and only one of them
// is a problem with the panel.
function useLive(serverId, kind, deps = []) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!serverId) return undefined;
    let dead = false;
    // Swallowing the error left the table with neither values nor a reason —
    // which is how a 409 from the control-plane guard looked like "this stream
    // is offline" for a whole release.
    const tick = () => api(`/nimble/${serverId}/live-objects/${kind}`)
      .then(d => { if (!dead) setLive(d); })
      .catch(e => { if (!dead) setLive({ available: false, reason: e.message }); });
    tick();
    // Nimble's own numbers move in seconds; slower than that and the column is
    // a memory rather than a reading.
    const id = setInterval(tick, 10_000);
    return () => { dead = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, kind, ...deps]);
  return live;
}

const fmtBps = (v) => {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mb/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} kb/s`;
  return `${v.toFixed(0)} b/s`;
};

// iter16 m2 — one stream's history.
//
// The series has been accumulating since iter9; what it lacked was a way in
// from the row that raises the question. The subject is `srt-receiver:<id>`
// where the id is now `setting_id`, which is the same id the row already has.
function StreamHistory({ serverId, objectId, name, kind, onClose }) {
  const { t } = useI18n();
  const [range, setRange] = useState('1h');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const subject = `${kind === 'outgoing' ? 'srt-sender' : 'srt-receiver'}:${objectId}`;
  // Rate, link quality and reconnects: the three questions asked of a feed
  // that misbehaved, and they answer different ones. Loss without RTT reads as
  // a bad source; RTT without loss reads as a slow path.
  const METRICS = ['stats.recv.mbpsRate', 'stats.send.mbpsRate', 'stats.link.rtt', 'retryCount'];

  useEffect(() => {
    let dead = false;
    const mins = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440 }[range] || 60;
    api(`/stats/${serverId}/series?subject=${encodeURIComponent(subject)}&metrics=${METRICS.join(',')}&minutes=${mins}`)
      .then(d => { if (!dead) { setData(d); setError(''); } })
      .catch(e => { if (!dead) setError(e.message); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, subject, range]);

  const points = data?.points || [];
  // Nimble reports the rate under recv for a receiver and send for a sender;
  // whichever is absent is null all the way down, so they collapse into one
  // line without the caller having to know which direction this stream is.
  const rate = points.map(p => ({ ts: p.ts, v: [p.v[0] ?? p.v[1]] }));
  const link = points.map(p => ({ ts: p.ts, v: [p.v[2]] }));
  const retries = points.map(p => ({ ts: p.ts, v: [p.v[3]] }));

  return (
    <Modal onClose={onClose} size="wide">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{name}</h3>
        <div className="row pair" style={{ gap: 6, flexShrink: 0 }}>
          <span className="hint">{t('db.range')}</span>
          <Select value={range} onChange={setRange} style={{ width: 130 }}
                  options={['15m', '1h', '6h', '24h'].map(k => ({ value: k, label: t(`logs.range.${k}`) }))} />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!error && points.length === 0 && (() => {
        // Four different reasons, and they need four different actions. The
        // panel knows which one applies, so it says that rather than listing
        // possibilities for the operator to work through.
        const c = data?.collection;
        if (!c) return <div className="hint" style={{ marginTop: 10 }}>{t('wo.noHistory')}</div>;
        if (!c.enabled) {
          return (
            <div className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
              {t('wo.histOff')} <Link to="/settings">{t('nav.settings')}</Link>
            </div>
          );
        }
        if (!c.serverLastSampleAt) {
          // Collection is on and this server has produced nothing at all —
          // that is the server or its native API, not this stream.
          return <div className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>{t('wo.histNoServer')}</div>;
        }
        if (!c.subjectLastSampleAt) {
          return <div className="hint" style={{ marginTop: 10 }}>{t('wo.histNeverSeen')}</div>;
        }
        // It has reported, just not inside the window asked for.
        return (
          <div className="hint" style={{ marginTop: 10 }}>
            {t('wo.histOutside', { when: new Date(c.subjectLastSampleAt).toLocaleString() })}
          </div>
        );
      })()}

      {points.length > 0 && (
        <>
          <div className="hint" style={{ fontSize: 11, marginTop: 8 }}>{t('wo.histRate')}</div>
          <Plot points={rate} series={[t('wo.histRate')]} unit="Mbps" height={140} />
          <div className="hint" style={{ fontSize: 11, marginTop: 8 }}>{t('wo.histRtt')}</div>
          <Plot points={link} series={['RTT']} unit="ms" height={110} />
          {/* A counter, not a rate: it only ever climbs, and the shape of the
              climb is the point — a straight run means a link dropping
              steadily, a step means one bad minute. */}
          <div className="hint" style={{ fontSize: 11, marginTop: 8 }}>{t('wo.histRetries')}</div>
          <Plot points={retries} series={[t('wo.histRetries')]} unit="" height={100} />
          <div className="hint" style={{ marginTop: 6 }}>
            {t('wo.histNote', { n: points.length, bucket: data.bucketMs ? Math.round(data.bucketMs / 1000) : 0 })}
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}

// Shown once above a table when the join found nothing: the field names differ
// between Nimble builds and were never documented, so the evidence goes on
// screen instead of into a guess.
function JoinNote({ live, t }) {
  if (!live) return null;
  if (live.available === false) {
    return <div className="hint" style={{ marginBottom: 6 }}>{t('wo.liveUnavailable', { why: live.reason || '' })}</div>;
  }
  // A partial match used to say nothing at all, leaving every unmatched row
  // marked "wp" with no explanation anywhere.
  if (!live.objects || !live.unmatched) return null;
  const d = live.diagnostics || {};
  // Nothing at all came back is a different fault from "came back and did not
  // line up", and only the first one is answered by the shape of the response.
  const empty = live.entries === 0;
  return (
    <div className="hint" style={{ marginBottom: 6, color: 'var(--warn)' }}>
      {empty
        ? t('wo.liveEmpty', { objects: live.objects, endpoint: d.endpoint || '' })
        : (live.matched === 0 && live.portOverlap === 0)
          // Not a failure to match: nothing here was ever the same stream.
          ? t('wo.liveElsewhere', { entries: live.entries })
        : live.matched > 0
          ? t('wo.livePartial', { matched: live.matched, unmatched: live.unmatched })
          : t('wo.liveNoMatch', { entries: live.entries, objects: live.objects })}
      {(d.responseShape || d.sampleEntries?.length > 0) && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer' }}>{t('wo.liveShape')}</summary>
          {/* On screen rather than in a tooltip: a tooltip cannot be copied,
              and this is the thing worth sending on. */}
          <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
            {JSON.stringify(d.responseShape || {
              // Ports first: when these two lists do not overlap, the two
              // sides are describing different streams, and no key would ever
              // have joined them.
              nimblePorts: d.nimblePorts, wmspanelPorts: d.wmspanelPorts,
              nimble: d.sampleEntryIds, wmspanel: d.sampleObjectIds,
            }, null, 1)}
          </pre>
        </details>
      )}
    </div>
  );
}

export function UdpTab({ serverId }) {
  const live = useLive(serverId, 'udp');
  const [history, setHistory] = useState(null);
  const st = useStreamTags(serverId, 'udp');
  const cp = useStreamCopy(serverId, 'udp');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can, sys } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'udp');
  const [incoming, setIncoming] = useState([]);
  const [edit, setEdit] = useState(null); // { id, name, mode: 'incoming'|'streams', source_id, sources: [...] }
  const [busy, setBusy] = useState(false);
  const settings = data?.settings || [];

  useEffect(() => {
    // source_id values reference MPEGTS incoming streams — resolve to names
    api(`/wmspanel/server/${serverId}/incoming`).then(d => setIncoming(d.streams || [])).catch(() => setIncoming([]));
  }, [serverId]);
  const incomingName = (id) => incoming.find(x => String(x.id) === String(id))?.name || String(id || '').slice(-6);

  const openEdit = (o) => setEdit({
    id: o.id, name: o.name || o.id,
    mode: o.source_id ? 'incoming' : 'streams',
    source_id: o.source_id || '',
    sources: (o.source_streams || []).map(ss => ({ ...ss })),
  });

  const [cfgModal, setCfgModal] = useState(null); // create or settings-edit
  const openCfg = (o) => setCfgModal(o ? {
    id: o.id, name: o.name || '', description: o.description || '',
    protocol: o.protocol || 'srt', ip: o.ip || '', port: o.port || 10000,
    ttl: o.ttl ?? 1,
    parameters: Object.keys(o.parameters || {}).length ? JSON.stringify(o.parameters) : '',
  } : { name: '', description: '', protocol: 'srt', ip: '0.0.0.0', port: 10000, ttl: 1, parameters: '' });
  const saveCfg = async () => {
    setBusy(true); setError('');
    const body = {
      name: cfgModal.name, description: cfgModal.description,
      protocol: cfgModal.protocol, ip: cfgModal.ip, port: Number(cfgModal.port), ttl: Number(cfgModal.ttl),
    };
    try {
      if (cfgModal.parameters?.trim()) body.parameters = JSON.parse(cfgModal.parameters);
      if (cfgModal.id) await api(`/wmspanel/server/${serverId}/udp/${cfgModal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/udp`, { method: 'POST', body });
      setCfgModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const removeUdp = async (o) => {
    if (!(await confirm(t('wo.confirmDeleteUdp', { name: o.name || o.id, addr: `${o.ip}:${o.port}` })))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/udp/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      // Two source modes (from live data: 604/755 outputs use source_id -> an
      // MPEGTS incoming stream; 151 use source_streams app/stream entries).
      // We send ONLY the chosen mode's field. Existing entries keep their
      // PIDs; newly added ones get PIDs assigned by WMSPanel.
      const body = edit.mode === 'incoming'
        ? { source_id: edit.source_id }
        : { source_streams: edit.sources.filter(x => x.application && x.stream) };
      await api(`/wmspanel/server/${serverId}/udp/${edit.id}`, { method: 'PUT', body });
      setEdit(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const togglePause = async (o) => {
    setBusy(true); setError('');
    try {
      await api(`/wmspanel/server/${serverId}/udp/${o.id}`, { method: 'PUT', body: { paused: !o.paused } });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <SyncNote />
      {sys?.srtHelperEnabled && <SrtHelper />}
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && <button className="primary" disabled={busy} onClick={() => openCfg(null)}>+ {t('new.output')}</button>}
      </div>
      <TagFilterBar st={st} />
      <CopySelectionBar cp={cp} visibleIds={settings.filter(o => st.matches('udp', o.id)).map(o => o.id)} />
      <div className="panel">
        <JoinNote live={live} t={t} />
        <table>
          <thead><tr><th></th><th>{t('wo.name')}</th><th>{t('wo.proto')}</th><th>{t('wo.destination')}</th><th>{t('wo.source')}</th><th>{t('wo.bitrate')}</th><th>{t('wo.state')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {settings.filter(o => st.matches('udp', o.id)).map(o => (
              <tr key={o.id}>
                <td><CopyCheckbox cp={cp} id={o.id} /></td>
                <td><b>{o.name || String(o.id).slice(-6)}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td><span className="badge">{o.protocol}</span></td>
                <td className="mono">{o.ip}:{o.port}</td>
                <td className="mono">
                  {o.source_id
                    ? <><span className="badge" style={{ marginRight: 4 }}>in</span>{incomingName(o.source_id)}</>
                    : (o.source_streams || []).length
                      ? (o.source_streams || []).map((ss, i) => <div key={i}>{ss.application}/{ss.stream}</div>)
                      : <span className="hint">— no source —</span>}
                </td>
                {/* `paused` is the configured intent; the rate is what the
                    socket is actually doing, and the two disagree often
                    enough to be worth both. */}
                <td className="mono">
                  {live?.live?.[o.id]
                    ? (live.live[o.id].idle
                      ? <span style={{ color: 'var(--warn)' }} title={t('wo.idleHint')}>{fmtBps(live.live[o.id].bps)}</span>
                      : fmtBps(live.live[o.id].bps))
                    : <span className="hint">—</span>}
                </td>
                <td>
                  <span className={'lamp ' + (o.paused ? 'off' : live?.live?.[o.id]?.idle ? 'warn' : 'on')} />
                  {o.paused ? 'paused' : live?.live?.[o.id]?.idle ? t('wo.idle') : 'active'}
                  {/* Several sockets on one setting means several clients
                      pulling it — a number WMSPanel shows and we did not. */}
                  {live?.live?.[o.id]?.clients > 1 && (
                    <span className="hint" style={{ marginLeft: 6 }}>{t('wo.clients', { n: live.live[o.id].clients })}</span>
                  )}
                  {live?.live?.[o.id]?.rtt != null && (
                    <span className="hint" style={{ marginLeft: 6 }}
                          title={live.live[o.id].clients > 1 ? t('wo.worstOf') : ''}>
                      RTT {live.live[o.id].rtt.toFixed(0)}ms
                    </span>
                  )}
                </td>
                <td><TagChips st={st} kind="udp" objId={o.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setHistory({ id: o.id, name: o.name })}>{t('wo.history')}</button>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => openEdit(o)}>{t('wo.editSourceBtn')}</button>{' '}
                    <button disabled={busy} onClick={() => openCfg(o)}>{t('wo.settingsBtn')}</button>{' '}
                    <button disabled={busy} onClick={() => togglePause(o)}>{o.paused ? 'Resume' : 'Pause'}</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => removeUdp(o)}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={8} className="hint">{t('wo.emptyUdp')}</td></tr>}
          </tbody>
        </table>

      </div>
      {cfgModal && (
        <div className="modal-back" {...backdropClose(() => setCfgModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{cfgModal.id ? `Settings of ${cfgModal.name}` : 'New SRT/UDP output'}</h3>
            <label>{t('wo.name')}</label>
            <input value={cfgModal.name} onChange={e => setCfgModal(m => ({ ...m, name: e.target.value }))} />
            <label>{t('wo.description')}</label>
            <input value={cfgModal.description} onChange={e => setCfgModal(m => ({ ...m, description: e.target.value }))} />
            <div className="field-inline">
              <div>
                <label>{t('wo.protocol')}</label>
                <Select value={cfgModal.protocol} onChange={v => setCfgModal(m => ({ ...m, protocol: v }))}
                        options={['srt', 'udp', 'rist'].map(x => ({ value: x, label: x }))} />
              </div>
              <div><label>TTL</label><input type="number" value={cfgModal.ttl} onChange={e => setCfgModal(m => ({ ...m, ttl: e.target.value }))} /></div>
            </div>
            <div className="field-inline">
              <div><label>IP</label><input className="mono" value={cfgModal.ip} onChange={e => setCfgModal(m => ({ ...m, ip: e.target.value }))} /></div>
              <div><label>{t('wo.port')}</label><input type="number" value={cfgModal.port} onChange={e => setCfgModal(m => ({ ...m, port: e.target.value }))} /></div>
            </div>
            <label>Parameters (JSON, e.g. {'{"latency":"1000","maxbw":"0"}'})</label>
            <input className="mono" value={cfgModal.parameters} onChange={e => setCfgModal(m => ({ ...m, parameters: e.target.value }))} />
            {!cfgModal.id && <div className="hint" style={{ marginTop: 6 }}>{t('wo.sourceAfterCreate')}</div>}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setCfgModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !cfgModal.name || !cfgModal.ip || !cfgModal.port} onClick={saveCfg}>
                {cfgModal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      {edit && (
        <div className="modal-back" {...backdropClose(() => setEdit(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Source of {edit.name}</h3>
            <label className={'radio-card' + (edit.mode === 'incoming' ? ' on' : '')} style={{ marginTop: 4 }}>
              <input type="radio" name="udpSourceMode" checked={edit.mode === 'incoming'}
                     onChange={() => setEdit(m => ({ ...m, mode: 'incoming' }))} />
              <span className="radio-card-body">
                <span className="radio-card-title">{t('wo.modeIncoming')}</span>
                <span className="radio-card-desc">{t('wo.modeIncomingDesc')}</span>
              </span>
            </label>
            {edit.mode === 'incoming' && (
              <Select value={edit.source_id} onChange={v => setEdit(m => ({ ...m, source_id: v }))} searchable
                      options={[{ value: '', label: '— select incoming stream —' }, ...incoming.map(x => ({ value: x.id, label: `${x.name} (${x.protocol}, ${x.status})` }))]} />
            )}
            <label className={'radio-card' + (edit.mode === 'streams' ? ' on' : '')} style={{ marginTop: 8 }}>
              <input type="radio" name="udpSourceMode" checked={edit.mode === 'streams'}
                     onChange={() => setEdit(m => ({ ...m, mode: 'streams' }))} />
              <span className="radio-card-body">
                <span className="radio-card-title">{t('wo.modeStreams')}</span>
                <span className="radio-card-desc">{t('wo.modeStreamsDesc')}</span>
              </span>
            </label>
            {edit.mode === 'streams' && (
              <>
                {edit.sources.map((ss, i) => (
                  <div key={i} className="panel" style={{ padding: 10 }}>
                    <div className="row">
                      <input placeholder="application" value={ss.application || ''} onChange={e =>
                        setEdit(m => ({ ...m, sources: m.sources.map((x, j) => j === i ? { ...x, application: e.target.value } : x) }))} />
                      <input placeholder="stream" value={ss.stream || ''} onChange={e =>
                        setEdit(m => ({ ...m, sources: m.sources.map((x, j) => j === i ? { ...x, stream: e.target.value } : x) }))} />
                      <button onClick={() => setEdit(m => ({ ...m, sources: m.sources.filter((_, j) => j !== i) }))}>×</button>
                    </div>
                    <div className="hint mono">
                      PIDs: {ss.pmt_pid !== undefined ? `pmt=${ss.pmt_pid} video=${ss.video_pid} audio=${ss.audio_pid} (preserved)` : 'assigned by WMSPanel on create'}
                    </div>
                  </div>
                ))}
                <button onClick={() => setEdit(m => ({ ...m, sources: [...m.sources, { application: '', stream: '' }] }))}>+ add entry</button>
              </>
            )}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEdit(null)}>{t('action.cancel')}</button>
              <button className="primary" onClick={save}
                      disabled={busy || (edit.mode === 'incoming' ? !edit.source_id : edit.sources.filter(x => x.application && x.stream).length === 0)}>{t('action.apply')}</button>
            </div>
          </div>
        </div>
      )}
      <CopyModal cp={cp} currentServerId={serverId} />
      {history && (
        <StreamHistory serverId={serverId} objectId={history.id} name={history.name}
                       kind="outgoing" onClose={() => setHistory(null)} />
      )}
    </div>
  );
}

// ----------------------------------------------------------------- Outgoing
export function OutgoingTab({ serverId }) {
  const st = useStreamTags(serverId, 'outgoing');
  const cp = useStreamCopy(serverId, 'outgoing');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'outgoing');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // create/edit
  const [incoming, setIncoming] = useState([]);
  const streams = data?.streams || [];

  useEffect(() => {
    // source picker options (id -> name) for video/audio sources
    api(`/wmspanel/server/${serverId}/incoming`).then(d => setIncoming(d.streams || [])).catch(() => setIncoming([]));
  }, [serverId]);

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      application: modal.application, stream: modal.stream,
      description: modal.description || '',
    };
    if (modal.video_source) body.video_source = { id: modal.video_source };
    if (modal.audio_source) body.audio_source = { id: modal.audio_source };
    try {
      if (modal.id) await api(`/wmspanel/server/${serverId}/outgoing/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/outgoing`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (o) => {
    if (!(await confirm(t('wo.confirmDeleteOutgoing', { s: `${o.application}/${o.stream}` })))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/outgoing/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const srcName = (ref) => {
    if (!ref?.id) return '';
    const src = incoming.find(x => String(x.id) === String(ref.id));
    return src ? src.name : String(ref.id).slice(-6);
  };

  const act = async (o, action) => {
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/outgoing/${o.id}/${action}`, { method: 'POST' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ application: '', stream: '', description: '', video_source: '', audio_source: '' })}>
            + {t('new.outgoing')}
          </button>
        )}
      </div>
      <TagFilterBar st={st} />
      <CopySelectionBar cp={cp} visibleIds={streams.filter(o => st.matches('outgoing', o.id)).map(o => o.id)} />
      <div className="panel">
        <table>
          <thead><tr><th></th><th>{t('wo.output')}</th><th>{t('wo.delivery')}</th><th>{t('wo.state')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {streams.filter(o => st.matches('outgoing', o.id)).map(o => (
              <tr key={o.id}>
                <td><CopyCheckbox cp={cp} id={o.id} /></td>
                <td className="mono"><b>{o.application}/{o.stream}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td>
                  <span className={'lamp ' + (o.status === 'synced' ? 'on' : 'warn')} />
                  {o.status || '—'}
                  <div className="hint">src: {srcName(o.video_source) || '—'}{o.audio_source?.id && o.audio_source.id !== o.video_source?.id ? ' / ' + srcName(o.audio_source) : ''}</div>
                </td>
                <td>{String(o.paused) === 'true' ? 'paused' : 'active'}</td>
                <td><TagChips st={st} kind="outgoing" objId={o.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    {String(o.paused) === 'true'
                      ? <button disabled={busy} onClick={() => act(o, 'resume')}>{t('action.resume')}</button>
                      : <button disabled={busy} onClick={() => act(o, 'pause')}>{t('action.pause')}</button>}{' '}
                    <button disabled={busy} onClick={() => act(o, 'restart')}>{t('action.restart')}</button>{' '}
                    <button disabled={busy} onClick={() => setModal({
                      id: o.id, application: o.application, stream: o.stream,
                      description: o.description || '',
                      video_source: o.video_source?.id || '', audio_source: o.audio_source?.id || '',
                    })}>{t('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(o)}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {streams.length === 0 && <tr><td colSpan={6} className="hint">{t('wo.emptyOutgoing')}</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.application}/${modal.stream}` : 'New outgoing stream'}</h3>
            <div className="field-inline">
              <div><label>{t('wo.application')}</label><input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} /></div>
              <div><label>{t('wo.stream')}</label><input value={modal.stream} onChange={e => setModal(m => ({ ...m, stream: e.target.value }))} /></div>
            </div>
            <label>{t('wo.description')}</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <label>{t('wo.videoSource')}</label>
            <Select value={modal.video_source} onChange={v => setModal(m => ({ ...m, video_source: v }))} searchable
                    options={[{ value: '', label: '— keep / none —' }, ...incoming.map(x => ({ value: x.id, label: `${x.name} (${x.status})` }))]} />
            <label>{t('wo.audioSource')}</label>
            <Select value={modal.audio_source} onChange={v => setModal(m => ({ ...m, audio_source: v }))} searchable
                    options={[{ value: '', label: '— same as video / none —' }, ...incoming.map(x => ({ value: x.id, label: `${x.name} (${x.status})` }))]} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !modal.application || !modal.stream} onClick={save}>
                {modal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      <CopyModal cp={cp} currentServerId={serverId} />
    </div>
  );
}

// ------------------------------------------------------------------ Hotswap
export function HotswapTab({ serverId }) {
  const tg = useStreamTags(serverId, 'hotswap');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'hotswap');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [form, setForm] = useState({ original_app: '', original_stream: '', substitute_app: '', substitute_stream: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const settings = data?.settings || [];

  const put = async (o, patch) => {
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/hotswap/${o.id}`, { method: 'PUT', body: patch }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setError('');
    try {
      await api(`/wmspanel/server/${serverId}/hotswap`, { method: 'POST', body: { ...form, emergency: false, paused: false } });
      setCreating(false);
      setForm({ original_app: '', original_stream: '', substitute_app: '', substitute_stream: '' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (o) => {
    if (!(await confirm(t('wo.confirmDeleteHotswap', { s: `${o.original_app}/${o.original_stream}` })))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/hotswap/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Hot swap = картинка-подмена на стороне Nimble: при включённом <b>EMERGENCY</b> viewers получают
        substitute-поток вместо оригинала; выключение возвращает оригинал. Правила и выходы не трогаются.
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && <button className="primary" onClick={() => setCreating(true)}>+ {t('hotswap.new')}</button>}
      </div>
      <TagFilterBar st={tg} />
      <div className="panel">
        <table>
          <thead><tr><th>{t('wo.original')}</th><th>{t('wo.substitute')}</th><th>{t('wo.emergency')}</th><th>{t('wo.state')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {settings.map(o => (
              <tr key={o.id} style={o.emergency ? { background: '#2a1416' } : undefined}>
                <td className="mono"><b>{o.original_app}/{o.original_stream}</b></td>
                <td className="mono">{o.substitute_app}/{o.substitute_stream}</td>
                <td>
                  <span className={'lamp ' + (o.emergency ? 'off' : 'on')} />
                  {o.emergency ? t('wo.emergencyOn') : t('wo.original')}
                </td>
                <td>{o.paused ? 'paused' : 'armed'}</td>
                <td><TagChips st={tg} kind="hotswap" objId={o.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button className={o.emergency ? 'primary' : 'danger'} disabled={busy}
                            onClick={() => put(o, { emergency: !o.emergency })}>
                      {o.emergency ? t('wo.backToOriginal') : t('wo.emergencyOnBtn')}
                    </button>{' '}
                    <button disabled={busy} onClick={() => setEditModal({
                      id: o.id, original_app: o.original_app, original_stream: o.original_stream,
                      substitute_app: o.substitute_app, substitute_stream: o.substitute_stream,
                      paused: Boolean(o.paused),
                    })}>{t('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(o)}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={6} className="hint">{t('wo.emptyHotswap')}</td></tr>}
          </tbody>
        </table>

      </div>
      {creating && (
        <div className="modal-back" {...backdropClose(() => setCreating(false))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{t('hotswap.newTitle')}</h3>
            <div className="field-inline">
              <div><label>{t('hotswap.originalApp')}</label><input value={form.original_app} onChange={e => set('original_app', e.target.value)} /></div>
              <div><label>{t('hotswap.originalStream')}</label><input value={form.original_stream} onChange={e => set('original_stream', e.target.value)} /></div>
            </div>
            <div className="field-inline">
              <div><label>{t('hotswap.substituteApp')}</label><input value={form.substitute_app} onChange={e => set('substitute_app', e.target.value)} /></div>
              <div><label>{t('hotswap.substituteStream')}</label><input value={form.substitute_stream} onChange={e => set('substitute_stream', e.target.value)} /></div>
            </div>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setCreating(false)}>{t('action.cancel')}</button>
              <button className="primary"
                      disabled={busy || !form.original_app || !form.original_stream || !form.substitute_app || !form.substitute_stream}
                      onClick={async () => { await create(); setCreating(false); }}>
                {busy ? t('hotswap.creating') : t('hotswap.createDisarmed')}
              </button>
            </div>
          </div>
        </div>
      )}
      {editModal && (
        <div className="modal-back" {...backdropClose(() => setEditModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{t('wo.editHotswap')}</h3>
            <div className="field-inline">
              <div><label>{t('wo.originalApp')}</label><input value={editModal.original_app} onChange={e => setEditModal(m => ({ ...m, original_app: e.target.value }))} /></div>
              <div><label>{t('wo.originalStream')}</label><input value={editModal.original_stream} onChange={e => setEditModal(m => ({ ...m, original_stream: e.target.value }))} /></div>
            </div>
            <div className="field-inline">
              <div><label>{t('wo.substituteApp')}</label><input value={editModal.substitute_app} onChange={e => setEditModal(m => ({ ...m, substitute_app: e.target.value }))} /></div>
              <div><label>{t('wo.substituteStream')}</label><input value={editModal.substitute_stream} onChange={e => setEditModal(m => ({ ...m, substitute_stream: e.target.value }))} /></div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={editModal.paused}
                     onChange={e => setEditModal(m => ({ ...m, paused: e.target.checked }))} /> {t('wo.pausedDisarmed')}
            </label>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy} onClick={async () => {
                const { id, ...body } = editModal;
                await put({ id }, body);
                setEditModal(null);
              }}>{t('action.apply')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Live streams
// Confirmed endpoint /server/{sid}/live/streams — the same data WMSPanel
// shows in "Живые потоки": all protocols, codecs, resolution, bandwidth,
// publisher IP and publish time. 1 API call per refresh.
const fmtUptime = (ts) => {
  if (!ts) return '—';
  let sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const d = Math.floor(sec / 86400); sec %= 86400;
  const h = Math.floor(sec / 3600); sec %= 3600;
  const m = Math.floor(sec / 60);
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
};

export function WmsStreamsTab({ serverId, server }) {
  const tg = useStreamTags(serverId, 'streams');
  // iter9 m2 - resolved from WMSPanel (hosts + real RTMP port) rather than
  // read off the panel record, which nothing ever populated.
  const pb = usePlaybackEndpoints(serverId);
  const endpoints = pb.endpoints;
  const [watch, setWatch] = useState(null);   // { app, stream }
  const confirm = useConfirm();
  const { can } = useAuth();
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [auto, setAuto] = useState(false);
  const [loadedAt, setLoadedAt] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      setData(await api(`/wmspanel/server/${serverId}/streams`));
      setLoadedAt(new Date());
    } catch (e) {
      setError(e.message + (e.data?.upstream ? ' :: ' + JSON.stringify(e.data.upstream) : ''));
      setData({ streams: [] });
    }
  };
  useEffect(() => { load(); }, [serverId]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [auto, serverId]);

  // Live/running streams cannot be deleted (matches WMSPanel). Only DOWN
  // (offline) entries can be cleared, exactly like "Живые потоки".
  const downStreams = (data?.streams || []).filter(st => st.status !== 'online');
  const deleteAllDown = async () => {
    if (downStreams.length === 0) return;
    if (!(await confirm(`Remove ${downStreams.length} offline stream(s) from the list? Running streams are untouched.`))) return;
    setBusy(true); setError('');
    try {
      for (const st of downStreams) {
        try { await api(`/wmspanel/server/${serverId}/streams/${st.id}`, { method: 'DELETE' }); } catch { /* skip individual */ }
      }
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  const q = filter.trim().toLowerCase();
  const list = (data.streams || []).filter(st =>
    !q || (st.application + '/' + st.stream + ' ' + (st.description || '') + ' ' + (st.tags || []).join(' ')).toLowerCase().includes(q));
  const byApp = {};
  for (const st of list) (byApp[st.application || '?'] ||= []).push(st);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, alignItems: 'center' }}>
        <SearchInput style={{ maxWidth: 280 }} placeholder={t('wo.filterAppStreamTag')} value={filter} onChange={setFilter} />
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          {t('wo.auto30')}
        </label>
        {can('wmsobjects.manage') && (
          <button disabled={busy || downStreams.length === 0} onClick={deleteAllDown}>
            Delete all down streams{downStreams.length ? ` (${downStreams.length})` : ''}
          </button>
        )}
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {list.length} of {(data.streams || []).length} streams
          {loadedAt && <> · loaded {loadedAt.toLocaleTimeString()}</>}
        </span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!pb.loading && endpoints.length === 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>{t('play.setupHint')}</div>
      )}
      {pb.source === 'panel' && (
        <div className="hint" style={{ marginBottom: 8 }}>{t('play.derivedFromRecord')}</div>
      )}
      <TagFilterBar st={tg} />
      {Object.entries(byApp).sort(([a], [b]) => a.localeCompare(b)).map(([app, streams]) => (
        <div className="panel" key={app}>
          <h2 style={{ marginTop: 0 }}>{app} <span className="hint">({streams.length})</span></h2>
          <table>
            <thead><tr><th>{t('wo.stream')}</th><th>{t('wo.proto')}</th><th>{t('wo.codecs')}</th><th>{t('wo.res')}</th><th>{t('wo.bitrate')}</th><th>{t('wo.publisher')}</th><th>{t('wo.uptime')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
            <tbody>
              {streams.filter(st => tg.matches('streams', `${st.application}/${st.stream}`)).sort((a, b) => String(a.stream).localeCompare(String(b.stream))).map(st => (
                <tr key={st.id}>
                  <td className="mono">
                    <span className={'lamp ' + (st.status === 'online' ? 'on' : 'off')} /><b>{st.stream}</b>
                    {(st.tags || []).map(t => <span key={t} className="badge" style={{ marginLeft: 4 }}>{t}</span>)}
                    {st.description && <div className="hint">{st.description}</div>}
                  </td>
                  <td><span className="badge">{st.protocol}</span></td>
                  <td className="hint mono">{[st.video_codec, st.audio_codec].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="mono">{st.resolution || '—'}</td>
                  <td className="mono">{st.bandwidth ? (st.bandwidth / 1e6).toFixed(1) + ' Mbps' : '—'}</td>
                  <td className="mono hint">{st.publisher_ip || '—'}</td>
                  <td className="mono">{st.status === 'online' ? fmtUptime(st.publish_time) : '—'}</td>
                  <td><TagChips st={tg} kind="streams" objId={`${st.application}/${st.stream}`} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {endpoints.length > 0 && (
                      <button onClick={() => setWatch({ app: st.application, stream: st.stream })}>
                        ▶ {t('play.watch')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {list.length === 0 && !error && <div className="panel hint">No live streams{q ? ' matching the filter' : ''}.</div>}
      {watch && (
        <PlaybackModal endpoints={endpoints} initialEndpoint={endpoints[0]}
                       app={watch.app} stream={watch.stream} onClose={() => setWatch(null)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- MPEGTS In
// Settings editor for "MPEGTS на вход" (schema pinned from live dump) with
// telemetry: status lamp, bandwidth, codecs parsed from PMT/PIDs. This is a
// SETTINGS view, not the full "Живые потоки" aggregate (that one covers all
// protocols + codecs/uptime and needs a dedicated API — being pinned via the
// probe dump).
// WMSPanel's own reading of the stream, which it refreshes on its ~30s sync.
// Distinguishable from the live native reading on purpose: when the two
// disagree the difference matters, and telling them apart by their format is
// what revealed that the join was silently falling back here.
const fmtMbps = (b) => (b ? `${(b / 1e6).toFixed(2)} Mbps` : '—');
const codecsOf = (o) => {
  const types = (o.pmts || []).flatMap(p => (p.pids || []).map(x => x.type)).filter(Boolean);
  return [...new Set(types)].join(', ');
};

export function MpegtsInTab({ serverId }) {
  const live = useLive(serverId, 'incoming');
  const [history, setHistory] = useState(null);
  const st = useStreamTags(serverId, 'incoming');
  const cp = useStreamCopy(serverId, 'incoming');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can, sys } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'incoming');
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null); // {} for create, object for edit
  const [busy, setBusy] = useState(false);
  const streams = (data?.streams || []).filter(o =>
    (!filter || (o.name + ' ' + (o.description || '')).toLowerCase().includes(filter.toLowerCase())) &&
    st.matches('incoming', o.id));

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      name: modal.name, description: modal.description || '',
      protocol: modal.protocol, ip: modal.ip, port: Number(modal.port),
      receive_mode: modal.receive_mode,
    };
    try {
      if (modal.parameters?.trim()) body.parameters = JSON.parse(modal.parameters);
      if (modal.id) await api(`/wmspanel/server/${serverId}/incoming/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/incoming`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (o) => {
    if (!(await confirm(t('wo.confirmDeleteIncoming', { s: o.name })))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/incoming/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <SyncNote />
      {sys?.srtHelperEnabled && <SrtHelper />}
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <SearchInput style={{ maxWidth: 260 }} placeholder={t('wo.filterNameDesc')} value={filter} onChange={setFilter} />
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ name: '', description: '', protocol: 'srt', ip: '0.0.0.0', port: 10000, receive_mode: 'listen', parameters: '' })}>
            + {t('new.incoming')}
          </button>
        )}
        <span className="hint">{streams.length} of {(data?.streams || []).length}</span>
      </div>
      <TagFilterBar st={st} />
      <CopySelectionBar cp={cp} visibleIds={streams.map(o => o.id)} />
      <div className="panel">
        <JoinNote live={live} t={t} />
        <table>
          <thead><tr><th></th><th>{t('wo.name')}</th><th>{t('wo.proto')}</th><th>{t('wo.endpoint')}</th><th>{t('wo.mode')}</th><th>{t('wo.codecs')}</th><th>{t('wo.bitrate')}</th><th>{t('wo.status')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {streams.map(o => (
              <tr key={o.id}>
                <td><CopyCheckbox cp={cp} id={o.id} /></td>
                <td><b>{o.name}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td><span className="badge">{o.protocol}</span></td>
                <td className="mono">{o.ip}:{o.port}</td>
                <td>{o.receive_mode}</td>
                <td className="hint">{codecsOf(o) || '—'}</td>
                {/* The live reading wins: `o.bandwidth` and `o.status` come
                    from the WMSPanel object, which describes how the stream is
                    configured and never what it is doing. */}
                {/* A connected socket carrying nothing reads 0, not a dash: a
                    dash means "no reading", and those are different faults. */}
                <td className="mono">
                  {live?.live?.[o.id]
                    ? (live.live[o.id].idle
                      ? <span style={{ color: 'var(--warn)' }} title={t('wo.idleHint')}>
                          {fmtBps(live.live[o.id].bps)}
                        </span>
                      : fmtBps(live.live[o.id].bps))
                    : <span title={t('wo.fromWms')}>{fmtMbps(o.bandwidth)}<sup className="hint">wp</sup></span>}
                </td>
                <td>
                  {(() => {
                    const l = live?.live?.[o.id];
                    const on = l ? l.online : o.status === 'online';
                    const label = l ? (l.online ? t('wo.online') : t('wo.offline')) : (o.status || '—');
                    return (
                      <>
                        <span className={'lamp ' + (l?.idle ? 'warn' : on ? 'on' : o.status === 'paused' ? 'warn' : 'off')} />
                        {l?.idle ? t('wo.idle') : label}
                        {l?.rtt != null && <span className="hint" style={{ marginLeft: 6 }}>RTT {l.rtt.toFixed(0)}ms</span>}
                        {l?.loss ? <span className="hint" style={{ marginLeft: 6, color: 'var(--warn)' }}>{l.loss.toFixed(2)}%</span> : null}
                        {/* A retry count that climbs is a link that keeps
                            dropping — invisible in any instantaneous reading. */}
                        {l?.retries > 100 ? <span className="hint" style={{ marginLeft: 6 }}>×{l.retries}</span> : null}
                      </>
                    );
                  })()}
                </td>
                <td><TagChips st={st} kind="incoming" objId={o.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* Asked from the row that raises the question, and available to
                      anyone who can see the stream — reading its past is not a
                      change to it. */}
                  <button onClick={() => setHistory({ id: o.id, name: o.name })}>{t('wo.history')}</button>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setModal({
                      id: o.id, name: o.name, description: o.description || '',
                      protocol: o.protocol, ip: o.ip, port: o.port,
                      receive_mode: o.receive_mode,
                      parameters: Object.keys(o.parameters || {}).length ? JSON.stringify(o.parameters) : '',
                    })}>{t('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(o)}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {streams.length === 0 && <tr><td colSpan={10} className="hint">No incoming MPEGTS/SRT streams{filter ? ' matching filter' : ''}.</td></tr>}
          </tbody>
        </table>
      </div>
      {history && (
        <StreamHistory serverId={serverId} objectId={history.id} name={history.name}
                       kind="incoming" onClose={() => setHistory(null)} />
      )}
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.name}` : 'New incoming stream'}</h3>
            <label>{t('wo.name')}</label>
            <input value={modal.name} onChange={e => setModal(m => ({ ...m, name: e.target.value }))} />
            <label>{t('wo.description')}</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <div className="field-inline">
              <div>
                <label>{t('wo.protocol')}</label>
                <Select value={modal.protocol} onChange={v => setModal(m => ({ ...m, protocol: v }))}
                        options={['srt', 'udp', 'rist', 'http', 'hls'].map(x => ({ value: x, label: x }))} />
              </div>
              <div>
                <label>{t('wo.receiveMode')}</label>
                <Select value={modal.receive_mode} onChange={v => setModal(m => ({ ...m, receive_mode: v }))}
                        options={['listen', 'pull'].map(x => ({ value: x, label: x }))} />
              </div>
            </div>
            <div className="field-inline">
              <div><label>IP</label><input className="mono" value={modal.ip} onChange={e => setModal(m => ({ ...m, ip: e.target.value }))} /></div>
              <div><label>{t('wo.port')}</label><input type="number" value={modal.port} onChange={e => setModal(m => ({ ...m, port: e.target.value }))} /></div>
            </div>
            <label>Parameters (JSON, e.g. {'{"latency":"1000"}'} — empty = none)</label>
            <input className="mono" value={modal.parameters} onChange={e => setModal(m => ({ ...m, parameters: e.target.value }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !modal.name || !modal.ip || !modal.port} onClick={save}>
                {modal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      <CopyModal cp={cp} currentServerId={serverId} />
    </div>
  );
}

// ------------------------------------------------------------- Live Pull
// RTMP pull feeds with fallback_urls — the built-in feed reserve mechanism.
export function LivePullTab({ serverId }) {
  const st = useStreamTags(serverId, 'livepull');
  const cp = useStreamCopy(serverId, 'livepull');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'livepull');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const settings = data?.settings || [];

  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const save = () => act(async () => {
    const body = {
      url: modal.url,
      fallback_urls: modal.fallback_urls.split('\n').map(x => x.trim()).filter(Boolean),
      application: modal.application, stream: modal.stream,
      description: modal.description || '',
    };
    if (modal.id) await api(`/wmspanel/server/${serverId}/livepull/${modal.id}`, { method: 'PUT', body });
    else await api(`/wmspanel/server/${serverId}/livepull`, { method: 'POST', body });
    setModal(null);
  });

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ url: '', fallback_urls: '', application: '', stream: '', description: '' })}>
            + {t('new.pull')}
          </button>
        )}
      </div>
      <TagFilterBar st={st} />
      <CopySelectionBar cp={cp} visibleIds={settings.filter(o => st.matches('livepull', o.id)).map(o => o.id)} />
      <div className="panel">
        <table>
          <thead><tr><th></th><th>{t('wo.localAppStream')}</th><th>{t('wo.sourceUrl')}</th><th>{t('wo.fallbacks')}</th><th>{t('wo.state')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {settings.filter(o => st.matches('livepull', o.id)).map(o => (
              <tr key={o.id}>
                <td><CopyCheckbox cp={cp} id={o.id} /></td>
                <td className="mono"><b>{o.application}/{o.stream}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td className="mono hint" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.url}</td>
                <td>{(o.fallback_urls || []).length ? <span className="badge">{o.fallback_urls.length} fallback</span> : <span className="hint">—</span>}</td>
                <td><span className={'lamp ' + (o.paused ? 'off' : 'on')} />{o.paused ? 'paused' : 'active'}</td>
                <td><TagChips st={st} kind="livepull" objId={o.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => act(() => api(`/wmspanel/server/${serverId}/livepull/${o.id}/restart`, { method: 'POST' }))}>{t('action.restart')}</button>{' '}
                    <button disabled={busy} onClick={() => act(() => api(`/wmspanel/server/${serverId}/livepull/${o.id}`, { method: 'PUT', body: { paused: !o.paused } }))}>
                      {o.paused ? 'Resume' : 'Pause'}
                    </button>{' '}
                    <button disabled={busy} onClick={() => setModal({
                      id: o.id, url: o.url, fallback_urls: (o.fallback_urls || []).join('\n'),
                      application: o.application, stream: o.stream, description: o.description || '',
                    })}>{t('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={async () => {
                      if (await confirm(t('wo.confirmDeletePull', { s: `${o.application}/${o.stream}` })))
                        act(() => api(`/wmspanel/server/${serverId}/livepull/${o.id}`, { method: 'DELETE' }));
                    }}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={7} className="hint">{t('wo.emptyPull')}</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit pull ${modal.application}/${modal.stream}` : 'New RTMP pull'}</h3>
            <label>{t('wo.sourceUrl')}</label>
            <input className="mono" value={modal.url} onChange={e => setModal(m => ({ ...m, url: e.target.value }))}
                   placeholder="rtmp://host:1935/app/stream" />
            <label>{t('wo.fallbackUrls')}</label>
            <textarea className="mono" rows={3} value={modal.fallback_urls}
                      onChange={e => setModal(m => ({ ...m, fallback_urls: e.target.value }))} />
            <div className="field-inline">
              <div><label>{t('wo.localApplication')}</label><input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} /></div>
              <div><label>{t('wo.localStream')}</label><input value={modal.stream} onChange={e => setModal(m => ({ ...m, stream: e.target.value }))} /></div>
            </div>
            <label>{t('wo.description')}</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !modal.url || !modal.application || !modal.stream} onClick={save}>
                {modal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      <CopyModal cp={cp} currentServerId={serverId} />
    </div>
  );
}

// ------------------------------------------------------------- Applications
// live/app settings incl. push credentials (masked with reveal toggle).
export function AppsTab({ serverId }) {
  const tg = useStreamTags(serverId, 'apps');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'apps');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [reveal, setReveal] = useState({});
  const apps = data?.applications || [];

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      application: modal.application,
      chunk_duration: Number(modal.chunk_duration),
      chunk_count: Number(modal.chunk_count),
      protocols: modal.protocols.split(',').map(x => x.trim()).filter(Boolean),
    };
    if (modal.push_login !== '') body.push_login = modal.push_login;
    if (modal.push_password !== '') body.push_password = modal.push_password;
    try {
      if (modal.id) await api(`/wmspanel/server/${serverId}/apps/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/apps`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ application: '', chunk_duration: 6, chunk_count: 4, protocols: 'HLS,RTMP', push_login: '', push_password: '' })}>
            + {t('new.application')}
          </button>
        )}
      </div>
      <TagFilterBar st={tg} />
      <div className="panel">
        <table>
          <thead><tr><th>{t('wo.application')}</th><th>{t('wo.protocols')}</th><th>{t('wo.chunks')}</th><th>{t('wo.pushAuth')}</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {apps.map(a => (
              <tr key={a.id}>
                <td className="mono"><b>{a.application}</b></td>
                <td>{(a.protocols || []).map(pr => <span key={pr} className="badge" style={{ marginRight: 3 }}>{pr}</span>)}</td>
                <td className="mono">{a.chunk_duration}s × {a.chunk_count}</td>
                <td className="mono">
                  {a.push_login || a.push_password ? (
                    reveal[a.id]
                      ? <>{a.push_login} / {a.push_password} <button onClick={() => setReveal(r => ({ ...r, [a.id]: false }))}>{t('wo.hide')}</button></>
                      : <>{a.push_login} / •••••• <button onClick={() => setReveal(r => ({ ...r, [a.id]: true }))}>{t('wo.show')}</button></>
                  ) : <span className="hint">{t('wo.openAuth')}</span>}
                </td>
                <td><TagChips st={tg} kind="apps" objId={a.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setModal({
                      id: a.id, application: a.application,
                      chunk_duration: a.chunk_duration, chunk_count: a.chunk_count,
                      protocols: (a.protocols || []).join(','),
                      push_login: a.push_login || '', push_password: a.push_password || '',
                    })}>{t('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={async () => {
                      if (!(await confirm(t('wo.confirmDeleteApp', { s: a.application })))) return;
                      setBusy(true); setError('');
                      try { await api(`/wmspanel/server/${serverId}/apps/${a.id}`, { method: 'DELETE' }); await load(); }
                      catch (e) { setError(e.message); }
                      finally { setBusy(false); }
                    }}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {apps.length === 0 && <tr><td colSpan={6} className="hint">{t('wo.emptyApps')}</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.application}` : 'New application'}</h3>
            <label>{t('wo.applicationName')}</label>
            <input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} />
            <div className="field-inline">
              <div><label>{t('wo.chunkDuration')}</label><input type="number" value={modal.chunk_duration} onChange={e => setModal(m => ({ ...m, chunk_duration: e.target.value }))} /></div>
              <div><label>{t('wo.chunkCount')}</label><input type="number" value={modal.chunk_count} onChange={e => setModal(m => ({ ...m, chunk_count: e.target.value }))} /></div>
            </div>
            <label>{t('wo.protocolsHint')}</label>
            <input value={modal.protocols} onChange={e => setModal(m => ({ ...m, protocols: e.target.value }))} />
            <div className="field-inline">
              <div><label>{t('wo.pushLogin')}</label><input value={modal.push_login} onChange={e => setModal(m => ({ ...m, push_login: e.target.value }))} /></div>
              <div><label>{t('wo.pushPassword')}</label><input type="password" value={modal.push_password} onChange={e => setModal(m => ({ ...m, push_password: e.target.value }))} /></div>
            </div>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !modal.application} onClick={save}>{modal.id ? 'Apply' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Interfaces
export function InterfacesTab({ serverId }) {
  const tg = useStreamTags(serverId, 'interfaces');
  const { t } = useI18n();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'interfaces');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const list = data?.interfaces || [];

  const save = async () => {
    setBusy(true); setError('');
    const body = { ip: modal.ip, port: Number(modal.port), ssl: Boolean(modal.ssl) };
    try {
      if (modal.id) await api(`/wmspanel/server/${serverId}/interfaces/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/interfaces`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const remove = async (i) => {
    if (!(await confirm(t('wo.confirmDeleteInterface', { s: `${i.ip}:${i.port}` })))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/interfaces/${i.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">{t('wo.loading')}</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy} onClick={() => setModal({ ip: '0.0.0.0', port: 1935, ssl: false })}>+ {t('new.interface')}</button>
        )}
      </div>
      <TagFilterBar st={tg} />
      <div className="panel">
        <table>
          <thead><tr><th>IP</th><th>{t('wo.port')}</th><th>SSL</th><th>{t('tags.col')}</th><th></th></tr></thead>
          <tbody>
            {list.map(i => (
              <tr key={i.id}>
                <td className="mono">{i.ip}</td>
                <td className="mono">{i.port}</td>
                <td>{i.ssl ? <span className="badge">ssl</span> : <span className="hint">{t('wo.noValue')}</span>}</td>
                <td><TagChips st={tg} kind="interfaces" objId={i.id} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setModal({ id: i.id, ip: i.ip, port: i.port, ssl: i.ssl })}>{t('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(i)}>{t('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="hint">{t('wo.emptyInterfaces')}</td></tr>}
          </tbody>
        </table>

      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit interface ${modal.ip}:${modal.port}` : 'New RTMP interface'}</h3>
            <div className="field-inline">
              <div><label>IP</label><input className="mono" value={modal.ip} onChange={e => setModal(m => ({ ...m, ip: e.target.value }))} /></div>
              <div><label>{t('wo.port')}</label><input type="number" value={modal.port} onChange={e => setModal(m => ({ ...m, port: e.target.value }))} /></div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={modal.ssl} onChange={e => setModal(m => ({ ...m, ssl: e.target.checked }))} /> SSL
            </label>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !modal.ip || !modal.port} onClick={save}>{modal.id ? 'Apply' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
