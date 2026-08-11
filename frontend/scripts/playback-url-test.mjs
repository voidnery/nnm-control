import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
import { writeFileSync, rmSync } from 'fs';
const out = '/tmp/.playback-bundle.mjs';
await build({ stdin:{contents:`
export { playbackUrls, endpointLabel, embedSnippet, PROTOCOLS, PROTOCOL_LABEL } from '${SRC}/components/StreamPlayback.jsx';
`, resolveDir:SRC, loader:'jsx'}, bundle:true, format:'esm', outfile:out, jsx:'automatic', logLevel:'silent' });
const { playbackUrls, endpointLabel, embedSnippet, PROTOCOLS, PROTOCOL_LABEL } = await import(out);
rmSync(out, { force: true });
let bad = 0;
const check = (n, got, want) => { const ok = got === want; if (!ok) bad++; console.log(`  ${ok?'✓':'✗'} ${n}: ${got}${ok?'':' (want '+want+')'}`); };
let u = playbackUrls({ host:'cdn.example.com', hlsPort:8081, rtmpPort:1935, ssl:false }, 'live', 'cam1');
check('HLS default ports', u.hls, 'http://cdn.example.com:8081/live/cam1/playlist.m3u8');
check('RTMP default ports', u.rtmp, 'rtmp://cdn.example.com:1935/live/cam1');
u = playbackUrls({ host:'edge.tv', hlsPort:443, rtmpPort:1936, ssl:true }, 'app', 'st');
check('HTTPS + custom ports', u.hls, 'https://edge.tv:443/app/st/playlist.m3u8');
check('RTMP custom port', u.rtmp, 'rtmp://edge.tv:1936/app/st');
u = playbackUrls({ host:'h' }, 'a', 's');
check('falls back to Nimble defaults', u.hls, 'http://h:8081/a/s/playlist.m3u8');
check('no endpoint -> null', String(playbackUrls(null,'a','s')), 'null');
check('label with name', endpointLabel({ label:'CDN', host:'h' }), 'CDN (h)');
check('label without name', endpointLabel({ host:'h' }), 'h');

// iter9 m2 - the rest of the protocols WMSPanel offers alongside HLS/RTMP.
// Shapes pinned from Softvelum's published URL formats.
u = playbackUrls({ host:'cdn.example.com', httpPort:8081, rtmpPort:1935, ssl:false }, 'live', 'cam1');
check('MPEG-DASH manifest', u.dash, 'http://cdn.example.com:8081/live/cam1/manifest.mpd');
check('SLDP over ws', u.sldp, 'sldp://cdn.example.com:8081/live/cam1');
check('WebRTC WHEP', u.whep, 'http://cdn.example.com:8081/live/cam1/whep.stream');
check('Icecast', u.icecast, 'http://cdn.example.com:8081/live/cam1/icecast.stream');

u = playbackUrls({ host:'edge.tv', httpPort:443, rtmpPort:1936, ssl:true }, 'app', 'st');
check('SLDP goes secure with the endpoint', u.sldp, 'sldps://edge.tv:443/app/st');
check('DASH goes secure with the endpoint', u.dash, 'https://edge.tv:443/app/st/manifest.mpd');

// A pre-iter9 endpoint stored hlsPort; it must keep resolving to the same URL.
u = playbackUrls({ host:'legacy.tv', hlsPort:8088, rtmpPort:1935 }, 'a', 's');
check('legacy hlsPort still honoured', u.hls, 'http://legacy.tv:8088/a/s/playlist.m3u8');

// httpPort wins when both are present, so a resolved endpoint is never
// shadowed by a stale hand-entered number.
u = playbackUrls({ host:'h', httpPort:9000, hlsPort:8081 }, 'a', 's');
check('httpPort takes precedence over hlsPort', u.hls, 'http://h:9000/a/s/playlist.m3u8');

check('every advertised protocol is actually built', PROTOCOLS.every(k => typeof u[k] === 'string' && u[k].length) ? 'yes' : 'no', 'yes');
check('every protocol has a label', PROTOCOLS.every(k => Boolean(PROTOCOL_LABEL[k])) ? 'yes' : 'no', 'yes');
check('RTSP is not offered (port is unknowable)', String(u.rtsp), 'undefined');

const snip = embedSnippet(u);
check('embed snippet carries the HLS url', snip.includes(u.hls) ? 'yes' : 'no', 'yes');
check('embed snippet closes its script tags', snip.split('</' + 'script>').length - 1, 2);
check('no snippet without urls', embedSnippet(null), '');

console.log(bad ? `${bad} failed` : 'all URL checks passed');
process.exit(bad?1:0);
