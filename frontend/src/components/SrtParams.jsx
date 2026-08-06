import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n.jsx';
import SrtHelper from './SrtHelper.jsx';

// SRT parameters as fields.
//
// They were a single input holding raw JSON, typed by hand into a live stream:
// `{"latency":"3000","maxbw":"6250000","rcvbuf":"15728640"}`. A misplaced brace
// there is a stream that does not come back, and nothing checks it before it is
// sent.
//
// The five below are the ones this fleet actually sets. Everything else SRT
// accepts stays reachable through the JSON box underneath — the point is to
// make the common case typed for you, not to cut off the uncommon one.
//
// Values stay strings: that is how Nimble receives them and how they came back
// from the API, and converting to numbers here would send `3000` where every
// working stream on this fleet has `"3000"`.
const FIELDS = [
  { key: 'latency', unit: 'ms', hint: 'srt.p.latencyHint' },
  { key: 'maxbw', unit: 'bps', hint: 'srt.p.maxbwHint' },
  { key: 'rcvbuf', unit: 'bytes', hint: 'srt.p.rcvbufHint' },
  { key: 'sndbuf', unit: 'bytes', hint: 'srt.p.sndbufHint' },
  { key: 'streamid', unit: '', hint: 'srt.p.streamidHint' },
];
const KNOWN = new Set(FIELDS.map(f => f.key));

/** Parse the stored text, tolerating the empty and the broken. */
export function parseParams(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: true, obj: {} };
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, obj: {}, reason: 'not a set of parameters' };
    }
    return { ok: true, obj };
  } catch (e) {
    return { ok: false, obj: {}, reason: String(e.message).slice(0, 80) };
  }
}

export default function SrtParams({ value, onChange, helper = true }) {
  const { t } = useI18n();
  const [showHelper, setShowHelper] = useState(false);
  const { ok, obj, reason } = parseParams(value);

  // Anything the fields do not cover, kept as JSON so a parameter this panel
  // has never heard of survives an edit rather than being dropped by it.
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !KNOWN.has(k)));

  const write = (next) => {
    // Everything that was there, then the change. Merging `rest` alone kept
    // only the parameters this panel does not model and dropped the four it
    // does — so editing latency silently removed maxbw and rcvbuf from a live
    // stream, and the form still looked right because it re-read what it had
    // just written.
    const merged = { ...obj, ...next };
    for (const [k, v] of Object.entries(merged)) {
      if (v === '' || v == null) delete merged[k];
    }
    onChange(Object.keys(merged).length ? JSON.stringify(merged) : '');
  };

  if (!ok) {
    // Editing a value that could not be read would silently discard whatever
    // is actually there. The text stays, and the fields wait.
    return (
      <div>
        <label>{t('srt.p.title')}</label>
        <div className="hint" style={{ color: 'var(--warn)' }}>{t('srt.p.unreadable', { why: reason })}</div>
        <input className="mono" value={value || ''} onChange={e => onChange(e.target.value)} />
      </div>
    );
  }

  return (
    <div>
      <label>{t('srt.p.title')}</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
        {FIELDS.map(f => (
          <label key={f.key} className="srt-param">
            <span>{t(`srt.p.${f.key}`)}{f.unit && <span className="hint">, {f.unit}</span>}</span>
            <input value={obj[f.key] ?? ''} placeholder={t(f.hint)}
                   onChange={e => write({ [f.key]: e.target.value })} />
          </label>
        ))}
      </div>

      {/* The tuning helper, where the numbers it produces have somewhere to
          go. It lived on the tab above the list, where it could only offer
          text to copy — and folded away, because most edits are not a
          retuning. */}
      {helper && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowHelper(v => !v)}>
            {showHelper ? t('srt.hideHelper') : t('srt.showHelper')}
          </button>
          {/* Beside the form, not below it: the numbers are computed on one
              side and land on the other, and both have to be visible for that
              to be one action instead of two.
              Portalled because the dialog scrolls its own content — a child
              placed to its left would be clipped by that overflow — and fixed
              against the dialog's own centring rather than measured, so it
              cannot drift out of step with it. */}
          {showHelper && createPortal(
            <div className="srt-helper-side" onClick={e => e.stopPropagation()}>
              <SrtHelper onApply={next => write(next)} />
            </div>,
            document.body,
          )}
        </div>
      )}

      {/* Everything else SRT accepts. Shown only when there is something in it,
          so the common case is five fields and not five fields plus a box of
          JSON nobody needs. */}
      {Object.keys(rest).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="hint">{t('srt.p.other', { n: Object.keys(rest).length })}</div>
          <input className="mono" value={JSON.stringify(rest)} readOnly />
        </div>
      )}
    </div>
  );
}
