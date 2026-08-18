import { useI18n } from '../i18n.jsx';

// How should the certificate arrive.
//
// There were two of these, in two places, with different answers. The gateway
// wizard knew one method — Let's Encrypt through the nginx it was about to
// start — and the LL-HLS screen knew three. Same question, two sets of
// answers, and which you got depended on which page you opened.
//
// What differs between a gateway and a delivery media server is not the
// question but **where the result goes**: nginx on one, `nimble.conf` on the
// other. That follows from what the machine is, so the operator is not asked
// it — they are told, in one line, so the placement is visible without being a
// decision they have to make correctly.
//
// Controlled: the parent owns the values and sends them. This component draws
// the question and nothing else, because both parents post to different routes
// and neither should have to know the other's shape.

export const CERT_METHODS = ['acme-http', 'acme-dns', 'upload'];
export const DNS_PROVIDERS = ['cloudflare', 'route53', 'digitalocean'];

// Providers whose credentials come from somewhere other than a token — route53
// reads an instance role — so demanding a token would block a setup that
// works.
const NEEDS_TOKEN = { cloudflare: true, route53: false, digitalocean: true };

export default function CertificateSetup({ value, onChange, target, disabled = false }) {
  const { t } = useI18n();
  const v = value || {};
  const method = CERT_METHODS.includes(v.certMethod) ? v.certMethod : 'acme-http';
  const set = (k) => (e) => onChange({ ...v, [k]: e.target.value });

  return (
    <div className="cert-setup">
      <label>{t('cert.domain')}</label>
      {/* Asked, never guessed: the certificate is issued for this name, and an
          invented one burns a rate-limited issuance to produce something
          nobody can use. */}
      <input className="mono" placeholder="cdn.example.com" disabled={disabled}
             value={v.domain || ''} onChange={set('domain')} />
      <div className="hint">{t('cert.domainHint')}</div>

      <label>{t('cert.method')}</label>
      <select value={method} disabled={disabled} onChange={set('certMethod')}>
        {CERT_METHODS.map(m => <option key={m} value={m}>{t('cert.m.' + m)}</option>)}
      </select>
      {/* The cost beside the choice, not in a document. All three work; they
          differ in what they demand and in what happens in ninety days. */}
      <div className="hint">{t('cert.m.' + method + '.cost')}</div>

      {method !== 'upload' && (
        <>
          <label>{t('cert.email')}</label>
          <input className="mono" placeholder="ops@example.com" disabled={disabled}
                 value={v.email || ''} onChange={set('email')} />
          <div className="hint">{t('cert.emailHint')}</div>
        </>
      )}

      {method === 'acme-dns' && (
        <>
          <label>{t('cert.dnsProvider')}</label>
          <select value={v.dnsProvider || 'cloudflare'} disabled={disabled}
                  onChange={set('dnsProvider')}>
            {DNS_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {NEEDS_TOKEN[v.dnsProvider || 'cloudflare'] ? (
            <>
              <label>{t('cert.dnsToken')}</label>
              <input type="password" className="mono" disabled={disabled}
                     value={v.dnsToken || ''} onChange={set('dnsToken')} />
              <div className="hint">{t('cert.dnsTokenHint')}</div>
            </>
          ) : (
            <div className="hint">{t('cert.dnsNoToken')}</div>
          )}
        </>
      )}

      {method === 'upload' && (
        <>
          <label>{t('cert.cert')}</label>
          <textarea rows={5} className="mono" disabled={disabled}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    value={v.certificatePem || ''} onChange={set('certificatePem')} />
          <div className="hint">{t('cert.certHint')}</div>
          <label>{t('cert.key')}</label>
          <textarea rows={5} className="mono" disabled={disabled}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    value={v.privateKeyPem || ''} onChange={set('privateKeyPem')} />
          <div className="hint">{t('cert.keyHint')}</div>
        </>
      )}

      {/* Where it lands. Told, not asked — an operator answers what a machine
          is for once, on the server card, and this follows from it. */}
      {target && <div className="hint">{t('cert.target.' + target)}</div>}
    </div>
  );
}
