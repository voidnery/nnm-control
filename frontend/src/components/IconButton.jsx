import { useI18n } from '../i18n.jsx';

// A verb as a glyph, with its word kept.
//
// The action columns had grown to five text buttons — "Switch source",
// "Change", "Restart", "Delete" and a start/stop — which is most of the width
// of a row of eighty-three rules, and left the thing the row is about squeezed
// into what remained.
//
// The word does not go away: it is the tooltip and the accessible name. An
// icon alone is a guess until it has been learned, and some of these stop a
// broadcast. The glyphs are the ones already learned from media players rather
// than anything invented here.
const GLYPH = {
  start: '▶',
  stop: '⏸',
  restart: '⟳',
  edit: '✎',
  remove: '✕',
  duplicate: '⧉',
  source: '⇄',
  history: '◷',
  up: '↑',
  down: '↓',
  // iter21 m2 — handing a link to somebody, and watching it. Both are verbs
  // that appear beside a URL, where a text button would be wider than the URL
  // is readable.
  copy: '⧉',
  play: '▷',
};

export default function IconButton({ action, label, danger, disabled, onClick, title }) {
  const { t } = useI18n();
  const word = label || t(`act.${action}`);
  return (
    <button className={`icon${danger ? ' danger' : ''}`}
            disabled={disabled}
            onClick={onClick}
            title={title || word}
            aria-label={word}>
      {GLYPH[action] || '·'}
      <span className="lbl">{word}</span>
    </button>
  );
}

export { GLYPH };
