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
import EdgeDetails, { problemsOf } from '../components/EdgeDetails.jsx';

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

// How far the run has got, by counting the steps the machine has answered
// about rather than by a timer. A bar driven by elapsed time is a bar that
// lies whenever the work is faster or slower than somebody guessed.
function progressOf(job) {
  if (job.status !== 'running') return 100;
  const total = job.steps.length || 1;
  const done = (job.output || '').split('\n')
    .filter(l => /^(ok|FAIL|skip)/.test(l.trim())).length;
  // Never a full bar while it is still running: a bar at 100% that keeps
  // moving is worse than no bar.
  return Math.min(95, Math.round((done / total) * 100));
}

// Three-valued on purpose. `null` renders as a question mark and reads as a
// question, not as a failure.
function Mark({ value, title }) {
  const cls = value === true ? 'ok' : value === false ? 'bad' : 'unknown';
  return <span className={`llhls-mark ${cls}`} title={title}>
    {value === true ? '✓' : value === false ? '✗' : '?'}
  </span>;
}

function EdgeRow({ edge, open, onToggle, onDetails }) {
  const { t } = useI18n();
  const w = edge.wire;
  // Counted here so the button can shout before anything is opened. A page
  // where the operator has to click each row to discover a fault is a page
  // that hides faults.
  const problems = problemsOf(edge, t);
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
        {/* Three states here too. An em dash read as "there is none"; it meant
            "nobody has looked", and those are different problems. A path in
            nimble.conf is a fact about configuration and not about the
            certificate's own health, so it says so. */}
        {edge.certificate
          ? (edge.certificate.expired
              ? t('llhls.cert.expired')
              : t('llhls.cert.days', { n: edge.certificate.daysLeft }))
          : edge.transport?.certPath ? t('llhls.cert.configured')
          : edge.transport ? t('llhls.cert.none')
          : '?'}
      </td>
      <td className="hint">
        {/* What to do next, in one phrase, rather than a status word the
            operator has to translate into an action. */}
        {edge.ready === true ? t('llhls.state.working')
          : edge.blockers.length ? t(`llhls.blocker.${edge.blockers[0]}`)
          : edge.unknown.length ? t('llhls.state.notChecked')
          : t('llhls.state.off')}
      </td>
      <td onClick={e => e.stopPropagation()}>
        {problems.length > 0 && <span className="llhls-bad">{t('llhls.det.alert')}</span>}{' '}
        <button className={problems.length > 0 ? 'det-btn alarm' : 'det-btn'}
                onClick={() => onDetails(edge)}>
          {t('llhls.det.button')}
        </button>
      </td>
    </tr>
  );
}

function Detail({ id, onProblem, onChanged, onLearned }) {
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
  // The steps the plan will run, and where the machine has got to. Held apart
  // from the transcript: a bar answers "how far", a log answers "what
  // happened", and one pane doing both answers neither well.
  // What to watch, so the parts column can be answered at all. Only the
  // operator knows which application and stream is live on this edge, so it is
  // asked for rather than guessed — a wrong guess would fetch a 404 and report
  // it as "no parts".
  const [watch, setWatch] = useState('');
  const [job, setJob] = useState(null);
  const [showLog, setShowLog] = useState(false);

  const load = (stream) => {
    setLoading(true);
    return api(`/llhls/edges/${id}${stream ? `?stream=${encodeURIComponent(stream)}` : ''}`)
      .then(d => {
        setDetail(d);
        setLoading(false);
        onLearned?.(d);
        // An edge that is already set up should show what it is set up with.
        // The domain comes from the certificate's own path in nimble.conf, so
        // it is the name the certificate was actually issued for — not a guess
        // and not a placeholder the operator has to retype.
        //
        // The email is not prefilled: certbot keeps it on the ACME account,
        // not on the certificate, so there is nothing here to read. Saying
        // nothing is better than showing a plausible address that was never
        // used.
        setForm(f => ({
          ...f,
          domain: f.domain || d.certDomain || '',
          sslPort: d.sslPort || f.sslPort,
        }));
        return d;
      })
      .catch(e => { onProblem(explainError(e, t)); setLoading(false); });
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`/llhls/edges/${id}`)
      .then(d => {
        if (!alive) return;
        setDetail(d);
        setLoading(false);
        setForm(f => ({ ...f, domain: f.domain || d.certDomain || '',
                        sslPort: d.sslPort || f.sslPort }));
        // The row said `?` and promised that opening it would ask. It asked —
        // and the answer stopped here, so the row went on saying `?` while the
        // panel below it knew better. A promise the interface made and broke.
        onLearned?.(d);
      })
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

  // Started, then followed.
  //
  // This used to hold the browser's request for the whole run. Installing
  // certbot and issuing a certificate takes minutes, and whatever proxies the
  // panel closed the connection at sixty seconds and answered 504 — while the
  // work carried on underneath and, from here, simply vanished.
  const apply = async () => {
    setBusy(true); setApplied(null); setShowLog(false);
    try {
      // The digest goes back with the request. If nimble.conf moved between
      // the preview and this click, the panel refuses rather than applying a
      // plan computed from a file that no longer exists.
      const started = await api(`/llhls/edges/${id}/apply`, {
        method: 'POST', body: { ...form, confSha: plan?.confSha },
      });
      if (!started.jobId) {
        setApplied(started);
        push(t('llhls.nothingToDo'));
        return;
      }
      setJob({ status: 'running', output: '', steps: started.steps || [] });

      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        const j = await api(`/llhls/edges/${id}/jobs/${started.jobId}`);
        setJob(prev => ({ ...j, steps: prev?.steps || [] }));
        if (j.status === 'done' || j.status === 'failed') {
          setApplied(j.result || { applied: false, error: j.error });
          push(j.status === 'done' ? t('llhls.applied') : t('llhls.applyFailed'));
          onChanged?.();
          break;
        }
      }
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
      {/* When it is there, when it last said so. `helper.seen` is never unset,
          so a helper that was removed still reads as installed and this date
          is the only thing that says otherwise. */}
      {helper === 'installed' && detail.helper.lastContactAt && (
        <div className="hint">
          {t('llhls.helperSeen', {
            when: new Date(detail.helper.lastContactAt).toLocaleString(),
            version: detail.helper.version || '?',
          })}
        </div>
      )}

      {/* Asking the wire. The four marks in the row are four different
          questions, and two of them can only be answered by fetching
          something. */}
      <div className="row">
        <input className="mono" placeholder="app/stream" value={watch}
               onChange={e => setWatch(e.target.value)} style={{ minWidth: 220 }} />
        <button disabled={loading} onClick={() => load(watch.trim())}>
          {t('llhls.check')}
        </button>
      </div>
      <div className="hint">{t('llhls.checkHint')}</div>
      {detail.tlsError && <div className="hint mono">TLS: {detail.tlsError}</div>}
      {detail.playlistError && <div className="hint mono">{t('llhls.playlistError')}: {detail.playlistError}</div>}
      {detail.wire?.silentFallback && <div className="error-box">{detail.wire.silentFallback}</div>}

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

      {job && (
        <div className="llhls-job">
          {/* Each step, in order, with what the machine said about it. A
              single spinner over a five-minute run tells an operator nothing
              about which part is slow or which one failed. */}
          <ol className="llhls-steps">
            {job.steps.map(st => {
              const line = (job.output || '').split('\n')
                .find(l => l.includes(` ${st.id}`) && /^(ok|FAIL|skip)/.test(l.trim()));
              const state = !line ? (job.status === 'running' ? 'pending' : 'unknown')
                : line.startsWith('ok') ? 'ok' : line.startsWith('skip') ? 'skip' : 'bad';
              return (
                <li key={st.id} className={`llhls-step ${state}`}>
                  <span className="llhls-step-mark">
                    {state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'skip' ? '·' : '…'}
                  </span>
                  <span className="llhls-step-id">{st.id}</span>
                  <span className="hint">{st.why}</span>
                </li>
              );
            })}
          </ol>

          <div className={`llhls-bar ${job.status}`}>
            <div className="llhls-bar-fill" style={{ width: `${progressOf(job)}%` }} />
          </div>
          <div className="hint">
            {job.status === 'running' ? t('llhls.job.running')
              : job.status === 'done' ? t('llhls.job.done') : t('llhls.job.failed')}
          </div>

          {/* The transcript, on request. It is what the machine actually said
              and it is not an explanation — offered rather than shown, so the
              step list stays readable. */}
          <button className="linkish" onClick={() => setShowLog(v => !v)}>
            {showLog ? t('llhls.job.hideLog') : t('llhls.job.showLog')}
          </button>
          {showLog && <pre className="llhls-log mono">{job.output || ''}</pre>}
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

  const [asking, setAsking] = useState(null);
  const [details, setDetails] = useState(null);

  // Ask about every edge, without being asked to.
  //
  // The list is cheap and answers nothing; the detail asks the machine. Making
  // the operator click each row to find out whether an edge works is the same
  // fault as a row that promises "open it to ask" and then keeps saying `?`.
  //
  // One at a time on purpose: fourteen machines probed in parallel inside one
  // page load is the pattern this project has been caught by three times, and
  // an edge answering slowly should delay one row rather than all of them.
  const load = async () => {
    setLoading(true);
    let list = [];
    try {
      list = (await api('/llhls/edges')).edges || [];
      setEdges(list);
    } catch (e) { setProblem(explainError(e, t)); setLoading(false); return; }
    setLoading(false);

    for (const e of list) {
      setAsking(e.id);
      try {
        const d = await api(`/llhls/edges/${e.id}`);
        setEdges(cur => cur.map(x => (x.id === e.id ? { ...x, ...d } : x)));
      } catch {
        // A machine that cannot be asked leaves its row as it was: unknown,
        // which is what it is. Failing the whole sweep over one edge would
        // hide the thirteen that answered.
      }
    }
    setAsking(null);
  };
  useEffect(() => { load(); }, []);

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
              <th />
            </tr>
          </thead>
          <tbody>
            {edges.map(e => {
              const id = e.id || e.server;
              return (
                <Fragment key={id}>
                  <EdgeRow edge={e} open={open === id}
                           onToggle={() => setOpen(open === id ? null : id)}
                           // Written out rather than passing the setter: the
                           // unreachable-state audit reads call sites, and a
                           // setter handed off as a prop is invisible to it.
                           // Explicit is also what a reader wants here.
                           onDetails={(row) => setDetails(row)} />
                  {open === id && (
                    <tr><td colSpan={8}>
                      <Detail id={e.id} onProblem={setProblem} onChanged={load}
                              onLearned={(d) => setEdges(list => list.map(
                                x => (x.id === e.id ? { ...x, ...d } : x)))} />
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {asking && <div className="hint">{t('llhls.asking')}</div>}
      {details && <EdgeDetails detail={details} onClose={() => setDetails(null)} />}
      <ErrorDialog problem={problem} onClose={() => setProblem(null)} />
    </div>
  );
}
