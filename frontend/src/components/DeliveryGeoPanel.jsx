import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import IconButton from './IconButton.jsx';

// Where the fleet physically is, and the database that answers it.
//
// Its own tab rather than a block above the topology: deciding which box is an
// edge and checking that a box is in the country you think it is are different
// jobs, done at different times, and stacking them made the page start with
// fourteen rows of geography before the thing the operator came for.
// CC BY 4.0 requires a link back to db-ip.com on any page that shows results
// from the database. It is a licence term, not a courtesy, which is why
// audit:attribution fails the build when it goes missing.
function DbIpAttribution() {
  const { t } = useI18n();
  return (
    <div className="hint attribution">
      {t('cdn.geoSource')}{' '}
      <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">IP Geolocation by DB-IP</a>
      {' · '}
      <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>
    </div>
  );
}

function GeoDbPanel({ status, onUpdate, busy, canManage }) {
  const { t } = useI18n();
  const [edition, setEdition] = useState('country');
  useEffect(() => { if (status?.edition) setEdition(status.edition); }, [status?.edition]);
  if (!status) return null;
  const ed = status.editions?.find(e => e.id === edition);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{t('cdn.geoDb')}</h2>
      {status.present ? (
        <div className="hint">
          {t('cdn.geoDbLoaded', {
            edition: status.editions?.find(e => e.id === status.edition)?.label || status.edition,
            release: status.release || '—',
            size: (status.size / 1e6).toFixed(1),
          })}
          {!status.hasCoordinates && <> · {t('cdn.geoNoCoords')}</>}
        </div>
      ) : (
        <div className="hint">{t('cdn.geoDbMissing')}</div>
      )}

      {canManage && (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <select value={edition} onChange={e => setEdition(e.target.value)} style={{ maxWidth: 260 }}>
            {status.editions?.map(e => (
              <option key={e.id} value={e.id}>
                {e.label} · {(e.approxBytes / 1e6).toFixed(0)} MB · {t('cdn.accuracy')} {e.accuracyIndex}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy} onClick={() => onUpdate(edition)}>
            {busy ? '…' : t('cdn.geoDbUpdate')}
          </button>
          {/* The trade-off stated where the choice is made, not in a manual.
              City is 15x larger and DB-IP rates it LESS accurate; it earns its
              size only if approximate coordinates are wanted. */}
          <span className="hint">
            {ed?.hasCoordinates ? t('cdn.edCity') : t('cdn.edCountry')}
          </span>
        </div>
      )}
      <DbIpAttribution />
    </div>
  );
}

// One server's location, with both provenances visible. `source` covers the
// country, `coordsSource` the coordinates, separately — they do not arrive
// together, and a marker whose origin nobody can account for is worse than no
// marker.
function GeoCell({ server, onEdit, onResolve, canManage, busy }) {
  const { t } = useI18n();
  const g = server.geo || {};
  const has = Boolean(g.countryCode);
  return (
    <div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        {has ? (
          <>
            <span className="mono">{g.countryCode}</span>
            <span>{g.city || g.countryName}</span>
            <span className={'badge' + (g.source === 'manual' ? '' : ' dim')}>
              {t(g.source === 'manual' ? 'cdn.manual' : 'cdn.auto')}
            </span>
          </>
        ) : <span className="hint">{t('cdn.geoUnknown')}</span>}
      </div>
      <div className="hint" style={{ fontSize: 11 }}>
        {g.lat != null
          ? <>{g.lat.toFixed(3)}, {g.lon.toFixed(3)} · {t(g.coordsSource === 'manual' ? 'cdn.manual' : 'cdn.auto')}</>
          : t('cdn.noCoords')}
        {g.resolvedIp && <> · {t('cdn.via')} <span className="mono">{g.resolvedIp}</span></>}
      </div>
      {canManage && (
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button disabled={busy} onClick={() => onResolve(server)}>{t('cdn.resolve')}</button>
          <IconButton action="edit" disabled={busy} onClick={() => onEdit(server)} />
        </div>
      )}
    </div>
  );
}


export default function DeliveryGeoPanel({ servers, onServersChanged }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const canManage = can('cdn.manage');
  const [geoDb, setGeoDb] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [geoEdit, setGeoEdit] = useState(null);

  const load = async () => {
    try { setGeoDb(await api('/geoip')); setError(''); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const act = async (fn, ok) => {
    setBusy(true); setError('');
    try { await fn(); if (ok) push({ type: 'ok', message: ok }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const updateDb = (wanted) => act(async () => {
    const r = await api('/geoip/update', { method: 'POST', body: { edition: wanted } });
    if (!r.ok) throw new Error(r.error || 'update failed');
  }, t('cdn.geoDbUpdated'));

  const resolveOne = (server) => act(async () => {
    const r = await api(`/servers/${server.id}/geo/resolve`, { method: 'POST' });
    if (!r.coordinatesAvailable) push({ type: 'info', message: t('cdn.resolvedNoCoords') });
    onServersChanged?.();
  });

  const resolveAll = () => act(async () => {
    let done = 0, failed = 0;
    for (const s of servers) {
      try { await api(`/servers/${s.id}/geo/resolve`, { method: 'POST' }); done++; }
      catch { failed++; }
    }
    onServersChanged?.();
    push({ type: failed ? 'warn' : 'ok', message: t('cdn.resolvedAll', { done, failed }) });
  });

  const saveGeo = () => act(async () => {
    await api(`/servers/${geoEdit.id}/geo`, {
      method: 'PUT',
      body: {
        countryCode: geoEdit.countryCode, countryName: geoEdit.countryName, city: geoEdit.city,
        lat: geoEdit.lat === '' ? null : geoEdit.lat, lon: geoEdit.lon === '' ? null : geoEdit.lon,
      },
    });
    setGeoEdit(null);
    onServersChanged?.();
  });

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <GeoDbPanel status={geoDb} onUpdate={updateDb} busy={busy} canManage={canManage} />

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('cdn.geography')}</h2>
        <div className="hint">{t('cdn.geographyHint')}</div>
        {canManage && (
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy || !geoDb?.present} onClick={resolveAll}>{t('cdn.resolveAll')}</button>
          </div>
        )}
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>{t('cdn.server')}</th><th>{t('cdn.host')}</th><th>{t('cdn.location')}</th></tr></thead>
          <tbody>
            {servers.map(s => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{s.host}</td>
                <td><GeoCell server={s} canManage={canManage} busy={busy}
                             onResolve={resolveOne}
                             onEdit={sv => setGeoEdit({
                               id: sv.id, name: sv.name,
                               countryCode: sv.geo?.countryCode || '', countryName: sv.geo?.countryName || '',
                               city: sv.geo?.city || '',
                               lat: sv.geo?.lat ?? '', lon: sv.geo?.lon ?? '',
                             })} /></td>
              </tr>
            ))}
            {!servers.length && <tr><td colSpan={3} className="hint">{t('ds.noServers')}</td></tr>}
          </tbody>
        </table>
      </div>

      {geoEdit && (
        <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setGeoEdit(null)}>
          <div className="modal">
            <h3>{t('cdn.editGeo', { name: geoEdit.name })}</h3>
            <p className="hint">{t('cdn.editGeoHint')}</p>
            <label>{t('cdn.countryCode')}</label>
            <input className="mono" maxLength={2} value={geoEdit.countryCode}
                   onChange={e => setGeoEdit({ ...geoEdit, countryCode: e.target.value.toUpperCase() })} />
            <label>{t('cdn.countryName')}</label>
            <input value={geoEdit.countryName} onChange={e => setGeoEdit({ ...geoEdit, countryName: e.target.value })} />
            <label>{t('cdn.city')}</label>
            <input value={geoEdit.city} onChange={e => setGeoEdit({ ...geoEdit, city: e.target.value })} />
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label>{t('cdn.lat')}</label>
                <input className="mono" value={geoEdit.lat} onChange={e => setGeoEdit({ ...geoEdit, lat: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t('cdn.lon')}</label>
                <input className="mono" value={geoEdit.lon} onChange={e => setGeoEdit({ ...geoEdit, lon: e.target.value })} />
              </div>
            </div>
            <div className="hint">{t('cdn.coordsPairHint')}</div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => setGeoEdit(null)}>{t('action.cancel')}</button>
              <button className="primary" onClick={saveGeo} disabled={busy}>{t('action.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
