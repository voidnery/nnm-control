import Modal from './Modal.jsx';
import { useI18n } from '../i18n.jsx';
import { confErrorText, confErrorFix } from '../lib/confErrors.jsx';

// Everything the panel knows about one edge, sorted, in one place.
//
// It was scattered across the row: an explanation under the table, a warning
// beside a button, an error in small type below a field, a sentence inside the
// plan. Each was written where it happened to be needed, and together they
// made a page an operator has to read top to bottom to find out whether
// anything is wrong.
//
// Sorted by what the reader is doing. **Problems first**, because that is why
// this opens most of the time. Then what is in place, because that is the
// other reason. Then the flat facts — paths, ports, dates — which are what
// somebody needs at three in the morning and nobody needs otherwise.

function Section({ title, children }) {
  return <div className="det-section"><h4>{title}</h4>{children}</div>;
}

function Fact({ label, value, mono = false }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="det-fact">
      <span className="det-fact-label">{label}</span>
      <span className={mono ? 'mono' : ''}>{String(value)}</span>
    </div>
  );
}

// Problems, in one list, from every place they can come from. Returned rather
// than rendered so the row can count them without drawing them.
export function problemsOf(d, t) {
  if (!d) return [];
  const out = [];
  if (d.confError) {
    out.push({ key: 'conf', title: confErrorText(t, d.confError),
               fix: confErrorFix(t, d.confError), detail: d.confDetail });
  }
  for (const b of d.blockers || []) {
    // The conf error is already above with its own fix; repeating it as a
    // blocker would be the same problem twice.
    if (b === 'no-certificate-configured' && d.confError) continue;
    out.push({ key: b, title: t(`llhls.blocker.${b}`) });
  }
  if (d.tlsError) out.push({ key: 'tls', title: t('llhls.det.tlsFailed'), detail: d.tlsError });
  if (d.playlistError) out.push({ key: 'playlist', title: t('llhls.det.playlistFailed'), detail: d.playlistError });
  // The code, translated here. The server used to compose this sentence in
  // English and it was rendered verbatim into a Russian interface.
  if (d.wire?.silentFallback) {
    out.push({
      key: 'fallback',
      title: t(`llhls.fallback.${d.wire.silentFallback}`),
      // When the application could be read, the cause is known and there is no
      // point offering two.
      fix: d.parts ? t(`llhls.parts.${d.parts.state}`) : t('llhls.parts.unknown'),
    });
  }
  if (d.certificate?.expiring) {
    out.push({ key: 'cert-soon', title: t('llhls.det.certSoon', { n: d.certificate.daysLeft }) });
  }
  return out;
}

export default function EdgeDetails({ detail, onClose }) {
  const { t } = useI18n();
  const d = detail || {};
  const problems = problemsOf(d, t);

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('llhls.det.title', { server: d.server || '' })}</h3>

      {problems.length > 0 ? (
        <Section title={t('llhls.det.problems', { n: problems.length })}>
          {problems.map(p => (
            <div className="error-box" key={p.key}>
              <b>{p.title}</b>
              {p.fix && <div>{p.fix}</div>}
              {/* The machine's own words last and small. They are useful and
                  they are not an explanation; first, they get read instead of
                  the instruction. */}
              {p.detail && <div className="hint mono">{p.detail}</div>}
            </div>
          ))}
        </Section>
      ) : (
        <Section title={t('llhls.det.noProblems')}>
          <div className="hint">{t('llhls.det.noProblemsHint')}</div>
        </Section>
      )}

      {d.unknown?.length > 0 && (
        <Section title={t('llhls.det.unknown')}>
          <div className="hint">{t('llhls.unknown', { list: d.unknown.join(', ') })}</div>
        </Section>
      )}

      <Section title={t('llhls.det.transport')}>
        <Fact label={t('llhls.det.address')} value={d.address} mono />
        <Fact label={t('llhls.det.probed')} value={d.probedHost} mono />
        <Fact label={t('llhls.det.sslPort')} value={d.sslPort} mono />
        <Fact label={t('llhls.det.httpPort')} value={d.transport?.httpPort} mono />
        <Fact label={t('llhls.det.http2')} value={d.transport?.http2 ? t('common.yes') : t('common.no')} />
        <Fact label={t('llhls.det.certPath')} value={d.certPath} mono />
        <Fact label={t('llhls.det.keyPath')} value={d.transport?.keyPath} mono />
      </Section>

      <Section title={t('llhls.det.certificate')}>
        {d.certVerdict && (
          <div className={d.certVerdict.action === 'keep' ? 'hint' : 'error-box'}>
            <b>{t(`llhls.cert.state.${d.certVerdict.state}`)}</b>
            <div>{t(`llhls.cert.action.${d.certVerdict.action || 'none'}`)}</div>
          </div>
        )}
        <Fact label={t('llhls.det.certDomain')} value={d.certDomain} mono />
        <Fact label={t('llhls.det.certValidTo')} value={d.certificate?.validTo} mono />
        <Fact label={t('llhls.det.certDays')} value={d.certificate?.daysLeft} />
        <Fact label={t('llhls.det.certTrusted')}
              value={d.certificate ? (d.certificate.trusted ? t('common.yes') : t('common.no')) : null} />
        <Fact label={t('llhls.det.certError')} value={d.certificate?.error} mono />
        {!d.certificate && <div className="hint">{t('llhls.det.certUnknown')}</div>}
      </Section>

      <Section title={t('llhls.det.helper')}>
        <Fact label={t('llhls.det.helperProfile')} value={d.helper?.profile} mono />
        <Fact label={t('llhls.det.helperVersion')} value={d.helper?.version} mono />
        <Fact label={t('llhls.det.helperSeenAt')} value={d.helper?.lastContactAt} mono />
      </Section>

      {d.watched && (
        <Section title={t('llhls.det.wire')}>
          <Fact label={t('llhls.det.watched')} value={d.watched} mono />
          <Fact label={t('llhls.det.parts')}
                value={d.wire?.partsUnknown ? null
                  : d.wire?.missing?.includes('parts') ? t('common.no') : t('common.yes')} />
          <Fact label={t('llhls.det.appAlhls')}
                value={d.application ? (d.application.alhls === true ? t('common.yes')
                  : d.application.alhls === false ? t('common.no') : null) : null} />
          <Fact label={t('llhls.det.appPart')} value={d.application?.part} mono />
          <Fact label={t('llhls.det.appChunk')} value={d.application?.chunk} mono />
          <Fact label={t('llhls.det.appProtocols')} value={d.application?.protocols?.join(', ')} mono />
        </Section>
      )}

      <div className="row">
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
