import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import ErrorDialog from './ErrorDialog.jsx';
import Modal from './Modal.jsx';
import { HlsPlayer } from './StreamPlayback.jsx';
import { explainError } from '../lib/errors.js';

// How a viewer gets a link, and what that choice costs.
//
// The three modes are a real trade-off between money, exposure and moving
// parts, and it is the operator's to make — so each is shown with its price
// next to it rather than as three equal words in a dropdown. The one that
// catches people is redirect without DNS names on the edges: it feels like it
// hides the edges and it does not, because the 302 target is an address the
// viewer receives. That is stated on the mode, and again on the preview.
const MODES = ['direct', 'redirect', 'proxy'];
const POLICIES = ['nearest', 'least-loaded', 'weighted', 'failover'];

export default function GatewayPanel({ network, servers = [] }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const canManage = can('cdn.manage');

  const EMPTY = { mode: 'direct', policy: 'nearest', whenAllDown: 'fail', domain: '', node: null };
  const [gw, setGw] = useState(network.gateway || EMPTY);

  // Follow the network when it is reloaded.
  //
  // `useState` runs once. The parent reloads after a save and passes the new
  // network down, but this component was already mounted — so it kept showing
  // what had been typed before the save, and reopening the page showed
  // something different again. Saved correctly, displayed from a stale copy.
  //
  // Keyed on the network id and the saved gateway, so switching networks or
  // saving replaces the form, and typing in it does not.
  const [resync, setResync] = useState(null);
  const savedKey = JSON.stringify(network.gateway || null);
  useEffect(() => { setGw(network.gateway || EMPTY); }, [network.id, savedKey]);
  const [preview, setPreview] = useState(null);
  const [probe, setProbe] = useState({ channel: '', stream: '', viewerIp: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  // Closing the loop. The panel produced a URL and the operator went to a
  // player to find out whether it worked; it can ask the same question itself,
  // and then play it here.
  const [watch, setWatch] = useState(null);
  const [playing, setPlaying] = useState('');

  // Machines that can carry a gateway, and only those.
  //
  // The filter was right and the list was empty on every fleet, because
  // /servers never sent `agent` at all — a field nobody sends looks exactly
  // like a fleet with no agents.
  //
  // Split by purpose, because they are different machines doing different
  // jobs: an edge-proxy has no Nimble and exists to hand viewers on, while a
  // Nimble box can host the gateway but is also serving video from the same
  // ports. Offering them as one list invites putting a gateway on a media
  // server without noticing.
  const withAgent = servers.filter(s => s.agent?.enabled || s.hasAgent);
  const proxies = withAgent.filter(s => (s.purpose || 'nimble') === 'gateway');
  const nimbles = withAgent.filter(s => (s.purpose || 'nimble') !== 'gateway');

  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/cdn/networks/${network.id}/gateway`, { method: 'PUT', body: gw });
      setGw(r.gateway);
      // Whether the machine's nginx knows about these edges. Saving here
      // changes the panel's model and nothing on the machine, so a proxy
      // gateway prepared before the network had edges forwards viewers to a
      // placeholder that never resolves — accepting connections and serving
      // nothing.
      // What the machine did with it. The panel rewrites its nginx on save,
      // so the operator should learn in the same breath whether it took —
      // silence after a change to a live delivery path is the wrong default.
      setResync(r.resync || null);
      push({ type: 'ok', message: t('gw.saved') });
    } catch (e) { setProblem(explainError(e, t)); }
    finally { setBusy(false); }
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api(`/cdn/networks/${network.id}/resolve-preview`, {
        method: 'POST', body: { ...probe },
      }));
    } catch (e) { setProblem(explainError(e, t)); }
    finally { setBusy(false); }
  };

  const checkUrl = async () => {
    setBusy(true); setWatch(null);
    try {
      const r = await api(`/cdn/networks/${network.id}/watch`, {
        method: 'POST', body: { application: probe.channel.trim(), stream: probe.stream.trim() },
      });
      // The node the arbiter actually chose, not every node in the network:
      // this answers "does the link I am looking at work".
      setWatch(r.results.find(x => x.server === preview?.decision?.edge?.name) || r.results[0] || null);
    } catch (e) { setProblem(explainError(e, t)); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{t('gw.title')}</h2>
      <div className="hint">{t('gw.intro')}</div>
      {problem && <ErrorDialog problem={problem} onClose={() => setProblem(null)} />}

      <div className="gsection">{t('gw.modeTitle')}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {MODES.map(m => (
          <button key={m} className={'tagchip' + (gw.mode === m ? ' on' : '')}
                  disabled={!canManage} onClick={() => setGw({ ...gw, mode: m })}>
            {t('gw.mode.' + m)}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>{t('gw.mode.' + gw.mode + '.cost')}</div>

      {gw.mode !== 'direct' && (
        <>
          <label>{t('gw.node')}</label>
          <select value={gw.node || ''} disabled={!canManage}
                  onChange={e => {
                    const id = e.target.value || null;
                    const picked = servers.find(x => x.id === id);
                    // The domain the chosen machine was actually prepared
                    // with, filled in rather than left for the operator to
                    // retype from another page — and only when the field is
                    // empty, since a value they entered is a decision.
                    setGw({
                      ...gw, node: id,
                      domain: gw.domain || picked?.gateway?.domain || '',
                    });
                  }}>
            <option value="">{t('gw.pickNode')}</option>
            {proxies.length > 0 && (
              <optgroup label={t('gw.group.proxy')}>
                {proxies.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.gateway?.state === 'applied' ? ` — ${s.gateway.domain}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {nimbles.length > 0 && (
              <optgroup label={t('gw.group.nimble')}>
                {nimbles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            )}
          </select>
          {/* Said when the list is empty, because an empty dropdown is a
              question without an answer — and it was empty on every fleet for
              a while, which nothing on the screen explained. */}
          {!withAgent.length && <div className="error-box">{t('gw.noNodes')}</div>}
          {resync?.ok && (
            <div className="hint" style={{ color: 'var(--ok, #5ad18f)' }}>
              {t('gw.resynced', { machine: resync.machine, edges: resync.edges })}
            </div>
          )}
          {resync && !resync.ok && !resync.skipped && (
            <div className="error-box">
              <b>{t('gw.resyncFailed', { machine: resync.machine })}</b>
              <div className="hint">{resync.error || resync.haltedAt || ''}</div>
            </div>
          )}
          {/* A machine never prepared is not a fault: it is simply not a
              gateway yet, and saying so beats silence. */}
          {resync?.skipped === 'never-prepared' && (
            <div className="hint">{t('gw.resyncNeverPrepared')}</div>
          )}
          {resync?.skipped === 'no-privileged-helper' && (
            <div className="error-box">{t('gw.resyncNoHelper')}</div>
          )}
          <div className="hint" >{t('gw.nodeHint')}</div>

          <label>{t('gw.domain')}</label>
          <input className="mono" placeholder="cdn.example.com" value={gw.domain || ''} disabled={!canManage}
                 onChange={e => setGw({ ...gw, domain: e.target.value })} />
          <div className="hint" >{t('gw.domainHint')}</div>
        </>
      )}

      <div className="gsection">{t('gw.policyTitle')}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {POLICIES.map(p => (
          <button key={p} className={'tagchip' + (gw.policy === p ? ' on' : '')}
                  disabled={!canManage} onClick={() => setGw({ ...gw, policy: p })}>
            {t('gw.policy.' + p)}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>{t('gw.policy.' + gw.policy + '.needs')}</div>

      <label>{t('gw.whenAllDown')}</label>
      <div className="row" style={{ gap: 8 }}>
        {['fail', 'origin'].map(v => (
          <button key={v} className={'tagchip' + (gw.whenAllDown === v ? ' on' : '')}
                  disabled={!canManage} onClick={() => setGw({ ...gw, whenAllDown: v })}>
            {t('gw.down.' + v)}
          </button>
        ))}
      </div>
      <div className="hint" >{t('gw.downHint')}</div>

      {canManage && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="primary" onClick={save} disabled={busy}>{t('action.save')}</button>
        </div>
      )}

      <div className="gsection">{t('gw.previewTitle')}</div>
      <div className="hint" >{t('gw.previewHint')}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <input className="mono" style={{ maxWidth: 160 }} placeholder={t('gw.channel')}
               value={probe.channel} onChange={e => setProbe({ ...probe, channel: e.target.value })} />
        <input className="mono" style={{ maxWidth: 160 }} placeholder={t('gw.stream')}
               value={probe.stream} onChange={e => setProbe({ ...probe, stream: e.target.value })} />
        <input className="mono" style={{ maxWidth: 180 }} placeholder={t('gw.viewerIp')}
               value={probe.viewerIp} onChange={e => setProbe({ ...probe, viewerIp: e.target.value })} />
        <button onClick={runPreview} disabled={busy || !probe.channel.trim()}>{t('gw.preview')}</button>
      </div>

      {/* The player the Streams tab already uses. A second one would be a
          second place for hls.js loading, the Safari path and the error
          wording to be wrong in. */}
      {playing && (
        <Modal onClose={() => setPlaying('')} size="wide">
          <h3>{t('gw.playing')}</h3>
          <div className="mono hint" style={{ fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>{playing}</div>
          <HlsPlayer url={playing} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setPlaying('')}>{t('action.close')}</button>
          </div>
        </Modal>
      )}

      {preview && (
        <div className="inset">
          {preview.url ? (
            <>
              <div className="mono" style={{ wordBreak: 'break-all' }}>{preview.url}</div>
              {preview.redirectsTo && (
                <div className="hint mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  → {preview.redirectsTo}
                </div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <span className={'badge ' + (preview.exposes === 'nothing' ? 'live' : 'warn')}>
                  {t('gw.exposes.' + preview.exposes)}
                </span>
                <span className="hint">
                  {t('gw.chose', { edge: preview.decision.edge.name })} · {t('gw.why.' + preview.decision.reason)}
                </span>
              </div>
              {preview.decision.runnersUp?.length > 0 && (
                <div className="hint" style={{ marginTop: 4 }}>
                  {t('gw.runnersUp')} {preview.decision.runnersUp
                    .map(r => `${r.edge} (${r.distanceKm != null ? r.distanceKm + ' km' : r.connections})`)
                    .join(', ')}
                </div>
              )}
              {preview.degraded && <div className="hint">{t('gw.degraded.' + preview.degraded)}</div>}

              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={checkUrl} disabled={busy || !probe.stream.trim()}>{t('gw.checkUrl')}</button>
                <button onClick={() => setPlaying(preview.redirectsTo || preview.url)}
                        disabled={!probe.stream.trim()}>{t('gw.play')}</button>
                {!probe.stream.trim() && <span className="hint">{t('gw.needStream')}</span>}
                {watch && (
                  <span className={'badge ' + (watch.verdict.ok ? 'live' : 'err')}>
                    {t('cdn.w.' + watch.verdict.code)}{watch.ms != null ? ` · ${watch.ms} ms` : ''}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="error-box">
              {t('gw.why.' + preview.decision.reason)} · {t('gw.down.' + preview.whenAllDown)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
