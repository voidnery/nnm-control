import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import LogWindow from '../components/LogWindow.jsx';
import { copyText } from '../lib/clipboard.js';

// iter10 m5 — operator-built arrangements of log windows.
//
// The windows themselves are the same component the categorical page renders;
// what is new here is that an arrangement can be saved, and that it can be
// given a link which opens without a panel login.
//
// That link deserves its own care, and gets it: sharing is off until someone
// turns it on, the token is stored only as a hash, and the public route reads
// every filter from the database rather than the URL — so a link to a
// transcoder view cannot be edited into a query for the whole warehouse.

const CATS = ['all', 'transcoder', 'srt', 'rtmp', 'playback', 'ingest', 'dvr', 'core', 'other'];
const RANGES = ['15m', '1h', '6h', '24h', 'all'];
const newId = () => `w${Math.random().toString(36).slice(2, 9)}`;

export default function LogDashboardsPage() {
  const { t } = useI18n();
  const { push } = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState(null);
  const [servers, setServers] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [dash, setDash] = useState(null);
  const [editing, setEditing] = useState(null);      // window being edited
  const [share, setShare] = useState(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  // Adding a window used to always produce "Everything", leaving the operator
  // to find the edit control inside a window that showed the whole firehose.
  // The choice belongs to the action.
  const [newCat, setNewCat] = useState('transcoder');
  // window.prompt does not exist in every browsing context and cannot be
  // styled, translated or cancelled cleanly. The click gate found it.
  const [creating, setCreating] = useState(null);

  const loadList = useCallback(async () => {
    try { setList(await api('/log-dashboards')); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { loadList(); api('/servers').then(setServers).catch(() => {}); }, [loadList]);

  const open = async (id) => {
    setOpenId(id); setDash(null); setDirty(false);
    try {
      const d = await api(`/log-dashboards/${id}`);
      setDash({ columns: 2, refreshSec: 0, ...d, windows: Array.isArray(d?.windows) ? d.windows : [] });
    } catch (e) { setError(e.message); }
  };

  const create = async (name) => {
    if (!name?.trim()) return;
    try {
      const { id } = await api('/log-dashboards', {
        method: 'POST',
        body: { name: name.trim(), columns: 2, windows: [
          { id: newId(), category: 'transcoder', range: '1h', mode: 'grouped', height: 240 },
          { id: newId(), category: 'srt', levels: ['E'], range: '1h', mode: 'grouped', height: 240 },
        ] },
      });
      setCreating(null);
      await loadList();
      open(id);
    } catch (e) { push({ type: 'error', message: e.message }); }
  };

  const save = async () => {
    try {
      await api(`/log-dashboards/${openId}`, { method: 'PUT', body: dash });
      setDirty(false);
      push({ type: 'ok', message: t('dash.saved') });
      loadList();
    } catch (e) { push({ type: 'error', message: e.message }); }
  };

  const remove = async (d) => {
    if (!(await confirm(t('dash.confirmDelete', { name: d.name })))) return;
    await api(`/log-dashboards/${d.id}`, { method: 'DELETE' });
    if (openId === d.id) { setOpenId(null); setDash(null); }
    loadList();
  };

  const patchWindow = (id, patch) => {
    setDash(d => ({ ...d, windows: d.windows.map(w => (w.id === id ? { ...w, ...patch } : w)) }));
    setDirty(true);
  };
  const addWindow = (category = newCat) => {
    setDash(d => ({ ...d, windows: [...d.windows, {
      id: newId(), category, range: '1h', mode: 'grouped', height: 240,
      levels: [], subs: [], query: '', span: 1,
    }] }));
    setDirty(true);
  };
  const dropWindow = (id) => {
    setDash(d => ({ ...d, windows: d.windows.filter(w => w.id !== id) }));
    setDirty(true);
  };
  const move = (id, dir) => {
    setDash(d => {
      const i = d.windows.findIndex(w => w.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.windows.length) return d;
      const ws = d.windows.slice();
      [ws[i], ws[j]] = [ws[j], ws[i]];
      return { ...d, windows: ws };
    });
    setDirty(true);
  };

  const issueLink = async (days) => {
    try {
      const r = await api(`/log-dashboards/${openId}/share`, { method: 'POST', body: { expiresDays: days } });
      setShare(r);
      open(openId);
      loadList();
    } catch (e) { push({ type: 'error', message: e.message }); }
  };
  const revoke = async () => {
    if (!(await confirm(t('dash.confirmRevoke')))) return;
    await api(`/log-dashboards/${openId}/share`, { method: 'DELETE' });
    setShare(null);
    open(openId);
    loadList();
  };

  if (!list) return <div className="hint">{t('sd.loading')}</div>;

  // ---- list ----
  if (!openId) {
    return (
      <div>
        <h1>{t('dash.title')}</h1>
        <div className="sub">{t('dash.sub')}</div>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="primary" onClick={() => setCreating('')}>{t('dash.create')}</button>
        </div>
        {creating !== null && (
          <Modal onClose={() => setCreating(null)}>
            <h3>{t('dash.create')}</h3>
            <label>{t('dash.namePrompt')}</label>
            <input autoFocus value={creating} onChange={e => setCreating(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') create(creating); }} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => setCreating(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={!creating.trim()} onClick={() => create(creating)}>
                {t('action.create')}
              </button>
            </div>
          </Modal>
        )}
        <div className="panel">
          <table>
            <thead><tr>
              <th>{t('dash.name')}</th><th style={{ width: 90 }}>{t('dash.windows')}</th>
              <th style={{ width: 200 }}>{t('dash.link')}</th><th style={{ width: 160 }}></th>
            </tr></thead>
            <tbody>
              {list.map(d => (
                <tr key={d.id} className="tally">
                  {/* The name is the thing you came here to open, so it opens. */}
                  <td>
                    <button className="linklike" style={{ padding: 0, fontWeight: 600, fontSize: 'inherit' }}
                            onClick={() => open(d.id)}>{d.name}</button>
                    {d.description && <div className="hint">{d.description}</div>}
                  </td>
                  <td className="mono">{d.windows}</td>
                  <td>
                    {d.shareEnabled
                      ? <span className="badge live">{t('dash.shared')}{d.shareHits ? ` · ${d.shareHits}` : ''}</span>
                      : <span className="hint">{t('dash.notShared')}</span>}
                  </td>
                  <td>
                    {/* Apart, and with the destructive one last: they were
                        touching, and one of them deletes a dashboard. */}
                    <div className="row" style={{ gap: 14, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button onClick={() => open(d.id)}>{t('action.open')}</button>
                      <button className="danger" onClick={() => remove(d)}>{t('action.delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={4} className="hint">{t('dash.none')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (!dash) return <div className="hint">{t('sd.loading')}</div>;

  // ---- one dashboard ----
  return (
    <div>
      {/* Three jobs, three places: get out, change the layout, save. Stacked
          in one corner they read as a pile of controls with no order to them. */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <button onClick={() => { setOpenId(null); setDash(null); }}>← {t('dash.back')}</button>
          <h1 style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dash.name}</h1>
        </div>
        <div className="row" style={{ gap: 20, flexShrink: 0 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className="hint">{t('dash.addLabel')}</span>
            <Select value={newCat} onChange={setNewCat} style={{ width: 160 }}
                    options={CATS.map(c => ({ value: c, label: t(`logs.cat.${c}`) }))} />
            <button onClick={() => addWindow()}>+ {t('dash.addWindow')}</button>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className="hint">{t('dash.layoutLabel')}</span>
            <Select value={String(dash.columns)} style={{ width: 120 }}
                    onChange={v => { setDash({ ...dash, columns: Number(v) }); setDirty(true); }}
                    options={[1, 2, 3, 4].map(n => ({ value: String(n), label: t('dash.columns', { n }) }))} />
          </div>
          <button className={dirty ? 'primary' : ''} disabled={!dirty} onClick={save}>
            {dirty ? t('dash.saveDirty') : t('action.save')}
          </button>
        </div>
      </div>
      {dash.description && <div className="sub">{dash.description}</div>}

      {/* Sharing is its own act, with its own warning. It is the moment
          production logs become readable without a password. */}
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <b>{t('dash.linkTitle')}</b>
            <div className="hint">{t('dash.linkWarn')}</div>
          </div>
          <div className="row">
            {dash.shareEnabled
              ? <>
                  <span className="hint">
                    {dash.shareExpiresAt ? t('dash.expires', { at: new Date(dash.shareExpiresAt).toLocaleString() }) : t('dash.noExpiry')}
                    {dash.shareHits ? ` · ${t('dash.hits', { n: dash.shareHits })}` : ''}
                  </span>
                  <button onClick={() => issueLink(0)}>{t('dash.reissue')}</button>
                  <button className="danger" onClick={revoke}>{t('dash.revoke')}</button>
                </>
              : <>
                  <button onClick={() => issueLink(7)}>{t('dash.issue7')}</button>
                  <button onClick={() => issueLink(0)}>{t('dash.issueNoExpiry')}</button>
                </>}
          </div>
        </div>
        {share && (
          <div style={{ marginTop: 8 }}>
            <div className="hint">{t('dash.linkOnce')}</div>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input readOnly className="mono" style={{ flex: 1 }} value={share.url} onFocus={e => e.target.select()} />
              <button onClick={async () => push(await copyText(share.url)
                ? { type: 'ok', message: t('srt.copied') }
                : { type: 'error', message: t('copy.failed') })}>{t('srt.copy')}</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${dash.columns}, minmax(0, 1fr))`, gap: 10, marginTop: 10 }}>
        {dash.windows.map((w, i) => (
          <div key={w.id} style={{ gridColumn: `span ${Math.min(w.span || 1, dash.columns)}`, minWidth: 0 }}>
            <div className="row" style={{ gap: 4, marginBottom: 2, justifyContent: 'flex-end' }}>
              <button style={{ padding: '1px 6px', fontSize: 11 }} disabled={i === 0}
                      title={t('dash.moveLeft')} onClick={() => move(w.id, -1)}>◀</button>
              <button style={{ padding: '1px 6px', fontSize: 11 }} disabled={i === dash.windows.length - 1}
                      title={t('dash.moveRight')} onClick={() => move(w.id, 1)}>▶</button>
            </div>
            <LogWindow
              key={`${w.id}-${w.category}-${w.range}-${(w.levels || []).join('')}-${w.serverId}`}
              title={w.title || t(`logs.cat.${w.category}`)}
              category={w.category} serverId={w.serverId}
              initialLevels={w.levels || []} initialRange={w.range} initialQuery={w.query || ''}
              height={w.height} refreshMs={dash.refreshSec ? dash.refreshSec * 1000 : 0}
              onEdit={() => setEditing({ ...w })}
              onRemove={() => dropWindow(w.id)}
            />
          </div>
        ))}
        {dash.windows.length === 0 && <div className="panel hint">{t('dash.empty')}</div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h3>{t('dash.editWindow')}</h3>
          <label>{t('dash.wTitle')}</label>
          <input value={editing.title || ''} onChange={e => setEditing({ ...editing, title: e.target.value })} />
          <label>{t('logs.subsystem')}</label>
          <Select value={editing.category} onChange={v => setEditing({ ...editing, category: v })}
                  options={CATS.map(c => ({ value: c, label: t(`logs.cat.${c}`) }))} />
          <label>{t('logs.server')}</label>
          <Select value={editing.serverId || ''} onChange={v => setEditing({ ...editing, serverId: v })}
                  options={[{ value: '', label: t('logs.allServers') }, ...servers.map(s => ({ value: s.id, label: s.name }))]} />
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <div><label>{t('dash.wRange')}</label>
              <Select value={editing.range} onChange={v => setEditing({ ...editing, range: v })}
                      options={RANGES.map(r => ({ value: r, label: t(`logs.range.${r}`) }))} /></div>
            <div><label>{t('dash.wHeight')}</label>
              <input type="number" value={editing.height} onChange={e => setEditing({ ...editing, height: Number(e.target.value) })} /></div>
            <div><label>{t('dash.wSpan')}</label>
              <input type="number" min={1} max={4} value={editing.span || 1}
                     onChange={e => setEditing({ ...editing, span: Number(e.target.value) })} /></div>
          </div>
          <label>{t('logs.level')}</label>
          <div className="row" style={{ gap: 4 }}>
            {['E', 'W', 'I', 'V', 'D'].map(l => (
              <button key={l} className={(editing.levels || []).includes(l) ? 'primary' : ''}
                      onClick={() => setEditing({
                        ...editing,
                        levels: (editing.levels || []).includes(l)
                          ? editing.levels.filter(x => x !== l)
                          : [...(editing.levels || []), l],
                      })}>{l}</button>
            ))}
          </div>
          <label>{t('dash.wQuery')}</label>
          <input className="mono" value={editing.query || ''} onChange={e => setEditing({ ...editing, query: e.target.value })} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setEditing(null)}>{t('action.cancel')}</button>
            <button className="primary" onClick={() => { patchWindow(editing.id, editing); setEditing(null); }}>
              {t('action.apply')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
