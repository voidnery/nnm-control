import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal from './Modal.jsx';
import IconButton from './IconButton.jsx';
import { HlsPlayer } from './StreamPlayback.jsx';
import { copyText } from '../lib/clipboard.js';

// What is being delivered, and where.
//
// The question an operator asked and the panel could not answer about its own
// configuration, because until the channel existed there was nothing joining a
// stream to a network. One row each: what it is, which network carries it,
// what each edge is doing with it, and the link to hand somebody.
//
// Rows are not all good news, on purpose. A stream with no network is listed
// too — it is the state worth seeing before an event, and it was invisible.

function Copyable({ url, label, note, tone = '' }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [playing, setPlaying] = useState(false);
  if (!url) return null;
  return (
    <div className="ch-link">
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="eyebrow">{label}</span>
        {tone && <span className={'badge ' + tone}>{note}</span>}
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span className="mono ch-url">{url}</span>
        {/* copyText reports whether it actually worked; the toast follows it
            rather than assuming, because on plain HTTP the clipboard API is
            simply absent. */}
        <IconButton action="copy" title={t('ch.copy')}
                    onClick={async () => push(await copyText(url)
                      ? { type: 'ok', message: t('ch.copied') }
                      : { type: 'warn', message: t('ch.copyFailed') })} />
        <IconButton action="play" title={t('ch.play')} onClick={() => setPlaying(true)} />
      </div>
      {playing && (
        <Modal onClose={() => setPlaying(false)} size="wide">
          <h3>{label}</h3>
          <div className="mono hint" style={{ wordBreak: 'break-all', marginBottom: 8 }}>{url}</div>
          <HlsPlayer url={url} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setPlaying(false)}>{t('action.close')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Row({ row, expanded, onToggle, onEdit, canManage }) {
  const { t } = useI18n();
  const c = row.channel;
  const l = row.links;

  // One word for the row, chosen for what it makes the operator do.
  const state = !row.network ? 'not-delivered'
    : row.edges.some(e => e.serving) ? 'serving'
    : row.edges.some(e => e.routed === false) ? 'partly-routed'
    : row.edges.length ? 'idle' : 'no-edges';

  return (
    <>
      <tr className="ch-row" onClick={onToggle}>
        <td>
          <div>{c.label || c.application}</div>
          <div className="mono hint">{c.application}/{c.stream}</div>
        </td>
        <td>{row.network ? row.network.name : <span className="hint">{t('ch.none')}</span>}</td>
        <td>
          {row.edges.length
            ? row.edges.map(e => (
                <span key={e.name} className={'badge ' + (e.serving ? 'live' : e.routed === false ? 'err' : '')}>
                  {e.name}
                </span>
              ))
            : <span className="hint">—</span>}
        </td>
        <td><span className={'badge ' + (state === 'serving' ? 'live' : state === 'idle' ? '' : 'warn')}>
          {t('ch.state.' + state)}
        </span></td>
        <td>{c.kind === 'test' ? <span className="badge">{t('ch.kind.test')}</span> : null}</td>
        <td>{canManage && <IconButton action="edit" onClick={(e) => { e.stopPropagation(); onEdit(c); }} />}</td>
      </tr>
      {expanded && (
        <tr><td colSpan={6} className="ch-detail">
          {l?.production
            ? <Copyable url={l.production.url} label={t('ch.production')}
                        tone={l.production.exposes === 'nothing' ? 'live' : 'warn'}
                        note={t('gw.exposes.' + l.production.exposes)} />
            : <div className="hint">{t('ch.noProduction')}{l?.productionReason
                ? ` · ${t('gw.why.' + l.productionReason)}` : ''}</div>}
          {l?.production && !l.production.protocolReady && (
            <div className="error-box">
              {t('ch.protoNotReady', { missing: (l.production.protocolMissing || []).join(', ') })}
            </div>
          )}
          {l?.production?.pathUnverified && <div className="hint">{t('ch.pathUnverified')}</div>}
          {l?.production && (
            <div className="hint">
              {t('ch.resolvedTo', { edge: l.production.resolvedTo })}
              {' · '}{t('gw.why.' + l.production.reason)}
              {/* A production link under a policy is not a fixed address, and
                  handing one to a partner as though it were is how a working
                  link stops working for somebody else. */}
              {!l.production.stable && <> · <b>{t('ch.canMove')}</b></>}
            </div>
          )}
          {l?.tests?.length > 0 && (
            <div className="inset">
              <div className="eyebrow">{t('ch.tests')}</div>
              <div className="hint">{t('ch.testsHint')}</div>
              {l.tests.map(x => (
                <Copyable key={x.edge} url={x.url} label={x.edge}
                          tone={x.routed === false ? 'err' : x.healthy ? '' : 'warn'}
                          note={x.routed === false ? t('ch.noRoute') : x.healthy ? '' : t('ch.edgeDown')} />
              ))}
            </div>
          )}
        </td></tr>
      )}
    </>
  );
}

export default function ChannelsPanel() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  const canManage = can('cdn.manage');

  const [data, setData] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState('');
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  // What the origins are publishing and nobody has made a channel of. Offered
  // rather than typed: the origin already knows these names, and a name typed
  // twice is a name eventually typed wrong.
  const [found, setFound] = useState(null);

  const load = async () => {
    try {
      const [o, n, d] = await Promise.all([
        api('/cdn/channels/overview'),
        api('/cdn/networks'),
        api('/cdn/channels/discovered').catch(() => ({ found: [], unreachable: [] })),
      ]);
      setData(o); setNetworks(n.networks || []); setFound(d); setError('');
    } catch (e) { setError(e.data?.error || e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true);
    try {
      if (edit.id) await api(`/cdn/channels/${edit.id}`, { method: 'PUT', body: edit });
      else await api('/cdn/channels', { method: 'POST', body: edit });
      setEdit(null); await load();
    } catch (e) { push({ type: 'warn', message: e.data?.code === 'channel-exists' ? t('ch.exists') : e.message }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!(await confirm({ message: t('ch.confirmDelete', { name: edit.application + '/' + edit.stream }) }))) return;
    setBusy(true);
    try { await api(`/cdn/channels/${edit.id}`, { method: 'DELETE' }); setEdit(null); await load(); }
    catch (e) { push({ type: 'warn', message: e.message }); }
    finally { setBusy(false); }
  };

  if (error) return <div className="panel error-box">{error}</div>;
  if (!data) return <div className="panel hint">{t('sd.loading')}</div>;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{t('ch.title')}</h2>
        {canManage && (
          <button onClick={() => setEdit({ application: '', stream: '', label: '', kind: 'production', protocol: 'hls', network: '' })}>
            {t('ch.add')}
          </button>
        )}
      </div>
      <div className="hint">{t('ch.intro')}</div>
      {!data.routesRead && <div className="hint">{t('ch.routesUnread')}</div>}

      {canManage && found?.found?.length > 0 && (
        <div className="inset">
          <div className="eyebrow">{t('ch.discovered')}</div>
          <div className="hint">{t('ch.discoveredHint')}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {found.found.map(f => (
              <button key={f.key} disabled={busy}
                      onClick={() => setEdit({ application: f.application, stream: f.stream,
                                               label: '', kind: 'production', protocol: 'hls', network: networks[0]?.id || '' })}>
                + {f.application}/{f.stream}
                <span className="hint"> · {f.origin}</span>
              </button>
            ))}
          </div>
          {found.unreachable?.length > 0 && (
            <div className="hint" style={{ marginTop: 6 }}>
              {t('ch.discoveryGaps')} {found.unreachable.join(', ')}
            </div>
          )}
        </div>
      )}

      <table style={{ marginTop: 12 }}>
        <thead><tr>
          <th>{t('ch.channel')}</th><th>{t('ch.network')}</th><th>{t('ch.edges')}</th>
          <th>{t('ch.stateCol')}</th><th /><th />
        </tr></thead>
        <tbody>
          {data.rows.map(r => (
            <Row key={r.channel.id} row={r} canManage={canManage}
                 expanded={open === r.channel.id}
                 onToggle={() => setOpen(o => (o === r.channel.id ? '' : r.channel.id))}
                 onEdit={(c) => setEdit({ ...c, network: c.network || '' })} />
          ))}
          {!data.rows.length && <tr><td colSpan={6} className="hint">{t('ch.empty')}</td></tr>}
        </tbody>
      </table>

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h3>{edit.id ? t('ch.editTitle') : t('ch.add')}</h3>
          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label>{t('ch.application')}</label>
              <input className="mono" value={edit.application} disabled={Boolean(edit.id)}
                     onChange={e => setEdit({ ...edit, application: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>{t('ch.stream')}</label>
              <input className="mono" value={edit.stream} disabled={Boolean(edit.id)}
                     onChange={e => setEdit({ ...edit, stream: e.target.value })} />
            </div>
          </div>
          {/* The pair is the identity, so it cannot be edited into a different
              channel; delete and create instead. */}
          {edit.id && <div className="hint">{t('ch.pairFixed')}</div>}
          <label>{t('ch.label')}</label>
          <input value={edit.label} placeholder={t('ch.labelPh')}
                 onChange={e => setEdit({ ...edit, label: e.target.value })} />
          <label>{t('ch.network')}</label>
          <select value={edit.network || ''} onChange={e => setEdit({ ...edit, network: e.target.value })}>
            <option value="">{t('ch.none')}</option>
            {networks.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          {/* What the viewer is handed a link to. Nimble already emits HLS and
              DASH from one input — the fleet log shows both in the same second
              — so this costs nothing on the server; it is which URL to give
              out. LL-HLS is different and says so. */}
          <label>{t('ch.protocol')}</label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {['hls', 'llhls', 'dash'].map(pr => (
              <button key={pr} className={'tagchip' + (edit.protocol === pr ? ' on' : '')}
                      onClick={() => setEdit({ ...edit, protocol: pr })}>{t('ch.proto.' + pr)}</button>
            ))}
          </div>
          <div className="hint">{t('ch.proto.' + (edit.protocol || 'hls') + '.note')}</div>

          <label>{t('ch.kindLabel')}</label>
          <div className="row" style={{ gap: 6 }}>
            {['production', 'test'].map(k => (
              <button key={k} className={'tagchip' + (edit.kind === k ? ' on' : '')}
                      onClick={() => setEdit({ ...edit, kind: k })}>{t('ch.kind.' + k)}</button>
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            {edit.id ? <IconButton action="remove" danger disabled={busy} onClick={remove} /> : <span />}
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => setEdit(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !edit.application.trim() || !edit.stream.trim()}
                      onClick={save}>{t('action.save')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
