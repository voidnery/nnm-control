import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import Select from './Select.jsx';

// Playback URLs for a live stream. Which address a viewer should use is an
// operator decision — a box usually answers on its IP plus one or more domain
// names, and protocols sit on their own ports — so the endpoint is chosen from
// the list configured on the server, never guessed from the management address.
export function playbackUrls(endpoint, app, stream) {
  if (!endpoint || !app || !stream) return null;
  const scheme = endpoint.ssl ? 'https' : 'http';
  const hls = `${scheme}://${endpoint.host}:${endpoint.hlsPort || 8081}/${app}/${stream}/playlist.m3u8`;
  const rtmp = `rtmp://${endpoint.host}:${endpoint.rtmpPort || 1935}/${app}/${stream}`;
  return { hls, rtmp };
}

export function endpointLabel(e) {
  return e.label ? `${e.label} (${e.host})` : e.host;
}

// hls.js is loaded on demand: the player is a rarely used surface and the
// library is far larger than the rest of the page.
function HlsPlayer({ url }) {
  const { t } = useI18n();
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let hls = null;
    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;

    // Safari plays HLS natively; everywhere else we need hls.js.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      setLoading(false);
      video.play().catch(() => {});
      return () => { video.removeAttribute('src'); video.load(); };
    }

    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) { setError(t('play.unsupported')); setLoading(false); return; }
      hls = new Hls({ lowLatencyMode: true, liveDurationInfinity: true });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { setLoading(false); video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        setLoading(false);
        setError(`${data.type}: ${data.details}`);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    }).catch(e => { setError(e.message); setLoading(false); });

    return () => { cancelled = true; hls?.destroy(); };
  }, [url, t]);

  return (
    <div>
      <video ref={videoRef} controls muted playsInline
             style={{ width: '100%', background: '#000', borderRadius: 8, aspectRatio: '16 / 9' }} />
      {loading && <div className="hint" style={{ marginTop: 6 }}>{t('play.connecting')}</div>}
      {error && <div className="error-box" style={{ marginTop: 6 }}>{error}<div className="hint">{t('play.errorHint')}</div></div>}
    </div>
  );
}

export function PlaybackModal({ endpoints, initialEndpoint, app, stream, onClose }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [idx, setIdx] = useState(() => Math.max(0, endpoints.findIndex(e => e.host === initialEndpoint?.host)));
  const [playing, setPlaying] = useState(false);
  const endpoint = endpoints[idx];
  const urls = useMemo(() => playbackUrls(endpoint, app, stream), [endpoint, app, stream]);

  const copy = (text) => { navigator.clipboard?.writeText(text); push({ type: 'ok', message: t('play.copied') }); };

  return (
    <Modal onClose={onClose} size="wide">
      <h3 className="mono">{app}/{stream}</h3>
      {endpoints.length > 1 && (
        <div style={{ marginBottom: 10 }}>
          <label>{t('play.endpoint')}</label>
          <Select value={String(idx)} onChange={v => { setIdx(Number(v)); setPlaying(false); }}
                  options={endpoints.map((e, i) => ({ value: String(i), label: endpointLabel(e) }))} />
        </div>
      )}

      {!urls ? <div className="hint">{t('play.noEndpoint')}</div> : (
        <>
          <div className="kv-grid">
            <div className="kv-k">HLS</div>
            <div className="kv-v">
              <div className="row" style={{ gap: 6 }}>
                <span className="mono" style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{urls.hls}</span>
                <button onClick={() => copy(urls.hls)}>{t('srt.copy')}</button>
              </div>
            </div>
            <div className="kv-k">RTMP</div>
            <div className="kv-v">
              <div className="row" style={{ gap: 6 }}>
                <span className="mono" style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{urls.rtmp}</span>
                <button onClick={() => copy(urls.rtmp)}>{t('srt.copy')}</button>
              </div>
            </div>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>{t('play.rtmpNote')}</div>

          <div style={{ marginTop: 12 }}>
            {playing
              ? <HlsPlayer url={urls.hls} />
              : <button className="primary" onClick={() => setPlaying(true)}>▶ {t('play.watch')}</button>}
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
