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

// The steps as a row of cards with arrows between them, and the one you open
// growing out of the card you clicked.
//
// A vertical list of six accordions said "these are six settings". A chain
// says "this is one path, and here is where you are on it" — which is the
// thing the list could not say and the reason an operator who had used it for
// a week still asked what order to work in.
//
// The panel scales out of its own card so the connection between the two is
// visible rather than implied by proximity. `prefers-reduced-motion` turns the
// growth off: an animation is a way of saying where something came from, and
// somebody who has asked for less of it has already been told.

function StepCard({ id, n, state, summary, code, open, onOpen }) {
  const { t } = useI18n();
  const line = code
    ? t('step.' + id + '.' + code)
    : t('step.' + id + '.' + state, summary || {});
  return (
    <button className={'stepcard' + (open ? ' open' : '') + ' ' + state}
            onClick={onOpen} aria-expanded={open}>
      <span className={'step-mark ' + (TONE[state] || '')}>
        {state === 'done' ? '✓' : state === 'action' ? '!' : n}
      </span>
      <span className="stepcard-title">{t('step.' + id)}</span>
      <span className="stepcard-line">{line}</span>
    </button>
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

      <div className="stepchain">
        {['members', 'upstreams', 'channels', 'nimble', 'links', 'verify'].map((id, i) => (
          <div className="stepchain-cell" key={id}>
            {i > 0 && <span className="stepchain-arrow" aria-hidden="true">→</span>}
            <StepCard id={id} n={i + 1} {...st(id)}
                      open={open === id} onOpen={() => setOpen(o => (o === id ? '' : id))} />
          </div>
        ))}
      </div>

      {/* The panel, growing out of the card. Keyed on the open step so React
          replaces it rather than reusing it, which is what makes the animation
          read as "this one opened" instead of "the contents changed". */}
      {open && (
        <div className="steppop" key={open}>
          <div className="steppop-head">
            <b>{t('step.' + open)}</b>
            <button className="steppop-close" onClick={() => setOpen('')} aria-label={t('action.close')}>✕</button>
          </div>
          <div className="steppop-body">{slot(open)}</div>
        </div>
      )}
    </div>
  );
}
