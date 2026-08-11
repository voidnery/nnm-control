import { useI18n } from '../i18n.jsx';

// Delivery, drawn the way it runs.
//
// The state used to be a table with columns "on origin", "on edge" and a
// verdict — every fact present and nothing legible. An operator reading it had
// to hold the direction of the flow in their head and map two numbers onto it,
// which is the job the picture does for free. So this is the same three-column
// board the transcoder screens use: what feeds it, what carries it, what
// serves it, left to right, with the readings on the boxes they belong to.
//
// The verdict is a sentence rather than a tag, because "origin-only" means
// nothing until it is read as "the origin has this and the edge does not".

const TONE = {
  flowing: 'live',
  'origin-only': 'err',
  'no-route': 'err',
  'nothing-upstream': '',
  'edge-unreachable': 'warn',
  'origin-unknown': 'warn',
};

const fmtBw = (bps) => (bps === null || bps === undefined) ? '—'
  : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps`
  : bps >= 1e3 ? `${(bps / 1e3).toFixed(0)} kbps` : `${bps} bps`;

// A reading, or an honest gap where one could not be taken. A zero here would
// be a claim the panel has no right to make about a box that did not answer.
function Reading({ streams, bandwidth, probe, t }) {
  if (streams === null || streams === undefined) {
    return (
      <div>
        <div className="gnode-title">{t('cdn.noReading')}</div>
        {probe?.reason && <div className="hint" style={{ fontSize: 10 }}>{t('cdn.reason.' + probe.reason)}</div>}
      </div>
    );
  }
  return (
    <div>
      <div className="gnode-title">{t('cdn.nStreams', { n: streams })}</div>
      <div className="gnode-sub mono">{fmtBw(bandwidth)}</div>
      {probe && (
        <div className="hint" style={{ fontSize: 10 }}>
          {t(probe.transport === 'agent' ? 'cdn.viaAgent' : 'cdn.viaDirect')}
        </div>
      )}
    </div>
  );
}

export default function DeliveryFlowBoard({ row }) {
  const { t } = useI18n();
  const tone = TONE[row.verdict] ?? '';

  return (
    <div className="gpipe-card">
      <div className="gpipe-h">
        <span className="mono">{row.application}</span>
        <span className={'badge ' + tone}>{t('cdn.said.' + row.verdict)}</span>
        {/* An agent missing on a box is not an error and is worth saying once,
            where the direct read it caused is visible. */}
        {row.edgeProbe?.transport === 'direct' && row.edgeProbe?.ok && (
          <span className="hint" style={{ fontSize: 11 }}>{t('cdn.noAgentHere', { name: row.edge })}</span>
        )}
      </div>

      <div className="gpipe">
        <div className="gcol">
          <div className="gcol-h">{t('cdn.originCol')}</div>
          <div className="gnode in">
            <div className="gnode-title">{row.origin || '—'}</div>
            <Reading streams={row.originStreams} bandwidth={row.originBandwidth} probe={row.originProbe} t={t} />
          </div>
        </div>

        <div className="garrow">→</div>

        <div className="gcol wide">
          <div className="gcol-h">{t('cdn.routeCol')}</div>
          {row.routeId ? (
            <div className="gnode flt">
              <div className="gnode-title mono">{row.application}</div>
              <div className="gnode-sub mono" style={{ wordBreak: 'break-all' }}>{row.to}</div>
            </div>
          ) : (
            <div className="gnode flt" style={{ borderStyle: 'dashed', opacity: .7 }}>
              <div className="gnode-title">{t('cdn.noRouteYet')}</div>
              <div className="gnode-sub">{t('cdn.noRouteHint')}</div>
            </div>
          )}
        </div>

        <div className="garrow">→</div>

        <div className="gcol">
          <div className="gcol-h">{t('cdn.edgeCol')}</div>
          <div className={'gnode ' + (row.verdict === 'flowing' ? 'out' : 'in')}>
            <div className="gnode-title">{row.edge}</div>
            <Reading streams={row.edgeStreams} bandwidth={row.edgeBandwidth} probe={row.edgeProbe} t={t} />
          </div>
        </div>
      </div>

      <div className={'hint' + (tone === 'err' ? ' error-box' : '')} style={{ margin: '0 10px 8px' }}>
        {t('cdn.explain.' + row.verdict, { edge: row.edge, origin: row.origin || '—', app: row.application })}
      </div>
    </div>
  );
}
