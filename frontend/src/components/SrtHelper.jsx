import { useState } from 'react';
import { compute, SCENARIOS } from '../lib/srtHelper.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Select from './Select.jsx';
import { copyText } from '../lib/clipboard.js';

// Collapsible SRT tuning helper. Given a bitrate, channel scenario and a
// "drops observed" flag, it produces Nimble SRT params, a URL query, sysctl
// and human notes. Shown on SRT tabs when enabled in system settings.
// `onApply` turns the helper from a calculator into part of the form.
//
// On the tab it could only offer text to copy, because it had no stream in
// front of it. Inside a stream's own settings it does, so the numbers it
// computes can go straight into the fields — which is the whole reason the
// operator was copying them by hand.
export default function SrtHelper({ onApply }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [bitrate, setBitrate] = useState('5000');
  const [scenario, setScenario] = useState('russia');
  const [drops, setDrops] = useState(false);
  const [rtt, setRtt] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');

  const run = () => {
    setErr('');
    try { setRes(compute(Number(bitrate), scenario, drops, rtt || null)); }
    catch (e) { setErr(e.message); setRes(null); }
  };
  const copy = async (text) => push(await copyText(text)
    ? { type: 'ok', message: t('srt.copied') }
    : { type: 'error', message: t('copy.failed') });

  const notes = res ? buildNotes(res, t) : [];

  return (
    <div className="panel" style={{ borderStyle: 'dashed' }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <b>{t('srt.title')}</b>
        <span className="caret">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div>
              <label>{t('srt.bitrate')}</label>
              <input type="number" value={bitrate} onChange={e => setBitrate(e.target.value)} />
            </div>
            <div>
              <label>{t('srt.scenario')}</label>
              <Select value={scenario} onChange={setScenario}
                      options={SCENARIOS.map(s => ({ value: s, label: t('srt.scenario.' + s) }))} />
            </div>
            <div>
              <label>{t('srt.rtt')}</label>
              <input type="number" placeholder="auto" value={rtt} onChange={e => setRtt(e.target.value)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                <input type="checkbox" checked={drops} onChange={e => setDrops(e.target.checked)} />
                {t('srt.drops')}
              </label>
            </div>
          </div>
          <button className="primary" style={{ marginTop: 10 }} onClick={run}>{t('srt.compute')}</button>
          {err && <div className="error-box">{err}</div>}

          {res && (
            <div style={{ marginTop: 12 }}>
              <div className="kv-grid">
                <div className="kv-k">latency</div><div className="kv-v mono">{res.latency} ms</div>
                <div className="kv-k">maxbw</div><div className="kv-v mono">{res.maxbw.toLocaleString()} B/s (~{res.maxbwMbps.toFixed(1)} Mbps)</div>
                <div className="kv-k">sndbuf / rcvbuf</div><div className="kv-v mono">{res.buf.toLocaleString()} B ({res.bufMb} MB)</div>
                {res.needFc && <><div className="kv-k">fc</div><div className="kv-v mono">{res.fc.toLocaleString()}</div></>}
                <div className="kv-k">RTT</div><div className="kv-v mono">{res.rtt} ms</div>
              </div>

              <label style={{ marginTop: 10 }}>{t('srt.params')}</label>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <pre className="mono panel" style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap' }}>{res.paramBlock}</pre>
                <button onClick={() => copy(res.paramBlock)}>{t('srt.copy')}</button>
                {onApply && (
                  <button className="primary" onClick={() => {
                    // Only the three it computes. Anything else already set on
                    // the stream is left alone: a calculator has no opinion
                    // about a stream id.
                    onApply({ latency: String(res.latency), maxbw: String(res.maxbw), rcvbuf: String(res.buf) });
                    push({ type: 'ok', message: t('srt.applied') });
                  }}>{t('srt.apply')}</button>
                )}
              </div>

              <label style={{ marginTop: 10 }}>{t('srt.url')}</label>
              <div className="row">
                <input className="mono" readOnly value={res.urlQuery} style={{ flex: 1 }} />
                <button onClick={() => copy(res.urlQuery)}>{t('srt.copy')}</button>
              </div>

              <label style={{ marginTop: 10 }}>{t('srt.sysctl')}</label>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <pre className="mono panel" style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap' }}>{res.sysctlBlock}</pre>
                <button onClick={() => copy(res.sysctlBlock)}>{t('srt.copy')}</button>
              </div>

              <label style={{ marginTop: 10 }}>{t('srt.notes')}</label>
              <ul className="hint" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {notes.map((n, i) => <li key={i} style={{ marginBottom: 4 }}>{n}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Notes are localized here (the Python engine emitted Russian prose; we key
// them so they follow the panel locale).
function buildNotes(res, t) {
  const n = [t('srt.note.bothEnds'), t('srt.note.maxbwBytes')];
  if (!res.drops) n.push(t('srt.note.healthy', { mult: res.maxbwMult }));
  else { n.push(t('srt.note.dropMode')); n.push(t('srt.note.dropBuffers')); }
  if (res.scenario === 'inter') n.push(t('srt.note.inter'));
  n.push(t('srt.note.stats'));
  if (res.needFc) n.push(t('srt.note.fc', { fc: res.fc.toLocaleString() }));
  n.push(t('srt.note.sysctl'));
  return n;
}
