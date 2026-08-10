import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import IconButton from './IconButton.jsx';
import DeliveryRoutesPanel from './DeliveryRoutesPanel.jsx';

// The delivery network: which box is an ingest, an origin, an edge, and where
// each one physically is.
//
// Nimble has no notion of "this server is an edge" — a box becomes one because
// somebody pointed a route at an origin, and the only record of that intent
// used to live in whoever set it up. This is where the intent gets written
// down, so that later milestones can compare it against what the servers
// actually report instead of drawing a topology from configuration and calling
// it the truth.
const ROLE_ORDER = ['ingest', 'origin', 'mid', 'edge', 'gateway'];

// CC BY 4.0 requires a link back to db-ip.com on any page that shows results
// from the database. It is a licence term, not a courtesy, and audit:attribution
// fails the build if it goes missing.

export default function DeliveryNetworkPanel({ servers, onServersChanged }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  const canManage = can('cdn.manage');

  const [networks, setNetworks] = useState(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);      // local copy of the nodes being edited

  const load = async () => {
    setError('');
    try {
      const n = await api('/cdn/networks');
      // Defensive on purpose: a page that renders nothing at all because one
      // endpoint answered a shape it did not expect is worse than a page that
      // shows an empty network list.
      const list = Array.isArray(n?.networks) ? n.networks : [];
      setNetworks(list);
      setSelected(s => s || list[0]?.id || '');
    } catch (e) { setError(e.message); setNetworks([]); }
  };
  useEffect(() => { load(); }, []);

  const net = useMemo(() => networks?.find(n => n.id === selected) || null, [networks, selected]);
  useEffect(() => { setDraft(net ? net.nodes.map(x => ({ ...x })) : null); }, [selected, networks]);

  const serverById = useMemo(() => new Map(servers.map(s => [s.id, s])), [servers]);
  const dirty = useMemo(
    () => Boolean(net && draft && JSON.stringify(draft) !== JSON.stringify(net.nodes)),
    [net, draft]);

  const act = async (fn, ok) => {
    setBusy(true); setError('');
    try { await fn(); if (ok) push({ type: 'ok', message: ok }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const createNetwork = () => act(async () => {
    const n = await api('/cdn/networks', { method: 'POST', body: { name: t('cdn.newName'), audience: 'internal' } });
    setSelected(n.id);
  });

  const saveNodes = () => act(async () => {
    const r = await api(`/cdn/networks/${net.id}`, { method: 'PUT', body: { nodes: draft } });
    if (r.problems?.length) {
      push({ type: 'warn', message: t('cdn.savedWithWarnings', { n: r.problems.length }) });
    }
  }, t('cdn.saved'));

  const setAudience = (audience) => act(async () => {
    await api(`/cdn/networks/${net.id}`, { method: 'PUT', body: { audience } });
  });

  const removeNetwork = () => act(async () => {
    if (!(await confirm({ message: t('cdn.confirmDelete', { name: net.name }) }))) return;
    await api(`/cdn/networks/${net.id}`, { method: 'DELETE' });
    setSelected('');
  });

  const addNode = (serverId) => setDraft(d => [...d, {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    server: serverId, role: 'edge', upstream: [], weight: 100, enabled: true, notes: '',
  }]);
  const patchNode = (id, patch) => setDraft(d => d.map(n => (n.id === id ? { ...n, ...patch } : n)));
  const dropNode = (id) => setDraft(d => d.filter(n => n.id !== id).map(n => ({
    ...n, upstream: n.upstream.filter(u => u !== id),
  })));

  if (networks === null) return <div className="hint">{t('ds.loading')}</div>;

  const inNetwork = new Set((draft || []).map(n => n.server));
  const free = servers.filter(s => !inNetwork.has(s.id));
  // Upstream options are filtered by role so an impossible edge cannot be
  // picked in the first place. The API refuses it too — the dropdown is a
  // convenience, not the guarantee.
  const upstreamFor = (node) => (draft || []).filter(o => o.id !== node.id &&
    ({ origin: ['ingest'], mid: ['origin'], edge: ['origin', 'mid'], ingest: [], gateway: [] }[node.role] || []).includes(o.role));

  return (
    <div>
      {error && <div className="error-box">{error}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{t('cdn.networks')}</h2>
          <div className="row" style={{ gap: 8 }}>
            <select value={selected} onChange={e => setSelected(e.target.value)} style={{ maxWidth: 260 }}>
              <option value="">{t('cdn.pickNetwork')}</option>
              {networks.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            {canManage && <button onClick={createNetwork} disabled={busy}>{t('cdn.newNetwork')}</button>}
          </div>
        </div>

        {!net ? (
          <div className="hint" style={{ marginTop: 8 }}>{t('cdn.noNetwork')}</div>
        ) : (
          <>
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span className="hint">{t('cdn.audience')}</span>
              {['internal', 'public'].map(a => (
                <button key={a} className={'tagchip' + (net.audience === a ? ' on' : '')}
                        disabled={!canManage || busy} onClick={() => setAudience(a)}>
                  {t('cdn.audience.' + a)}
                </button>
              ))}
              <span className="hint">{t('cdn.audienceHint')}</span>
            </div>

            <table style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>{t('cdn.server')}</th><th>{t('cdn.role')}</th>
                  <th>{t('cdn.upstream')}</th><th>{t('cdn.where')}</th><th />
                </tr>
              </thead>
              <tbody>
                {(draft || []).map(n => {
                  const s = serverById.get(n.server);
                  const g = s?.geo || {};
                  return (
                    <tr key={n.id}>
                      <td>{s?.name || <span className="hint">{t('cdn.goneServer')}</span>}</td>
                      <td>
                        <select value={n.role} disabled={!canManage}
                                onChange={e => patchNode(n.id, { role: e.target.value, upstream: [] })}>
                          {ROLE_ORDER.map(r => <option key={r} value={r}>{t('cdn.role.' + r)}</option>)}
                        </select>
                      </td>
                      <td>
                        {upstreamFor(n).length === 0
                          ? <span className="hint">{n.role === 'ingest' || n.role === 'gateway' ? '—' : t('cdn.noUpstreamOption')}</span>
                          : upstreamFor(n).map(o => (
                              <label key={`${n.id}:${o.id}`} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: 12 }}>
                                <input type="checkbox" disabled={!canManage}
                                       checked={n.upstream.includes(o.id)}
                                       onChange={() => patchNode(n.id, {
                                         upstream: n.upstream.includes(o.id)
                                           ? n.upstream.filter(x => x !== o.id) : [...n.upstream, o.id],
                                       })} />
                                {serverById.get(o.server)?.name || o.id} <span className="hint">{t('cdn.role.' + o.role)}</span>
                              </label>
                            ))}
                      </td>
                      <td className="hint" style={{ fontSize: 12 }}>
                        {g.countryCode ? `${g.countryCode} ${g.city || ''}` : t('cdn.geoUnknown')}
                      </td>
                      <td>{canManage && <IconButton action="remove" danger onClick={() => dropNode(n.id)} />}</td>
                    </tr>
                  );
                })}
                {!(draft || []).length && <tr><td colSpan={5} className="hint">{t('cdn.emptyNetwork')}</td></tr>}
              </tbody>
            </table>

            {canManage && (
              <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value="" disabled={!free.length} onChange={e => e.target.value && addNode(e.target.value)}
                        style={{ maxWidth: 240 }}>
                  <option value="">{free.length ? t('cdn.addNode') : t('cdn.allAdded')}</option>
                  {free.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                <button onClick={() => setDraft(net.nodes.map(x => ({ ...x })))} disabled={!dirty}>{t('action.reset')}</button>
                <button className="primary" onClick={saveNodes} disabled={busy || !dirty}>{t('action.save')}</button>
                <button onClick={removeNetwork} disabled={busy}>{t('cdn.deleteNetwork')}</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* The plan is computed from what is stored, not from what is on screen.
          Pressing "show plan" over unsaved edits used to answer "this network
          has no edges" about a topology the operator could see in front of
          them. */}
      {net && dirty && <div className="panel hint">{t('cdn.unsavedFirst')}</div>}
      {net && <DeliveryRoutesPanel network={net} dirty={dirty} />}

    </div>
  );
}
