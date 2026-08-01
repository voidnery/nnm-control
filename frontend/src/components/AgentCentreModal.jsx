import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal from './Modal.jsx';

// iter14 — everything about the fleet of agents in one dialog.
//
// An operator does not think "this server's agent" thirteen times; they think
// "which of them are broken and which are behind". So the three questions —
// what is running, what is out of date, what has gone wrong — are answered
// side by side, and every action is one click from its evidence.
//
// Nothing here happens on its own. The watchdog detects and records; updating
// and recovering are buttons, because an automatic action taken on a false
// positive would be the panel reaching into a live broadcast server on the
// strength of a late heartbeat.

const ago = (ms) => (ms == null ? '—' : ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);

export default function AgentCentreModal({ onClose, onChanged }) {
  const { t } = useI18n();
  const { push } = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState('fleet');
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [recover, setRecover] = useState(null);   // server being recovered
  const [job, setJob] = useState(null);
  const poll = useRef(null);

  const load = useCallback(async () => {
    try {
      const [d, e] = await Promise.all([api('/agent-fleet/overview'), api('/agent-fleet/events')]);
      setData(d); setEvents(e); setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const act = async (label, fn) => {
    setBusy(label); setError('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const updateOne = (s) => act(s.id, async () => {
    const r = await api(`/agent-fleet/servers/${s.id}/update`, { method: 'POST' });
    push({ type: 'ok', message: t('ac.queued', { name: s.name, v: r.toVersion }) });
  });

  const updateAll = () => act('all', async () => {
    const r = await api('/agent-fleet/update-outdated', { method: 'POST' });
    push({
      type: r.queued.length ? 'ok' : 'error',
      message: r.queued.length
        ? t('ac.queuedN', { n: r.queued.length, v: r.toVersion })
        : t('ac.queuedNone'),
    });
  });

  const probe = (s) => act(s.id, async () => {
    const r = await api(`/agent-fleet/servers/${s.id}/probe`, { method: 'POST' });
    push({
      type: r.reachable ? 'ok' : 'error',
      message: r.reachable ? t('ac.probeOk', { name: s.name }) : `${s.name}: ${r.error}`,
    });
  });

  const ackAll = () => act('ack', async () => {
    await api('/agent-fleet/events/ack', { method: 'POST', body: {} });
  });

  if (!data) {
    return (
      <Modal onClose={onClose} size="wide">
        <h3 style={{ marginTop: 0 }}>{t('ac.title')}</h3>
        {error ? <div className="error-box">{error}</div> : <div className="hint">{t('sd.loading')}</div>}
      </Modal>
    );
  }

  const { summary, shipped, watchdog } = data;
  const outdated = data.servers.filter(s => s.enabled && s.versionState === 'outdated');

  return (
    <Modal onClose={onClose} size="wide">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{t('ac.title')}</h3>
        <div className="row" style={{ flexShrink: 0, gap: 10 }}>
          <span className="hint">{t('ac.shipped', { v: shipped.version })}</span>
          <button onClick={load}>{t('action.refresh')}</button>
        </div>
      </div>

      {/* The state of the fleet in one line, before any table. */}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <span className="badge live">{t('ac.sHealthy', { n: summary.healthy })}</span>
        {summary.faulty > 0 && <span className="badge err">{t('ac.sFaulty', { n: summary.faulty })}</span>}
        {summary.outdated > 0 && <span className="badge">{t('ac.sOutdated', { n: summary.outdated })}</span>}
        <span className="hint">{t('ac.sConfigured', { n: summary.configured, total: summary.total })}</span>
        {data.unacknowledged > 0 && (
          <span className="badge err">{t('ac.sUnacked', { n: data.unacknowledged })}</span>
        )}
      </div>

      <div className="row" style={{ gap: 12, margin: '12px 0' }}>
        <button className={tab === 'fleet' ? 'primary' : ''} onClick={() => setTab('fleet')}>{t('ac.tabFleet')}</button>
        <button className={tab === 'events' ? 'primary' : ''} onClick={() => setTab('events')}>
          {t('ac.tabEvents')}{data.unacknowledged ? ` (${data.unacknowledged})` : ''}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {tab === 'fleet' && (
        <>
          {outdated.length > 0 && (
            <div className="panel" style={{ marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <b>{t('ac.updateTitle', { n: outdated.length, v: shipped.version })}</b>
                  {/* The distinction that makes this safe, said plainly. */}
                  <div className="hint">{t('ac.updateHow')}</div>
                </div>
                <div className="row" style={{ flexShrink: 0 }}>
                  <button className="primary" disabled={busy === 'all'} onClick={updateAll}>
                    {busy === 'all' ? '…' : t('ac.updateAll')}
                  </button>
                </div>
              </div>
            </div>
          )}

          <table>
            <thead><tr>
              <th>{t('logs.server')}</th>
              <th style={{ width: 150 }}>{t('ac.state')}</th>
              <th style={{ width: 110 }}>{t('ac.version')}</th>
              <th style={{ width: 90 }}>{t('ac.contact')}</th>
              <th style={{ width: 210 }}></th>
            </tr></thead>
            <tbody>
              {data.servers.map(s => (
                <tr key={s.id} className="tally">
                  <td>
                    <b>{s.name}</b>
                    <div className="hint mono" style={{ fontSize: 11 }}>{s.host || '—'}</div>
                  </td>
                  <td>
                    {!s.enabled
                      ? <span className="hint">{t('agent.diag.not-configured')}</span>
                      : <>
                          <span className={'badge ' + (s.code === 'healthy' ? 'live' : 'err')}>
                            {t(`agent.diag.${s.code}`)}
                          </span>
                          {s.code !== 'healthy' && s.evidence && (
                            <div className="hint" style={{ fontSize: 11, marginTop: 2 }}>{s.evidence}</div>
                          )}
                        </>}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {s.enabled ? (s.version || '—') : ''}
                    {s.enabled && s.versionState === 'outdated' && (
                      <span className="badge" style={{ marginLeft: 4 }}>→ {shipped.version}</span>
                    )}
                    {s.enabled && s.versionState === 'ahead' && (
                      <div className="hint" style={{ fontSize: 11 }}>{t('ac.ahead')}</div>
                    )}
                    {s.enabled && s.selfUpdate === false && (
                      <div className="hint" style={{ fontSize: 11 }}>{t('ac.readOnly')}</div>
                    )}
                    {/* An update that was asked for and refused looked exactly
                        like one nobody had asked for. */}
                    {/* Retrying is pointless here: the code doing the checking
                        is the code that needs replacing. Say what does work. */}
                    {s.updateStuck ? (
                      <div className="hint" style={{ fontSize: 11, color: 'var(--warn)' }}>
                        {t('ac.updateStuck')}
                      </div>
                    ) : s.lastUpdate?.status === 'failed' && (
                      <div className="hint" style={{ fontSize: 11, color: 'var(--warn)' }}
                           title={s.lastUpdate.error}>
                        {t('ac.updateFailed')}: {String(s.lastUpdate.error).slice(0, 90)}
                      </div>
                    )}
                    {s.lastUpdate?.status === 'expired' && (
                      <div className="hint" style={{ fontSize: 11, color: 'var(--warn)' }}>{t('ac.updateExpired')}</div>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.enabled ? ago(s.sinceContactMs) : ''}</td>
                  <td>
                    {s.enabled && (
                      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <button disabled={busy === s.id} onClick={() => probe(s)}>{t('ac.probe')}</button>
                        {s.versionState === 'outdated' && s.selfUpdate !== false && !s.updateStuck && (
                          <button disabled={busy === s.id || s.pendingUpdate} onClick={() => updateOne(s)}>
                            {s.pendingUpdate ? t('ac.pending') : t('ac.update')}
                          </button>
                        )}
                        {s.code !== 'healthy' && (
                          <button className="danger" onClick={() => { setRecover(s); setJob(null); }}>
                            {t('ac.recover')}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 8 }}>
            {t('ac.watchdog', { s: Math.round((watchdog.tickMs || 30000) / 1000), n: watchdog.confirmAfter })}
          </div>
        </>
      )}

      {tab === 'events' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="hint">{t('ac.eventsHint')}</span>
            <div className="row" style={{ flexShrink: 0 }}>
              <button disabled={busy === 'ack' || !data.unacknowledged} onClick={ackAll}>{t('ac.ackAll')}</button>
            </div>
          </div>
          <table>
            <tbody>
              {(events || []).map(e => (
                <tr key={e.id} className="tally">
                  <td style={{ width: 150 }} className="mono">{new Date(e.createdAt).toLocaleString()}</td>
                  <td style={{ width: 160 }}>{e.serverName}</td>
                  <td style={{ width: 130 }}>
                    <span className={'badge ' + (e.severity === 'error' ? 'err' : 'live')}>
                      {t(`agent.diag.${e.code}`, {}) || e.code}
                    </span>
                  </td>
                  <td className="hint" style={{ fontSize: 12 }}>
                    {e.evidence || e.message}
                    {!e.acknowledgedAt && <span className="badge err" style={{ marginLeft: 6 }}>{t('ac.new')}</span>}
                  </td>
                </tr>
              ))}
              {(events || []).length === 0 && (
                <tr><td className="hint">{t('ac.noEvents')}</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {recover && (
        <RecoverPanel server={recover} job={job} setJob={setJob} poll={poll}
                      onClose={() => { setRecover(null); setJob(null); load(); }} />
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}

// Recovery over SSH, on the same terms as the SSH install: the host key is
// confirmed before a credential is typed, the credential is used once and
// never stored, and the commands are a fixed list — restart the unit, then
// read why it was down.
function RecoverPanel({ server, job, setJob, poll, onClose }) {
  const { t } = useI18n();
  const [ssh, setSsh] = useState({ host: server.host || '', port: 22, username: 'root', password: '', privateKey: '', useSudo: false });
  const [hostKey, setHostKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setSsh(x => ({ ...x, [k]: v }));

  const probe = async () => {
    setBusy(true); setError(''); setHostKey(null);
    try {
      setHostKey(await api(`/agent-fleet/servers/${server.id}/ssh/probe`, {
        method: 'POST', body: { host: ssh.host.trim(), port: Number(ssh.port) || 22 },
      }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setError('');
    try {
      const { jobId } = await api(`/agent-fleet/servers/${server.id}/recover`, {
        method: 'POST',
        body: {
          host: ssh.host.trim(), port: Number(ssh.port) || 22, username: ssh.username.trim(),
          password: ssh.password || undefined, privateKey: ssh.privateKey || undefined,
          useSudo: ssh.useSudo, fingerprint: hostKey.fingerprint,
        },
      });
      // Used for one request; a dialog left open should not hold a root
      // password in a form.
      setSsh(x => ({ ...x, password: '', privateKey: '' }));
      const tick = async () => {
        try {
          const j = await api(`/agent-fleet/jobs/${jobId}`);
          setJob(j);
          if (j.status !== 'running' && poll.current) { clearInterval(poll.current); poll.current = null; }
        } catch { /* the next tick retries */ }
      };
      await tick();
      poll.current = setInterval(tick, 1500);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} size="wide">
      <h3 style={{ marginTop: 0 }}>{t('ac.recoverTitle', { name: server.name })}</h3>
      <p className="hint">{t('ac.recoverIntro')}</p>

      {!job && (
        <>
          <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
            <div><label>{t('inst.sshHost')}</label>
              <input className="mono" value={ssh.host} onChange={e => set('host', e.target.value)} /></div>
            <div><label>{t('inst.sshPort')}</label>
              <input type="number" value={ssh.port} onChange={e => set('port', e.target.value)} /></div>
            <div><label>{t('inst.sshUser')}</label>
              <input className="mono" value={ssh.username} onChange={e => set('username', e.target.value)} /></div>
          </div>

          {!hostKey
            ? <div style={{ marginTop: 8 }}>
                <button disabled={busy || !ssh.host.trim()} onClick={probe}>{t('inst.sshProbe')}</button>
                <div className="hint" style={{ marginTop: 4 }}>{t('inst.sshProbeHint')}</div>
              </div>
            : <>
                <div className="hint" style={{ marginTop: 8 }}>{t('inst.sshFingerprint')}</div>
                <code className="mono" style={{ wordBreak: 'break-all' }}>{hostKey.fingerprint}</code>
                <div className="hint" style={{ marginTop: 4 }}>{t('inst.sshFingerprintHint')}</div>
                <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                  <div><label>{t('inst.sshPassword')}</label>
                    <input type="password" value={ssh.password} onChange={e => set('password', e.target.value)} /></div>
                  <div><label>{t('inst.sshKey')}</label>
                    <textarea rows={2} className="mono" style={{ fontSize: 11 }} value={ssh.privateKey}
                              onChange={e => set('privateKey', e.target.value)} /></div>
                </div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={ssh.useSudo} onChange={e => set('useSudo', e.target.checked)} />
                  {t('inst.sshSudo')}
                </label>
                <div className="hint">{t('inst.sshNotStored')}</div>
              </>}
          {error && <div className="error-box">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={onClose}>{t('action.cancel')}</button>
            <button className="primary" disabled={busy || !hostKey || (!ssh.password && !ssh.privateKey)} onClick={run}>
              {busy ? '…' : t('ac.recoverRun')}
            </button>
          </div>
        </>
      )}

      {job && (
        <>
          <h4 style={{ margin: '0 0 6px' }}>{t(`ac.job.${job.status}`)}</h4>
          {job.error && <div className="error-box">{job.error}</div>}
          <pre className="mono" style={{ fontSize: 11, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {job.output || '…'}
          </pre>
          {/* What the operator does when this did not help. */}
          {job.status !== 'running' && (
            <div className="hint" style={{ marginTop: 6 }}>{t('ac.recoverNext')}</div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={onClose}>{t('action.close')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
