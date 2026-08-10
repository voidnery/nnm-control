import { useI18n } from '../i18n.jsx';
import { layoutPipeline } from '../lib/pipelineLayout.js';

// The one place a pipeline is laid out: source -> processing -> encoders.
//
// It used to exist only in the read-only scenario view. Editing the same
// pipeline flattened every element of every pipeline of both kinds into a
// single table, so a scenario with four decoders and one encoder became nine
// undifferentiated rows and nothing on screen said which row belonged to which
// stage, let alone which pipeline. The clone wizard had the same table and the
// same problem.
//
// Editing something should happen on the picture of the thing, not on a
// property list beside it — so all three screens render this component and
// differ only in what goes inside a node. That also means a change to the shape
// of a scenario cannot show up in one screen and not the others.
export function GNode({ kind = '', changed = false, role, aside, children }) {
  return (
    <div className={'gnode ' + kind + (changed ? ' changed' : '')}>
      {(role || aside) && (
        <div className="gnode-head">
          <span className="gnode-role">{role}</span>
          {aside && <span className="gnode-aside mono">{aside}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

// A labelled field sized for a node rather than a table cell.
export function GField({ label, value, onChange, placeholder, disabled }) {
  return (
    <label className="gfield">
      <span>{label}</span>
      <input className="mono" value={value} placeholder={placeholder} disabled={disabled}
             onChange={e => onChange(e.target.value)} />
    </label>
  );
}

export default function PipelineBoard({
  pipeline, kind = 'video', index = 0, meta,
  renderInput, renderFilter, renderOutput,
  edit = false,
}) {
  const { t } = useI18n();
  const L = layoutPipeline(pipeline);
  const col = 'gcol' + (edit ? ' edit' : '');

  // Filters are rendered by the caller when it wants them interactive, and by
  // a default read-only node otherwise — a pipeline drawn without its
  // processing stage is not the same pipeline.
  const filterNode = (f, section, n) => renderFilter
    ? renderFilter(f, { section, index: n })
    : null;

  return (
    <div className="gpipe-card">
      <div className="gpipe-h">
        <span className={'badge' + (kind === 'audio' ? ' warn' : '')}>{t('tg.' + kind)}</span>
        <span className="gpipe-name">{t('tg.pipelineN', { n: index + 1 })}</span>
        <span className="hint">
          {t('tg.pipeMeta', {
            i: (pipeline.inputs || []).length,
            f: (pipeline.filters || []).length,
            o: (pipeline.outputs || []).length,
          })}
        </span>
        {meta}
      </div>

      <div className="gpipe">
        <div className={col}>
          <div className="gcol-h">{t('tg.source')}</div>
          {L.inputs.map((i, n) => renderInput(i, { index: n }))}
          {!L.inputs.length && <div className="hint">—</div>}
        </div>

        <div className="garrow">→</div>

        <div className={col + ' wide'}>
          <div className="gcol-h">{t('tg.processing')}</div>
          {L.pre.map((f, n) => filterNode(f, 'pre', n))}
          {L.split && filterNode(L.split, 'split', 0)}
          {L.post.length > 0 && (
            <div className="gbranchbox">
              <div className="gbranch-h">{t('tg.perBranch')}</div>
              {L.post.map((f, n) => filterNode(f, 'post', n))}
              <div className="hint gbranch-note">{t('tg.branchUnknown')}</div>
            </div>
          )}
          {!L.pre.length && !L.split && !L.post.length && <div className="hint">{t('tg.passthrough')}</div>}
        </div>

        <div className="garrow">→</div>

        <div className={col}>
          <div className="gcol-h">{t('tg.encoders')}</div>
          {L.outputs.map((o, n) => renderOutput(o, { index: n }))}
          {!L.outputs.length && <div className="hint">—</div>}
        </div>
      </div>
    </div>
  );
}
