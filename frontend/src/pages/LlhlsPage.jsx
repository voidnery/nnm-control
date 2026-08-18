import { useState, useEffect, Fragment } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import ErrorDialog from '../components/ErrorDialog.jsx';
import { explainError } from '../lib/errors.js';
import { helperState } from '../lib/capabilities.js';
import CertificateSetup from '../components/CertificateSetup.jsx';
import ConfError from '../lib/confErrors.jsx';

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

  // One decision for the warning and the button, so they cannot disagree.
  const helper = helperState({ purpose: detail.purpose, privileged: detail.helper.installed });

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="llhls-detail">
      {/* A code, a fix, and the machine's own words last. This used to be
          `t('llhls.confError.' + detail.confError)` where confError was an
          exception's message, so the interface printed the key. */}
      <ConfError code={detail.confError} detail={detail.confDetail} />

      {/* What is unknown, said before what is wrong. An operator looking at a
          row of question marks needs to know nobody asked, not to go hunting
          for a fault that has not been shown to exist. */}
      {detail.unknown?.length > 0 && (
        <div className="hint">{t('llhls.unknown', { list: detail.unknown.join(', ') })}</div>
      )}

      {/* Three-valued, and the third value permits nothing. This used to show
          only when the helper was known absent, so a machine that had never
          reported got no warning and a working Apply button — and the refusal
          arrived after the press, as an HTTP 422 with a code in it. */}
      {helper !== 'installed' && (
        <div className="error-box">
          {t(helper === 'missing' ? 'llhls.needHelper' : 'llhls.helperUnknown')}
        </div>
      )}

      <h4>{t('llhls.setup')}</h4>

      {/* The same component the gateway wizard uses. There were two of these
          once, asking the same question with different answers depending on
          which page you had opened. */}
      <CertificateSetup value={form} onChange={setForm} target="nimble-conf" disabled={busy} />

      <label>{t('llhls.f.sslPort')}</label>
      <input type="number" className="mono" value={form.sslPort} onChange={set('sslPort')} />
      {/* 8443 rather than 443, and the reason, because the 443 in nimble.conf
          is Nimble's outbound connection to WMSPanel and binds no local port —
          a coincidence that has been mistaken for a requirement before. */}
      <div className="hint">{t('llhls.f.sslPortHint')}</div>

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
              <button className="danger" disabled={!canManage || busy || helper !== 'installed'}
                      onClick={apply}>
                {t('llhls.apply')}
              </button>
              {helper !== 'installed' && (
                <span className="hint">{t('llhls.applyBlocked')}</span>
              )}
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
