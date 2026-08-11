import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

// What is on, and what that quietly does.
//
// Two halves on purpose. The top is the settings themselves, so "what is
// enabled" is answered by reading rather than by inferring it backwards out of
// a list of complaints. The bottom is the findings — and only the ones that
// change what happens, because a panel that lists everything it could possibly
// object to trains the operator to scroll past all of it.
const TONE = { block: 'err', warn: 'warn', note: '' };

function Fact({ label, value, tone = '' }) {
  return (
    <div style={{ minWidth: 130 }}>
      <div className="hint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
      <div className={tone ? `badge ${tone}` : ''} style={{ fontSize: 13 }}>{value}</div>
    </div>
  );
}

export default function ConfigOverviewPanel({ network, channels = '' }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const q = channels.trim() ? `?channels=${encodeURIComponent(channels.trim())}` : '';
      setData(await api(`/cdn/networks/${network.id}/overview${q}`));
      setError('');
    } catch (e) { setError(e.data?.error || e.message); }
  };
  useEffect(() => { load(); }, [network.id, channels]);

  if (error) return <div className="panel error-box">{error}</div>;
  if (!data) return <div className="panel hint">{t('sd.loading')}</div>;
  const s = data.summary;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{t('cfg.title')}</h2>
      <div className="hint">{t('cfg.intro')}</div>

      <div className="row" style={{ gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
        <Fact label={t('cfg.f.audience')} value={t('cdn.audience.' + s.audience)} />
        <Fact label={t('cfg.f.shape')} value={t('cfg.shapeValue', {
          origin: s.roles.origin || 0, edge: s.roles.edge || 0, mid: s.roles.mid || 0,
        })} />
        <Fact label={t('cfg.f.mode')} value={t('gw.mode.' + s.gateway.mode)} />
        <Fact label={t('cfg.f.policy')} value={t('gw.policy.' + s.gateway.policy)} />
        <Fact label={t('cfg.f.whenDown')} value={t('gw.down.' + s.gateway.whenAllDown)} />
        <Fact label={t('cfg.f.domain')} value={s.gateway.domain || t('cfg.none')} />
        <Fact label={t('cfg.f.agents')} value={`${s.agents} / ${s.nodes}`} />
        <Fact label={t('cfg.f.routes')} value={String(s.routes)} />
        <Fact label={t('cfg.f.geo')}
              value={s.geo?.present
                ? (s.geo.hasCoordinates ? t('cfg.geoCity') : t('cfg.geoCountry'))
                : t('cfg.none')} />
      </div>

      <div className="gsection">{t('cfg.findings')}</div>
      {!data.findings.length ? (
        <div className="hint">{t('cfg.allClear')}</div>
      ) : (
        <>
          {/* What is actually required of the operator, said first. A list of
              observations reads as a list of demands unless it says which of
              them are demands — and here that is usually none. */}
          <div className="hint" style={{ fontSize: 12, marginBottom: 8 }}>
            {data.counts.block
              ? t('cfg.mustFix', { n: data.counts.block })
              : t('cfg.nothingRequired')}
            {' '}
            {t('cfg.counts', { block: data.counts.block, warn: data.counts.warn, note: data.counts.note })}
          </div>
          {data.findings.map((f, i) => (
            <div key={i} className={f.severity === 'block' ? 'error-box' : 'hint'} style={{ marginBottom: 6 }}>
              <div className="row" style={{ gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={'badge ' + (TONE[f.severity] || '')}>{t('cdn.sev.' + f.severity)}</span>
                <span>{t('cfg.' + f.code)}</span>
                {f.subject && <b>{f.subject}</b>}
                {f.application && <span className="mono">{f.application}</span>}
              </div>
              {/* What to do, always — the same contract the error dialog keeps.
                  A finding with no fix is a complaint. */}
              <div style={{ fontSize: 11, marginTop: 2 }}>
                {t('cfg.' + f.code + '.fix', { have: f.have, need: f.need })}
              </div>
              {f.from && <div className="mono" style={{ fontSize: 11 }}>{f.from} → {f.to}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
