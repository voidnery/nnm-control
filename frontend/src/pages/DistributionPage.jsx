import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import DeliveryNetworkPanel from '../components/DeliveryNetworkPanel.jsx';
import DeliveryGeoPanel from '../components/DeliveryGeoPanel.jsx';
import ChannelsPanel from '../components/ChannelsPanel.jsx';

// Delivery: networks, the channels they carry, and where the servers are.
//
// The WMSPanel account objects used to live here as a fourth tab and have
// moved to their own page under Infrastructure. They are still read by these
// screens — the "this edge will not cache" finding comes from them — but an
// operator building a network no longer walks past them to get here.

function ServerPicker({ servers, value, onChange }) {
  const { t } = useI18n();
  const toggle = (wsid) => {
    const next = new Set(value);
    if (next.has(wsid)) next.delete(wsid); else next.add(wsid);
    onChange([...next]);
  };
  const mapped = servers.filter(s => s.wmspanelServerId);
  return (
    <div className="perm-grid">
      {mapped.map(s => (
        <label key={s.id}>
          <input type="checkbox" checked={value.includes(s.wmspanelServerId)} onChange={() => toggle(s.wmspanelServerId)} />
          <span>{s.name}</span>
        </label>
      ))}
      {mapped.length === 0 && <span className="hint">{t('ds.noServers')}</span>}
    </div>
  );
}

export default function DistributionPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [servers, setServers] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('channels');

  const load = async () => {
    setError('');
    try {
      setServers(await api('/servers').catch(() => []));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <h1>{t('page.distribution.title')}</h1>
      <div className="sub">{t('page.distribution.sub')}</div>
      {error && <div className="error-box">{error}</div>}

      {/* Two different things live on this page and used to be one list.
          A delivery network is the operator's plan, held by the panel. ABR
          ladders, aliases and origin apps are account-level objects that live
          in WMSPanel and apply to whatever servers are ticked. Mixing them
          made it impossible to tell which settings described a topology and
          which were global. */}
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {['channels', 'network', 'geo'].map(v => (
          <button key={v} className={'tagchip' + (view === v ? ' on' : '')} onClick={() => setView(v)}>
            {t('dist.view.' + v)}
          </button>
        ))}
      </div>

      {view === 'channels' && <ChannelsPanel />}
      {view === 'network' && <DeliveryNetworkPanel servers={servers} onServersChanged={load} />}
      {view === 'geo' && <DeliveryGeoPanel servers={servers} onServersChanged={load} />}

    </div>
  );
}
