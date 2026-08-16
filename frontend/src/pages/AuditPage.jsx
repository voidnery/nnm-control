import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Select from '../components/Select.jsx';
import DataView from '../components/DataView.jsx';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';

export default function AuditPage() {
  const { t } = useI18n();
  const [items, setItems] = useState([]);
  const [username, setUsername] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState(null);
  const [swept, setSwept] = useState(null);
  const [sweepError, setSweepError] = useState('');
  const [sweptLog, setSweptLog] = useState('');
  const { can } = useAuth();

  // What a sweep would remove, asked before it is offered.
  //
  // Machine polling was audited until v0.99.20 and left millions of rows —
  // 50 GB on the disk the panel runs on, which it twice filled. The source is
  // closed; the history is not, and the TTL takes thirty days to reach it.
  const loadSweep = async () => {
    try { setSweep(await api('/audit/sweepable')); setSweepError(''); }
    catch (e) {
      // Said, not swallowed. The first version caught this and set null, so a
      // server-side exception showed up as "no button" — indistinguishable
      // from "nothing to sweep", and it took a code read to tell them apart.
      setSweep(null);
      setSweepError(e.data?.error || e.message);
    }
  };

  const doSweep = async () => {
    setBusy(true); setError('');
    try {
      // The count the operator was shown, sent back. Agreeing to "delete
      // 8,598,036 rows" is a different act from clicking a button that
      // happened to be under the cursor.
      const started = await api('/audit/sweep', { method: 'POST', body: { expect: sweep.machine } });
      // Polled: deleting millions of rows and compacting the file takes
      // minutes, and a request held open that long is at the mercy of whatever
      // proxies the panel — the counting already timed out that way once.
      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        const job = await api(`/audit/sweep/jobs/${started.jobId}`);
        setSweptLog(job.output || '');
        if (job.status === 'done' || job.status === 'failed') {
          setSwept(job.result || { removed: 0, error: job.error });
          break;
        }
      }
      await loadSweep();
      await load();
    } catch (e) {
      setError(e.data?.code === 'count-changed'
        ? t('aud.sweepChanged', { expected: e.data.expected, actual: e.data.actual })
        : (e.data?.error || e.message));
    } finally { setBusy(false); }
  };

  const query = (before) => {
    const p = new URLSearchParams();
    if (username) p.set('username', username);
    if (action) p.set('action', action);
    if (outcome) p.set('outcome', outcome);
    if (before) p.set('before', before);
    return `/audit?${p.toString()}`;
  };

  const load = async () => {
    setBusy(true); setError('');
    try { setItems((await api(query())).items); await loadSweep(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const loadOlder = async () => {
    if (items.length === 0) return;
    setBusy(true);
    try {
      const older = (await api(query(items[items.length - 1].ts))).items;
      setItems(list => [...list, ...older]);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      {/* Only when there is something to sweep. A control for a problem
          nobody has is noise on the page. */}
      {can('audit.manage') && sweep?.machine > 0 && (
        <div className="inset">
          <div className="eyebrow">{t('aud.sweepTitle')}</div>
          <div className="hint">
            {t(sweep.estimated ? 'aud.sweepWhatApprox' : 'aud.sweepWhat',
               { machine: sweep.machine.toLocaleString('ru'), keeping: sweep.keeping.toLocaleString('ru') })}
            {sweep.storageMb != null && <> · {t('aud.sweepSize', { mb: sweep.storageMb.toLocaleString('ru') })}</>}
          </div>
          <div className="hint">{t('aud.sweepCompact')}</div>
          <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={doSweep}>
            {busy ? '…' : t('aud.sweepDo', { n: sweep.machine.toLocaleString('ru') })}
          </button>
        </div>
      )}
      {can('audit.manage') && sweepError && (
        <div className="error-box">{t('aud.sweepUnavailable')}<div className="mono hint">{sweepError}</div></div>
      )}
      {/* What it is doing while it does it. Compaction holds a lock for
          minutes, and a page that looks frozen is one somebody reloads. */}
      {busy && sweptLog && (
        <div className="inset">
          <div className="progress"><div className="progress-fill indeterminate" /></div>
          <pre className="mono" style={{ fontSize: 11, maxHeight: 160, overflow: 'auto' }}>{sweptLog}</pre>
        </div>
      )}
      {swept && (
        <div className="hint" style={{ color: 'var(--ok, #5ad18f)' }}>
          {t('aud.sweptOk', { n: (swept.removed || 0).toLocaleString('ru'), mb: swept.storageMb ?? '?' })}
          {swept.compacted === false && <> · {t('aud.sweptNoCompact')}</>}
        </div>
      )}
      <h1>{t('page.audit.title')}</h1>
      <div className="sub">Who changed what and when. Mutating actions, logins and function runs; secrets are masked; retention 90 days.</div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ maxWidth: 160 }} placeholder={t('ad.user')} value={username} onChange={e => setUsername(e.target.value)} />
        <input style={{ maxWidth: 260 }} placeholder={t('ad.actionContains')} value={action} onChange={e => setAction(e.target.value)} />
        <div style={{ maxWidth: 130 }}>
          <Select value={outcome} onChange={setOutcome}
                  options={[{ value: '', label: 'any outcome' }, { value: 'ok', label: 'ok' }, { value: 'error', label: 'error' }]} />
        </div>
        <button className="primary" disabled={busy} onClick={load}>{t('action.apply')}</button>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>{t('ad.time')}</th><th>{t('ad.user')}</th><th>{t('ad.action')}</th><th>{t('ad.target')}</th><th>{t('ad.result')}</th><th></th></tr></thead>
          <tbody>
            {items.map(it => (
              <tr key={it._id}>
                <td className="mono hint" style={{ whiteSpace: 'nowrap' }}>{new Date(it.ts).toLocaleString()}</td>
                <td className="mono">{it.username || '—'}</td>
                <td className="mono">{it.action}</td>
                <td className="mono hint">{it.target || ''}</td>
                <td><span className={'lamp ' + (it.outcome === 'ok' ? 'on' : 'off')} />{it.status || it.outcome}</td>
                <td style={{ textAlign: 'right' }}>
                  {it.detail && <button onClick={() => setExpanded(expanded === it._id ? null : it._id)}>
                    {expanded === it._id ? 'Hide' : 'Detail'}
                  </button>}
                </td>
              </tr>
            ))}
            {items.map(it => expanded === it._id && (
              <tr key={it._id + 'x'}>
                <td colSpan={6}>
                  <DataView data={it.detail} />
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="hint">{t('ad.empty')}</td></tr>}
          </tbody>
        </table>
        {items.length >= 200 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={loadOlder}>{t('ad.loadOlder')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
