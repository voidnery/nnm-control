import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';

// Setting up a delivery network, in the order it is actually done.
//
// Everything here existed already, spread across six equal tabs — which
// answers "where is that setting" and never "what do I do next", and the
// second is the question somebody has the first time. So: a list, in order,
// each step saying whether it is done, one open at a time.
//
// One open at a time is also what stops the page growing downwards. It was not
// that the panels were too long; it was that all of them were on screen at
// once and each one grew when used.
//
// The steps do not block each other. Step five opens whether or not step four
// is finished — the panel says what is missing and gets out of the way. A
// wizard that leads by the hand is intolerable the second time, and a network
// is configured once and lived with for months.

const TONE = { done: 'live', action: 'warn', empty: '', unknown: 'warn' };

function Step({ id, n, state, summary, code, open, onOpen, children }) {
  const { t } = useI18n();
  // The one-line answer, built from the step's own numbers, so a collapsed
  // step still says something rather than only its name.
  const line = code
    ? t('step.' + id + '.' + code)
    : t('step.' + id + '.' + state, summary || {});
  return (
    <div className={'step' + (open ? ' open' : '')}>
      <button className="step-head" onClick={onOpen}>
        <span className={'step-mark ' + (TONE[state] || '')}>
          {state === 'done' ? '✓' : state === 'action' ? '!' : n}
        </span>
        <span className="step-title">{t('step.' + id)}</span>
        <span className="step-line hint">{line}</span>
        <span className="step-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="step-body">{children}</div>}
    </div>
  );
}

export default function NetworkSetup({ network, servers, derived, onReload, children }) {
  const { t } = useI18n();
  const steps = derived?.steps;
  const [open, setOpen] = useState('');

  // Opens on whatever wants attention, once, and then leaves the operator
  // alone: re-opening a step under someone's cursor because the data changed
  // is the panel arguing with them.
  useEffect(() => {
    if (!steps || open) return;
    setOpen(steps.next || steps.steps[0]?.id || '');
  }, [steps]);

  const byId = useMemo(() => new Map((steps?.steps || []).map(s => [s.id, s])), [steps]);
  const st = (id) => byId.get(id) || { state: 'unknown', summary: {} };

  if (!steps) return <div className="panel hint">{t('sd.loading')}</div>;

  const slot = (id) => children?.[id] ?? null;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{t('step.title')}</h2>
        <span className={'badge ' + (steps.done === steps.total ? 'live' : '')}>
          {t('step.progress', { done: steps.done, total: steps.total })}
        </span>
      </div>
      <div className="hint">{t('step.intro')}</div>

      <div className="steps" style={{ marginTop: 14 }}>
        {['members', 'upstreams', 'channels', 'nimble', 'links', 'verify'].map((id, i) => (
          <Step key={id} id={id} n={i + 1} {...st(id)}
                open={open === id} onOpen={() => setOpen(o => (o === id ? '' : id))}>
            {slot(id)}
          </Step>
        ))}
      </div>
    </div>
  );
}
