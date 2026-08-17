import { useState, useEffect, Fragment } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import ErrorDialog from '../components/ErrorDialog.jsx';
import { explainError } from '../lib/errors.js';

// Low-Latency HLS, in one place.
//
// The thing this screen exists to prevent is the one the whole feature has
// been circling for two weeks: **everything applied and the viewer still gets
// ordinary HLS.** A player without HTTP/2 falls back silently, an application
// with the checkbox on and no restart keeps producing the old output, and both
// of those look like success from every angle except the wire.
//
// So the row for an edge shows four things and never rolls them into one green
// tick, and each has three states rather than two — yes, no, and *nobody has
// asked*. The third is not a shade of the second: "we have not probed this
// edge" is fixed by a button and "this edge has no certificate" is not.
//
// The list is deliberately cheap. Reading nimble.conf and shaking hands with
// fourteen machines inside one request is a pattern this project has been
// caught by three times; the detail is fetched for one edge, when it is opened.

const CERT_METHODS = ['acme-http', 'acme-dns', 'upload'];
const DNS_PROVIDERS = ['cloudflare', 'route53', 'digitalocean'];

// Three-valued on purpose. `null` renders as a question mark and reads as a
// question, not as a failure.
function Mark({ value, title }) {
  const cls = value === true ? 'ok' : value === false ? 'bad' : 'unknown';
  return <span className={`llhls-mark ${cls}`} title={title}>
    {value === true ? '✓' : value === false ? '✗' : '?'}
  </span>;
}

function EdgeRow({ edge, open, onToggle }) {
  const { t } = useI18n();
  const w = edge.wire;
  return (
    <tr className={open ? 'open' : ''} onClick={onToggle} style={{ cursor: 'pointer' }}>
      <td>{edge.server}</td>
      <td><Mark value={edge.helper.installed} title={t('llhls.col.helper')} /></td>
      <td><Mark value={edge.transport ? edge.transport.configured : null} title={t('llhls.col.conf')} /></td>
      <td>
        <Mark value={w ? (w.missing.includes('http2') ? false : true) : null} title={t('llhls.col.h2')} />
      </td>
      <td>
        <Mark value={w ? !w.missing.includes('parts') : null} title={t('llhls.col.parts')} />
      </td>
      <td className="hint">
        {edge.certificate
          ? (edge.certificate.expired
              ? t('llhls.cert.expired')
              : t('llhls.cert.days', { n: edge.certificate.daysLeft }))
          : '—'}
      </td>
      <td className="hint">
        {/* What to do next, in one phrase, rather than a status word the
            operator has to translate into an action. */}
        {edge.ready === true ? t('llhls.state.working')
          : edge.blockers.length ? t(`llhls.blocker.${edge.blockers[0]}`)
          : edge.unknown.length ? t('llhls.state.notChecked')
          : t('llhls.state.off')}
      </td>
    </tr>
  );
}

function Detail({ id, onProblem, onChanged }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const canManage = can('servers.manage');

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    domain: '', certMethod: 'acme-http', sslPort: 8443, email: '',
    dnsProvider: 'cloudflare', dnsToken: '', certificatePem: '', privateKeyPem: '',
  });
  const [plan, setPlan] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`/llhls/edges/${id}`)
      .then(d => { if (alive) { setDetail(d); setLoading(false); } })
      .catch(e => { if (alive) { onProblem(explainError(e, t)); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  const preview = async () => {
    setBusy(true); setApplied(null);
    try {
      setPlan(await api(`/llhls/edges/${id}/plan`, { method: 'POST', body: form }));
    } catch (e) { onProblem(explainError(e, t)); setPlan(null); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true);
    try {
      // The digest goes back with the request. If nimble.conf moved between
      // the preview and this click, the panel refuses rather than applying a
      // plan computed from a file that no longer exists.
      const r = await api(`/llhls/edges/${id}/apply`, {
        method: 'POST', body: { ...form, confSha: plan?.confSha },
      });
      setApplied(r);
      push(r.applied ? t('llhls.applied') : t('llhls.nothingToDo'));
      onChanged?.();
    } catch (e) { onProblem(explainError(e, t)); }
    finally { setBusy(false); }
  };

  const rollback = async () => {
    setBusy(true);
    try {
      await api(`/llhls/edges/${id}/rollback`, {
        method: 'POST', body: { backups: applied?.backups || [] },
      });
      push(t('llhls.rolledBack'));
      setApplied(null);
      onChanged?.();
    } catch (e) { onProblem(explainError(e, t)); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="hint">{t('llhls.loading')}</div>;
  if (!detail) return null;

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="llhls-detail">
      {detail.confError && (
        <div className="error-box">{t(`llhls.confError.${detail.confError}`)}</div>
      )}

      {/* What is unknown, said before what is wrong. An operator looking at a
          row of question marks needs to know nobody asked, not to go hunting
          for a fault that has not been shown to exist. */}
      {detail.unknown?.length > 0 && (
        <div className="hint">{t('llhls.unknown', { list: detail.unknown.join(', ') })}</div>
      )}

      {detail.helper.installed === false && (
        <div className="error-box">
          {t('llhls.needHelper')}
        </div>
      )}

      <h4>{t('llhls.setup')}</h4>
      <div className="form-grid">
        <label>{t('llhls.f.domain')}
          <input value={form.domain} onChange={set('domain')} placeholder="edge-2.example.ru" />
        </label>
        <label>{t('llhls.f.sslPort')}
          <input type="number" value={form.sslPort} onChange={set('sslPort')} />
          {/* 8443 rather than 443, and the reason, because the 443 in
              nimble.conf is Nimble's outbound connection to WMSPanel and binds
              no local port — a coincidence that has been mistaken for a
              requirement before. */}
          <span className="hint">{t('llhls.f.sslPortHint')}</span>
        </label>

        <label>{t('llhls.f.method')}
          <select value={form.certMethod} onChange={set('certMethod')}>
            {CERT_METHODS.map(m => <option key={m} value={m}>{t(`llhls.method.${m}`)}</option>)}
          </select>
          <span className="hint">{t(`llhls.method.${form.certMethod}.cost`)}</span>
        </label>

        {form.certMethod !== 'upload' && (
          <label>{t('llhls.f.email')}
            <input value={form.email} onChange={set('email')} placeholder="ops@example.ru" />
          </label>
        )}

        {form.certMethod === 'acme-dns' && (
          <>
            <label>{t('llhls.f.dnsProvider')}
              <select value={form.dnsProvider} onChange={set('dnsProvider')}>
                {DNS_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>{t('llhls.f.dnsToken')}
              <input type="password" value={form.dnsToken} onChange={set('dnsToken')} />
              <span className="hint">{t('llhls.f.dnsTokenHint')}</span>
            </label>
          </>
        )}

        {form.certMethod === 'upload' && (
          <>
            <label className="wide">{t('llhls.f.cert')}
              <textarea rows={5} value={form.certificatePem} onChange={set('certificatePem')}
                        placeholder="-----BEGIN CERTIFICATE-----" />
              <span className="hint">{t('llhls.f.certHint')}</span>
            </label>
            <label className="wide">{t('llhls.f.key')}
              <textarea rows={5} value={form.privateKeyPem} onChange={set('privateKeyPem')}
                        placeholder="-----BEGIN PRIVATE KEY-----" />
            </label>
          </>
        )}
      </div>

      <div className="row">
        <button disabled={!canManage || busy || !form.domain} onClick={preview}>
          {t('llhls.preview')}
        </button>
      </div>

      {plan && (
        <div className="llhls-plan">
          {plan.transport.blockers?.length > 0 && (
            <ul className="error-box">
              {plan.transport.blockers.map(b => <li key={b}>{t(`llhls.block.${b}`)}</li>)}
            </ul>
          )}

          {plan.certificate?.uploaded?.notes?.includes('no-intermediate-bundled') && (
            <div className="error-box">{t('llhls.noIntermediate')}</div>
          )}
          {plan.certificate?.uploaded && (
            <div className="hint">{t('llhls.trustUnknown')}</div>
          )}

          <div className="hint">{plan.certificate.renewalNote}</div>

          {plan.transport.ok && !plan.transport.unchanged && (
            <>
              <div className="error-box">{plan.transport.interruption}</div>
              <button className="linkish" onClick={() => setShowDiff(s => !s)}>
                {showDiff ? t('llhls.hideDiff') : t('llhls.showDiff', { n: plan.transport.diff.length })}
              </button>
              {showDiff && (
                <pre className="llhls-diff">
                  {plan.transport.diff.map(d => (
                    <div key={d.line}>
                      {d.from !== null && <div className="del">- {d.from}</div>}
                      {d.to !== null && <div className="add">+ {d.to}</div>}
                    </div>
                  ))}
                </pre>
              )}
            </>
          )}

          {plan.transport.unchanged && <div className="hint">{t('llhls.alreadyDone')}</div>}

          {plan.transport.ok && !plan.transport.unchanged && (
            <div className="row">
              <button className="danger" disabled={!canManage || busy} onClick={apply}>
                {t('llhls.apply')}
              </button>
            </div>
          )}
        </div>
      )}

      {applied && (
        <div className="llhls-applied">
          {/* The result of each step, not a single word for the whole run. A
              run where the certificate was issued and the restart failed is a
              different machine from one where nothing happened. */}
          <ul>
            {(applied.result?.steps || []).map(s => (
              <li key={s.id}>
                <Mark value={s.ok === true ? true : s.ok === false ? false : null} /> {s.id}
                {s.skipped && <span className="hint"> — {t('llhls.skipped')}</span>}
                {s.error && <span className="llhls-bad"> — {s.error}</span>}
              </li>
            ))}
          </ul>
          <div className={applied.tls?.http2 ? 'muted' : 'warn'}>{applied.next}</div>
          {applied.backups?.length > 0 && (
            <button disabled={busy} onClick={rollback}>{t('llhls.rollback')}</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function LlhlsPage() {
  const { t } = useI18n();
  const [edges, setEdges] = useState([]);
  const [open, setOpen] = useState(null);
  const [problem, setProblem] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api('/llhls/edges')
      .then(d => { setEdges(d.edges || []); setLoading(false); })
      .catch(e => { setProblem(explainError(e, t)); setLoading(false); });
  };
  useEffect(load, []);

  return (
    <div className="panel">
      <h2>{t('llhls.title')}</h2>
      <p className="hint">{t('llhls.sub')}</p>

      {loading && <div className="hint">{t('llhls.loading')}</div>}

      {!loading && edges.length === 0 && <div className="hint">{t('llhls.noEdges')}</div>}

      {edges.length > 0 && (
        <table className="llhls-grid">
          <thead>
            <tr>
              <th>{t('llhls.col.server')}</th>
              <th>{t('llhls.col.helper')}</th>
              <th>{t('llhls.col.conf')}</th>
              <th>{t('llhls.col.h2')}</th>
              <th>{t('llhls.col.parts')}</th>
              <th>{t('llhls.col.cert')}</th>
              <th>{t('llhls.col.next')}</th>
            </tr>
          </thead>
          <tbody>
            {edges.map(e => {
              const id = e.id || e.server;
              return (
                <Fragment key={id}>
                  <EdgeRow edge={e} open={open === id}
                           onToggle={() => setOpen(open === id ? null : id)} />
                  {open === id && (
                    <tr><td colSpan={7}>
                      <Detail id={e.id} onProblem={setProblem} onChanged={load} />
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <ErrorDialog problem={problem} onClose={() => setProblem(null)} />
    </div>
  );
}
