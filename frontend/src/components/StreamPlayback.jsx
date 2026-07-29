import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import Select from './Select.jsx';

// Playback URLs for a live stream. Which address a viewer should use is an
// operator decision — a box usually answers on its IP plus one or more domain
// names, and protocols sit on their own ports — so the endpoint is chosen from
// the list configured on the server, never guessed from the management address.
// iter9 m2 — every playback URL Nimble documents for a live stream, in the
// same shapes Softvelum publishes them:
//   HLS   http(s)://host:httpPort/app/stream/playlist.m3u8
//   DASH  http(s)://host:httpPort/app/stream/manifest.mpd
//   SLDP  sldp(s)://host:httpPort/app/stream
//   WHEP  http(s)://host:httpPort/app/stream/whep.stream
//   Ice   http(s)://host:httpPort/app/stream/icecast.stream
//   RTMP  rtmp://host:rtmpPort/app/stream
// RTSP is deliberately absent: Softvelum's own examples use a non-default
// port that depends on the instance's settings, and no endpoint we have
// reports it — a guessed RTSP port would be a URL that silently never plays.
export const PROTOCOLS = ['hls', 'dash', 'sldp', 'whep', 'icecast', 'rtmp'];

export function playbackUrls(endpoint, app, stream) {
  if (!endpoint || !app || !stream) return null;
  const ssl = Boolean(endpoint.ssl);
  const scheme = ssl ? 'https' : 'http';
  // Accept both the resolved shape (httpPort) and a hand-entered endpoint
  // saved before iter9, which called the same number hlsPort.
  const httpPort = Number(endpoint.httpPort || endpoint.hlsPort) || 8081;
  const rtmpPort = Number(endpoint.rtmpPort) || 1935;
  const base = `${scheme}://${endpoint.host}:${httpPort}/${app}/${stream}`;
  return {
    hls: `${base}/playlist.m3u8`,
    dash: `${base}/manifest.mpd`,
    sldp: `${ssl ? 'sldps' : 'sldp'}://${endpoint.host}:${httpPort}/${app}/${stream}`,
    whep: `${base}/whep.stream`,
    icecast: `${base}/icecast.stream`,
    rtmp: `rtmp://${endpoint.host}:${rtmpPort}/${app}/${stream}`,
  };
}

export const PROTOCOL_LABEL = {
  hls: 'HLS', dash: 'MPEG-DASH', sldp: 'SLDP', whep: 'WebRTC WHEP', icecast: 'Icecast', rtmp: 'RTMP',
};

// Minimal embeddable page, mirroring the snippet WMSPanel offers next to its
// stream URLs. Kept dependency-light on purpose: one <video> plus hls.js from
// a CDN, so it can be pasted into any page without a build step.
export function embedSnippet(urls) {
  if (!urls) return '';
  return `<video id="p" controls muted playsinline style="width:100%"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"><\/script>
<script>
  var v = document.getElementById('p'), u = '${urls.hls}';
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = u; }
  else if (window.Hls && Hls.isSupported()) { var h = new Hls(); h.loadSource(u); h.attachMedia(v); }
<\/script>`;
}

// iter9 m2 - endpoints are resolved server-side (WMSPanel hosts + real RTMP
// port) instead of being read straight off the server record, which was empty
// on every auto-synced box and made the whole playback UI invisible.
export function usePlaybackEndpoints(serverId) {
  const [state, setState] = useState({ loading: true, endpoints: [], source: 'none', notes: [] });
  useEffect(() => {
    if (!serverId) return;
    let dead = false;
    setState(s => ({ ...s, loading: true }));
    api(`/servers/${serverId}/playback`)
      .then(d => { if (!dead) setState({ loading: false, endpoints: [], source: 'none', notes: [], ...d }); })
      .catch(e => { if (!dead) setState({ loading: false, endpoints: [], source: 'none', notes: ['resolveFailed'], error: e.message }); });
    return () => { dead = true; };
  }, [serverId]);
  return state;
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
  const [embed, setEmbed] = useState(false);
  const endpoint = endpoints[idx] || null;
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
            {PROTOCOLS.map(proto => (
              <Fragment key={proto}>
                <div className="kv-k">{PROTOCOL_LABEL[proto]}</div>
                <div className="kv-v">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="mono" style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{urls[proto]}</span>
                    <button onClick={() => copy(urls[proto])}>{t('srt.copy')}</button>
                  </div>
                </div>
              </Fragment>
            ))}
          </div>
          {/* iter9 m2 - a port the panel could not read is labelled as such.
              The operator can then either trust it or go set it, instead of
              copying a URL that quietly resolves to nothing. */}
          {endpoint.httpPortOrigin === 'default' && (
            <div className="hint" style={{ marginTop: 6 }}>{t('play.httpPortAssumed', { port: endpoint.httpPort || endpoint.hlsPort })}</div>
          )}
          {endpoint.rtmpPortOrigin === 'default' && (
            <div className="hint">{t('play.rtmpPortAssumed', { port: endpoint.rtmpPort })}</div>
          )}
          <div className="hint" style={{ marginTop: 6 }}>{t('play.rtmpNote')}</div>

          <div style={{ marginTop: 12 }}>
            {playing
              ? <HlsPlayer url={urls.hls} />
              : <button className="primary" onClick={() => setPlaying(true)}>▶ {t('play.watch')}</button>}
          </div>

          <div style={{ marginTop: 12 }}>
            <button onClick={() => setEmbed(v => !v)}>{embed ? t('play.hideEmbed') : t('play.showEmbed')}</button>
            {embed && (
              <div style={{ marginTop: 8 }}>
                <textarea readOnly rows={8} className="mono" style={{ width: '100%', fontSize: 11 }}
                          value={embedSnippet(urls)} onFocus={e => e.target.select()} />
                <button onClick={() => copy(embedSnippet(urls))}>{t('srt.copy')}</button>
              </div>
            )}
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
