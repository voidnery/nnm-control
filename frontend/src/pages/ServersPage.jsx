import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import { useI18n } from '../i18n.jsx';
import { useConfirm } from '../confirm.jsx';
import IconButton from '../components/IconButton.jsx';

const EMPTY = { name: '', host: '', port: 8082, token: '', useSsl: false, tags: '', notes: '', wmspanelServerId: '', playbackEndpoints: [], httpPort: 0, httpsPort: 0, purpose: 'nimble' };

function ServerModal({ initial, onClose, onSaved, wms }) {
  const { t } = useI18n();
  const isEdit = Boolean(initial.id);
  const [wpServers, setWpServers] = useState(null); // null = loading/unavailable
  const [form, setForm] = useState({
    ...EMPTY, ...initial,
    token: '', // never prefilled — empty means "keep existing" on edit
    tags: (initial.tags || []).join(', '),
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // What the TLS handshake found, if it has been run in this dialog. The saved
  // answer arrives on `initial.tls`; this holds a fresher one.
  const [tls, setTls] = useState(initial.tls || null);
  const [tlsBusy, setTlsBusy] = useState(false);
  // What this machine is decides what the dialog asks. A gateway has no media
  // server on it, so a WMSPanel mapping, a Nimble HTTP port and playback
  // endpoints are all questions about something that is not there.
  const isNimble = (form.purpose || 'nimble') !== 'gateway';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Asked of the server rather than declared by the operator. LL-HLS needs
  // HTTP/2 over TLS and a player without it falls back to ordinary HLS in
  // silence — video plays, latency is unchanged, nothing on any screen says
  // so. The only honest answer comes from the handshake.
  const checkTls = async () => {
    setTlsBusy(true); setError('');
    try {
      const r = await api(`/servers/${initial.id}/tls/check`, {
        method: 'POST', body: { port: Number(form.httpsPort) || undefined },
      });
      setTls(r.tls);
      // A port that answered is worth remembering, so the next person does not
      // have to find it again.
      if (r.tls?.tls && !(Number(form.httpsPort) > 0)) set('httpsPort', r.port);
    } catch (e) { setError(e.data?.error || e.message); }
    finally { setTlsBusy(false); }
  };

  useEffect(() => {
    // WMSPanel mapping helper; silently unavailable until API creds are set.
    api('/wmspanel/servers').then(d => setWpServers(d.servers)).catch(() => setWpServers(null));
  }, []);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = {
        name: form.name, host: form.host, port: Number(form.port) || 8082,
        useSsl: form.useSsl, notes: form.notes,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        wmspanelServerId: form.wmspanelServerId || '',
        httpPort: Number(form.httpPort) > 0 ? Number(form.httpPort) : 0,
        httpsPort: Number(form.httpsPort) > 0 ? Number(form.httpsPort) : 0,
        purpose: form.purpose || 'nimble',
        playbackEndpoints: (form.playbackEndpoints || []).filter(e => String(e.host || '').trim()),
      };
      // On edit an empty token field means "do not change".
      if (!isEdit || form.token !== '') body.token = form.token;
      if (isEdit) await api(`/servers/${initial.id}`, { method: 'PUT', body });
      else await api('/servers', { method: 'POST', body });
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{isEdit ? t('sp.editTitle') : t('sp.addTitle')}</h3>
        {/* First, because it decides what the rest of this dialog is even
            asking. A gateway has no WMSPanel mapping, no Nimble port and no
            playback endpoints; a media server has no use for a TLS port. The
            dialog used to ask everything of everyone, which is how a form
            teaches people to skip fields. */}
        <label>{t('sp.purposeLabel')}</label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {['nimble', 'nimble-cdn', 'gateway'].map(v => (
            <button key={v} className={'tagchip' + ((form.purpose || 'nimble') === v ? ' on' : '')}
                    onClick={() => set('purpose', v)}>{t('sp.purpose.' + v)}</button>
          ))}
        </div>
        <div className="hint">{t('sp.purpose.' + (form.purpose || 'nimble') + '.note')}</div>
        {!isNimble && <div className="hint">{t('sp.gatewayHint')}</div>}

        <label>{t('sp.name')}</label>
        <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="edge-01" />
        <div className="field-inline">
          <div>
            <label>{t('sp.host')}</label>
            <input value={form.host} onChange={e => set('host', e.target.value)} placeholder="10.77.0.10" />
          </div>
          {!wms && (
            <div>
              <label>{t('sp.mgmtPort')}</label>
              <input type="number" value={form.port} onChange={e => set('port', e.target.value)} />
            </div>
          )}
        </div>
        {!wms && <>
          <label>{t('sp.mgmtToken')} {isEdit && <span className="hint">{t('sp.keepCurrent')}</span>}</label>
          <input type="password" value={form.token} onChange={e => set('token', e.target.value)}
                 placeholder={initial.hasToken ? '••••••• (set)' : 'empty = no auth on server'} />
        </>}
        {/* A gateway is not in WMSPanel and never will be: no media server
            runs on it, so there is nothing for WMSPanel to manage. */}
        {isNimble && <>
        <label>{t('sp.wmspanelServer')}</label>
        {wpServers ? (
          <Select value={form.wmspanelServerId} onChange={v => set('wmspanelServerId', v)}
                  options={[{ value: '', label: t('sp.notMapped') }, ...wpServers.map(ws => ({ value: ws.id, label: `${ws.name} (${ws.status})` }))]} />
        ) : (
          <input value={form.wmspanelServerId} onChange={e => set('wmspanelServerId', e.target.value)}
                 placeholder={t('sp.wmspanelIdHint')} className="mono" />
        )}
        </>}

        <label>{t('sp.tagsComma')}</label>
        <input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="edge, moscow" />
        {isNimble && <>
        <label>{t('sp.playback')}</label>
        <div className="hint" style={{ marginBottom: 6 }}>{t('sp.playbackHint')}</div>
        {/* iter9 m2 - the RTMP port and the hostnames are read from WMSPanel,
            but the HTTP port lives in nimble.conf and no API reports it, so it
            is the one number that has to be told to the panel. Blank means
            "use Nimble's default", and the playback dialog says when it did. */}
        {/* What this machine is for. It decides which checks apply — a gateway
            judged as a media server reads as broken while being correct. */}

        <div className="row" style={{ gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <span className="hint" style={{ flex: 1 }}>{t('sp.httpPortHint')}</span>
          <input type="number" style={{ flex: '0 0 110px' }} placeholder="8081"
                 value={form.httpPort || ''} onChange={e => set('httpPort', e.target.value)} />
        </div>

        </>}

        {/* TLS is asked of every purpose: a gateway needs it to terminate for
            viewers, and a media server needs it for LL-HLS. It is the one
            question that means the same thing on both. */}
        <div className="row" style={{ gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <span className="hint" style={{ flex: 1 }}>{t('sp.httpsPortHint')}</span>
          <input type="number" style={{ flex: '0 0 110px' }} placeholder="443"
                 value={form.httpsPort || ''} onChange={e => set('httpsPort', e.target.value)} />
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
          {/* Only on edit: an unsaved server has no id to ask about. */}
          <button disabled={!isEdit || tlsBusy} onClick={checkTls}>
            {tlsBusy ? '…' : t('tls.check')}
          </button>
          {!isEdit && <span className="hint">{t('sp.tlsAfterSave')}</span>}
          {isEdit && !tls?.checkedAt && <span className="hint">{t('sp.tlsNotChecked')}</span>}
          {tls?.checkedAt && (
            <span className="hint">
              {tls.tls
                ? <>{t('tls.yes', { alpn: tls.alpn || '?' })}
                    {' · '}{t(tls.http2 ? 'tls.h2' : 'tls.noH2')}
                    {!tls.certTrusted && <> · {t('tls.certBad')}</>}</>
                : t('tls.reason.' + (tls.reason || 'handshake-failed'))}
            </span>
          )}
        </div>
        {(form.playbackEndpoints || []).map((e, i) => {
          const upd = (patch) => set('playbackEndpoints', form.playbackEndpoints.map((x, j) => j === i ? { ...x, ...patch } : x));
          return (
            <div className="row" key={i} style={{ gap: 6, marginBottom: 4, alignItems: 'center' }}>
              <input style={{ flex: '0 0 110px' }} placeholder={t('sp.epLabel')} value={e.label || ''}
                     onChange={ev => upd({ label: ev.target.value })} />
              <input className="mono" style={{ flex: 1 }} placeholder="cdn.example.com" value={e.host || ''}
                     onChange={ev => upd({ host: ev.target.value })} />
              <input type="number" style={{ flex: '0 0 90px' }} title="HLS" value={e.hlsPort ?? 8081}
                     onChange={ev => upd({ hlsPort: Number(ev.target.value) })} />
              <input type="number" style={{ flex: '0 0 90px' }} title="RTMP" value={e.rtmpPort ?? 1935}
                     onChange={ev => upd({ rtmpPort: Number(ev.target.value) })} />
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', margin: 0, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={Boolean(e.ssl)} onChange={ev => upd({ ssl: ev.target.checked })} /> SSL
              </label>
              <button className="danger" onClick={() => set('playbackEndpoints', form.playbackEndpoints.filter((_, j) => j !== i))}>✕</button>
            </div>
          );
        })}
        <button onClick={() => set('playbackEndpoints', [...(form.playbackEndpoints || []), { label: '', host: form.host, hlsPort: 8081, rtmpPort: 1935, ssl: false }])}>
          + {t('sp.addEndpoint')}
        </button>
        <label>{t('sp.notes')}</label>
        <textarea rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        {!wms && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.useSsl}
                   onChange={e => set('useSsl', e.target.checked)} /> {t('sp.useHttps')}
          </label>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('action.cancel')}</button>
          <button className="primary" disabled={busy || !form.name || !form.host} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ServersPage() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const { can, sys } = useAuth();
  const wms = sys?.controlPlane === 'wmspanel';
  const [servers, setServers] = useState([]);
  const [modal, setModal] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [error, setError] = useState('');
  const [syncMsg, setSyncMsg] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const load = () => api('/servers').then(setServers).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const syncNow = async () => {
    setSyncBusy(true); setSyncMsg(null);
    try {
      const r = await api('/wmspanel/sync', { method: 'POST' });
      setSyncMsg(r.skipped ? { ok: false, text: `Sync skipped: ${r.reason}` }
                           : { ok: true, text: `Synced from WMSPanel: +${r.created} new, ${r.updated} updated (${r.remoteTotal} total)` });
      load();
    } catch (e) { setSyncMsg({ ok: false, text: e.message }); }
    finally { setSyncBusy(false); }
  };

  const test = async (id) => {
    setTestResults(r => ({ ...r, [id]: { busy: true } }));
    const result = await api(`/servers/${id}/test`, { method: 'POST' });
    setTestResults(r => ({ ...r, [id]: result }));
  };

  const remove = async (s) => {
    if (!(await confirm(t('sp.confirmDelete', { name: s.name })))) return;
    await api(`/servers/${s.id}`, { method: 'DELETE' });
    load();
  };

  // Reorder: swap locally first so the row moves under the cursor without a
  // round-trip, then persist the whole order. On failure the server wins —
  // reload rather than leave the operator looking at an order that was never
  // stored.
  const move = async (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= servers.length) return;
    const next = servers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setServers(next);
    setError('');
    try {
      await api('/servers/order', { method: 'PUT', body: { ids: next.map(s => s.id) } });
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  return (
    <div>
      <h1>{t('page.servers.title')}</h1>
      <div className="sub">{t('page.servers.sub')}</div>
      {error && <div className="error-box">{error}</div>}
      {wms && (
        <div className="panel" style={{ padding: '10px 14px' }}>
          <span className="lamp on" />Control plane: <b>WMSPanel API</b> — the fleet is pulled from WMSPanel automatically
          (every 10 min). Native management token is not known to WMSPanel — set it per server to enable live status.
          {can('servers.manage') && (
            <button style={{ marginLeft: 12 }} disabled={syncBusy} onClick={syncNow}>{syncBusy ? 'Syncing…' : 'Sync now'}</button>
          )}
          {syncMsg && <span className={syncMsg.ok ? 'hint' : ''} style={{ marginLeft: 10, color: syncMsg.ok ? undefined : 'var(--danger)' }}>{syncMsg.text}</span>}
        </div>
      )}
      {can('servers.manage') && (
        <button className="primary" style={{ marginBottom: 14 }} onClick={() => setModal({})}>{t('sp.add')}</button>
      )}
      <div className="panel">
        <table>
          <thead>
            <tr><th></th><th>{t('sp.name')}</th><th>{wms ? 'Host' : 'Endpoint'}</th><th>{t('sp.tags')}</th>{!wms && <th>{t('sp.auth')}</th>}{!wms && <th>{t('sp.check')}</th>}<th></th></tr>
          </thead>
          <tbody>
            {servers.map((s, i) => {
              const tr = testResults[s.id];   // test result — must not shadow i18n `t`
              return (
                <tr key={s.id}>
                  <td style={{ width: 1, whiteSpace: 'nowrap', paddingRight: 0 }}>
                    {can('servers.manage') && (
                      <span className="reorder">
                        <button className="tag-btn ghost" disabled={i === 0}
                                title={t('sp.moveUp')} onClick={() => move(i, -1)}>▲</button>
                        <button className="tag-btn ghost" disabled={i === servers.length - 1}
                                title={t('sp.moveDown')} onClick={() => move(i, 1)}>▼</button>
                      </span>
                    )}
                  </td>
                  <td>
                    <Link to={`/servers/${s.id}`}><b>{s.name}</b></Link>
                    {s.syncedFromWmspanel && (
                      <span className="badge" style={{ marginLeft: 6 }}
                            title={'Auto-synced from WMSPanel' + (s.wmspanelStatus ? ` · panel status: ${s.wmspanelStatus}` : '')}>
                        WMS{s.wmspanelStatus ? `:${s.wmspanelStatus}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="mono">{wms ? (s.host || '—') : `${s.useSsl ? 'https' : 'http'}://${s.host}:${s.port}`}</td>
                  <td>{s.tags.map(tag => <span key={tag} className="badge" style={{ marginRight: 4 }}>{tag}</span>)}</td>
                  {!wms && <td>{s.hasToken ? <span className="badge">token</span> : <span className="badge">open</span>}</td>}
                  {!wms && <td>
                    <button onClick={() => test(s.id)} disabled={tr?.busy}>{tr?.busy ? '…' : 'Test'}</button>{' '}
                    {tr && !tr.busy && (
                      <span className={'lamp ' + (tr.ok ? 'on' : 'off')} title={tr.ok ? 'OK' : tr.error} />
                    )}
                  </td>}
                  <td style={{ textAlign: 'right' }}>
                    {can('servers.manage') && <>
                      <IconButton action="edit" onClick={() => setModal(s)} />{' '}
                      <IconButton action="remove" danger onClick={() => remove(s)} />
                    </>}
                  </td>
                </tr>
              );
            })}
            {servers.length === 0 && <tr><td colSpan={wms ? 4 : 6} className="hint">{t('sp.noServers')}</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && <ServerModal initial={modal} wms={wms} onClose={() => setModal(null)}
                             onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
