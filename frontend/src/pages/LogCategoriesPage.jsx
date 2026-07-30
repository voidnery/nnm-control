import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Select from '../components/Select.jsx';
import LogWindow from '../components/LogWindow.jsx';

// iter10 m4 — Nimble's output split by what part of it is talking.
//
// The mapping was checked against the real dump: these seven categories cover
// 100% of 163,628 records. `other` exists anyway and is defined by exclusion
// rather than by a list, because that sample has no WebRTC, no DVR variants
// and only one transcoder mode — and a subsystem that belonged to no window
// would be a log nobody ever reads.
//
// The overview strip comes first on purpose. With SRT at 74% of everything and
// every single error in this sample living in two categories, "which part of
// Nimble is unhappy" is answerable before a single line is read.

const ORDER = ['transcoder', 'srt', 'rtmp', 'playback', 'ingest', 'dvr', 'core', 'other'];
const fmtN = (n) => new Intl.NumberFormat().format(n);

export default function LogCategoriesPage() {
  const { t } = useI18n();
  const [servers, setServers] = useState([]);
  const [serverId, setServerId] = useState('');
  const [range, setRange] = useState('1h');
  const [counts, setCounts] = useState(null);
  const [focus, setFocus] = useState(null);        // one window, full height
  const [hidden, setHidden] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => { api('/servers').then(setServers).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (serverId) p.set('serverId', serverId);
      const mins = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440, all: 0 }[range];
      if (mins) p.set('from', new Date(Date.now() - mins * 60_000).toISOString());
      const d = await api(`/logs/categories?${p.toString()}`);
      setCounts(d.counts);
    } catch (e) { setError(e.message); }
  }, [serverId, range]);

  useEffect(() => { load(); }, [load]);

  const byKey = useMemo(() => new Map((counts || []).map(c => [c.key, c])), [counts]);
  // A category with nothing in it is noise on the screen, but hiding it
  // silently would leave an operator wondering where the transcoder window
  // went. Empty ones collapse into a strip that still shows they exist.
  const withData = ORDER.filter(k => (byKey.get(k)?.total || 0) > 0 && !hidden.includes(k));
  const empty = ORDER.filter(k => (byKey.get(k)?.total || 0) === 0);

  return (
    <div>
      <h1>{t('logs.catTitle')}</h1>
      <div className="sub">{t('logs.catSub')}</div>

      <div className="panel" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select value={serverId} onChange={setServerId} style={{ minWidth: 180 }}
                  options={[{ value: '', label: t('logs.allServers') },
                            ...servers.map(s => ({ value: s.id, label: s.name }))]} />
          <Select value={range} onChange={setRange} style={{ width: 130 }}
                  options={['15m', '1h', '6h', '24h', 'all'].map(k => ({ value: k, label: t(`logs.range.${k}`) }))} />
          <button onClick={load}>{t('action.refresh')}</button>
          {focus && <button onClick={() => setFocus(null)}>{t('logs.backToAll')}</button>}
        </div>

        {error && <div className="error-box" style={{ marginTop: 6 }}>{error}</div>}

        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {ORDER.map(k => {
            const c = byKey.get(k) || { total: 0, errors: 0 };
            const on = focus === k;
            return (
              <button key={k} className={on ? 'primary' : ''}
                      onClick={() => setFocus(on ? null : k)}
                      title={(c.subs || []).join(', ')}>
                {t(`logs.cat.${k}`)} {fmtN(c.total)}
                {c.errors > 0 && <span className="badge err" style={{ marginLeft: 6 }}>{fmtN(c.errors)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {focus ? (
        <LogWindow key={`focus-${focus}-${serverId}-${range}`}
                   title={t(`logs.cat.${focus}`)} category={focus}
                   serverId={serverId} initialRange={range} height={520} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10 }}>
            {withData.map(k => (
              <LogWindow key={`${k}-${serverId}-${range}`}
                         title={t(`logs.cat.${k}`)} category={k}
                         serverId={serverId} initialRange={range} height={230}
                         onRemove={() => setHidden([...hidden, k])} />
            ))}
          </div>
          {(empty.length > 0 || hidden.length > 0) && (
            <div className="panel hint" style={{ marginTop: 10 }}>
              {empty.length > 0 && <>{t('logs.catEmpty', { list: empty.map(k => t(`logs.cat.${k}`)).join(', ') })}</>}
              {hidden.length > 0 && (
                <div style={{ marginTop: empty.length ? 6 : 0 }}>
                  {t('logs.catHidden')}{' '}
                  {hidden.map(k => (
                    <button key={k} style={{ marginRight: 4 }}
                            onClick={() => setHidden(hidden.filter(x => x !== k))}>
                      {t(`logs.cat.${k}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
