import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import IconButton from './IconButton.jsx';
import Modal from './Modal.jsx';
import DeliveryRoutesPanel from './DeliveryRoutesPanel.jsx';
import ProbePanel from './ProbePanel.jsx';
import GatewayPanel from './GatewayPanel.jsx';
import ConfigOverviewPanel from './ConfigOverviewPanel.jsx';
import NetworkSetup from './NetworkSetup.jsx';

// Lazy, and for two reasons rather than one. three.js is comparable in size to
// the rest of the bundle put together, and the country polygons are another
// 155 kB — imported statically they land in the main chunk and every page of
// the panel pays for a globe on one tab of one page.
const GlobePanel = lazy(() => import('./GlobePanel.jsx'));

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
  const [draft, setDraft] = useState(null);
  const [newNet, setNewNet] = useState(null);   // the create dialog, or null
  // Second-level tabs inside a network. Topology, delivery and measurement are
  // three jobs done at different moments — building it, running it, checking
  // it — and stacking them vertically meant the page grew downwards on every
  // button press until nothing could be held in view at once.
  const [tab, setTab] = useState('setup');
  // The derived plan drives the step states. Held here rather than inside the
  // steps so that the tools below them see the same numbers.
  const [derived, setDerived] = useState(null);
  const loadDerived = async () => {
    if (!selected) { setDerived(null); return; }
    try { setDerived(await api(`/cdn/networks/${selected}/derived`)); }
    catch { setDerived(null); }
  };
  useEffect(() => { loadDerived(); }, [selected, networks]);      // local copy of the nodes being edited

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

  // Creating a network used to POST a placeholder name with no way to change
  // it — the field to rename it did not exist anywhere on the page, so every
  // network was called "New network" forever. The properties that identify a
  // network are asked for once, in a dialog, before it exists.
  const createNetwork = () => act(async () => {
    const n = await api('/cdn/networks', {
      method: 'POST',
      body: { name: newNet.name.trim(), description: newNet.description, audience: newNet.audience },
    });
    setNewNet(null);
    setSelected(n.id);
  }, t('cdn.created'));

  const renameNetwork = () => act(async () => {
    await api(`/cdn/networks/${net.id}`, {
      method: 'PUT',
      body: { name: newNet.name.trim(), description: newNet.description, audience: newNet.audience },
    });
    setNewNet(null);
  }, t('cdn.saved'));

  const saveNodes = () => act(async () => {
    const r = await api(`/cdn/networks/${net.id}`, { method: 'PUT', body: { nodes: draft } });
    if (r.problems?.length) {
      push({ type: 'warn', message: t('cdn.savedWithWarnings', { n: r.problems.length }) });
    }
  }, t('cdn.saved'));

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

  // The topology table, built here so it keeps the draft state it edits, and
  // handed to the steps that need it. Steps one and two are two readings of
  // the same table — who is in the network, and what each takes content from —
  // so they share it rather than duplicating it.
  const inNetwork = new Set((draft || []).map(n => n.server));
  const free = servers.filter(s => !inNetwork.has(s.id));
  // Upstream options are filtered by role so an impossible edge cannot be
  // picked in the first place. The API refuses it too — the dropdown is a
  // convenience, not the guarantee.
  const upstreamFor = (node) => (draft || []).filter(o => o.id !== node.id &&
    ({ origin: ['ingest'], mid: ['origin'], edge: ['origin', 'mid'], ingest: [], gateway: [] }[node.role] || []).includes(o.role));

  const topologyUI = (
    <>
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
  );

  if (networks === null) return <div className="hint">{t('ds.loading')}</div>;


  return (
    <div>
      {error && <div className="error-box">{error}</div>}

      {/* Which network, and what it is — one line. Everything that edits these
          properties lives in the dialog behind the pencil. */}
      <div className="panel" style={{ paddingBottom: 8 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={selected} onChange={e => setSelected(e.target.value)} style={{ maxWidth: 260 }}>
            <option value="">{t('cdn.pickNetwork')}</option>
            {networks.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          {net && <span className="badge">{t('cdn.audience.' + net.audience)}</span>}
          {net?.description && <span className="hint">{net.description}</span>}
          <div style={{ flex: 1 }} />
          {canManage && net && (
            <IconButton action="edit"
                        onClick={() => setNewNet({ mode: 'edit', name: net.name, description: net.description || '', audience: net.audience })} />
          )}
          {canManage && (
            <button onClick={() => setNewNet({ mode: 'create', name: '', description: '', audience: 'internal' })}
                    disabled={busy}>{t('cdn.newNetwork')}</button>
          )}
        </div>

        {net && (
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            {['setup', 'overview', 'probes', 'globe'].map(v => (
              <button key={v} className={'tagchip' + (tab === v ? ' on' : '')} onClick={() => setTab(v)}>
                {t('cdn.tab.' + v)}
                {/* Unsaved topology is the one thing worth carrying across
                    tabs: the plan is computed from what is stored, and an
                    operator on another tab has no way to see that it is not. */}
                {v === 'topology' && dirty && <span className="badge warn" style={{ marginLeft: 6 }}>•</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {!net ? (
        <div className="panel hint">{t('cdn.noNetwork')}</div>
      ) : (
        <>
          {/* The six steps, with the existing panels slotted into them. The
              panels did not change; where they are did. */}
          {tab === 'setup' && (
            <NetworkSetup network={net} servers={servers} derived={derived} onReload={loadDerived}
                          children={{
                            members: topologyUI,
                            upstreams: topologyUI,
                            channels: <DeliveryRoutesPanel network={net} servers={servers} dirty={dirty} only="channels" />,
                            nimble: <DeliveryRoutesPanel network={net} servers={servers} dirty={dirty} only="nimble" />,
                            links: <GatewayPanel network={net} servers={servers} />,
                            verify: <DeliveryRoutesPanel network={net} servers={servers} dirty={dirty} only="verify" />,
                          }} />
          )}

          {tab === 'overview' && <ConfigOverviewPanel network={net} />}

          {tab === 'probes' && <ProbePanel network={net} />}
          {tab === 'globe' && (
            <Suspense fallback={<div className="panel hint">{t('globe.loading')}</div>}>
              <GlobePanel network={net} servers={servers} />
            </Suspense>
          )}
        </>
      )}

      {/* The plan is computed from what is stored, not from what is on screen.
          Pressing "show plan" over unsaved edits used to answer "this network
          has no edges" about a topology the operator could see in front of
          them. */}
      {newNet && (
        <Modal onClose={() => setNewNet(null)}>
          <h3>{t(newNet.mode === 'create' ? 'cdn.newNetwork' : 'cdn.editNetwork')}</h3>
          <label>{t('cdn.netName')}</label>
          <input autoFocus value={newNet.name} placeholder={t('cdn.netNamePh')}
                 onChange={e => setNewNet({ ...newNet, name: e.target.value })} />
          <label>{t('cdn.netDescription')}</label>
          <input value={newNet.description}
                 onChange={e => setNewNet({ ...newNet, description: e.target.value })} />
          <label>{t('cdn.audience')}</label>
          <div className="row" style={{ gap: 6 }}>
            {['internal', 'public'].map(a => (
              <button key={a} className={'tagchip' + (newNet.audience === a ? ' on' : '')}
                      onClick={() => setNewNet({ ...newNet, audience: a })}>
                {t('cdn.audience.' + a)}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 4 }}>{t('cdn.audienceHint')}</div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setNewNet(null)}>{t('action.cancel')}</button>
            <button className="primary" disabled={busy || !newNet.name.trim()}
                    onClick={newNet.mode === 'create' ? createNetwork : renameNetwork}>
              {t(newNet.mode === 'create' ? 'action.create' : 'action.save')}
            </button>
          </div>
        </Modal>
      )}


    </div>
  );
}
