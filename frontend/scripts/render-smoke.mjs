import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = '/home/claude/nnm-control/frontend/src';
const SAMPLE = {
  servers: [{ id: 'S1', name: 'Src', wmspanelServerId: 'w1' }, { id: 'S2', name: 'Dst', wmspanelServerId: 'w2' }],
  udp: { settings: [{ id: 'u1', name: 'out1', protocol: 'srt', ip: '1.2.3.4', port: 9000, paused: false, source_streams: [{ application: 'a', stream: 's' }] }] },
  outgoing: { streams: [{ id: 'o1', application: 'app', stream: 'st', paused: 'false', status: 'synced', video_source: { id: 'v' } }] },
  livepull: { settings: [{ id: 'p1', application: 'app', stream: 'st', url: 'rtmp://x', fallback_urls: [], paused: false }] },
  incoming: { streams: [{ id: 'i1', name: 'in1', protocol: 'srt', ip: '1.2.3.4', port: 9000, status: 'online', receive_mode: 'listen' }] },
  hotswap: { settings: [] }, apps: { applications: [] }, interfaces: { interfaces: [] },
  streams: { streams: [{ id: 'st1', application: 'live', stream: 'cam1', status: 'online', protocol: 'RTMP' }] },
  republish: { rules: [{ id: 'r1', src_app: 'live', src_strm: 's', dest_addr: '1.2.3.4', dest_port: 1935, dest_app: 'out', dest_strm: 's' }] },
  tags: { map: {}, catalog: [] },
  me: { id: 'U1', username: 'smoke', permissions: ['*'] },
  publicSettings: { controlPlane: 'wmspanel', wmspanelConfigured: true },
};
function pick(u){
  u=String(u);
  if(u.includes('/stream-tags/'))return SAMPLE.tags;
  if(u.includes('/subjects'))return { subjects:[{ subject:'stream:live/cam1', group:'streams', label:'live/cam1', metrics:['bandwidth'] }] };
  if(u.includes('/series'))return { subject:'stream:live/cam1', metrics:['bandwidth'], bucketMs:0,
    points:[{ ts:new Date(Date.now()-60000).toISOString(), v:[4200000] },{ ts:new Date().toISOString(), v:[4400000] }] };
  if(u.includes('/auth/me'))return SAMPLE.me;
  if(u.includes('/settings/public'))return SAMPLE.publicSettings;
  if(/\/streams(\b|$|\?)/.test(u)&&!u.includes('stream-tags'))return SAMPLE.streams;
  if(u.endsWith('/servers'))return SAMPLE.servers;
  if(u.includes('/udp'))return SAMPLE.udp;
  if(u.includes('/outgoing'))return SAMPLE.outgoing;
  if(u.includes('/livepull')||u.includes('/live_pull'))return SAMPLE.livepull;
  if(u.includes('/incoming'))return SAMPLE.incoming;
  if(u.includes('/hotswap'))return SAMPLE.hotswap;
  if(u.includes('/applications')||u.includes('/apps'))return SAMPLE.apps;
  if(u.includes('/interfaces'))return SAMPLE.interfaces;
  if(u.includes('republish'))return SAMPLE.republish;
  return { status:'Ok' };
}

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '${SRC}/i18n.jsx';
import { ToastProvider } from '${SRC}/toast.jsx';
import { ConfirmProvider } from '${SRC}/confirm.jsx';
import { AuthProvider } from '${SRC}/auth.jsx';
import { ThemeProvider } from '${SRC}/theme.jsx';
import * as Tabs from '${SRC}/pages/WmsObjectsTabs.jsx';
import StatsTab from '${SRC}/pages/StatsTab.jsx';
import RepublishTab from '${SRC}/pages/RepublishTab.jsx';
const ALL = { ...Tabs, RepublishTab, StatsTab };
const NAMES = ['UdpTab','OutgoingTab','LivePullTab','MpegtsInTab','HotswapTab','AppsTab','InterfacesTab','WmsStreamsTab','RepublishTab','StatsTab'];
window.__RENDER_ALL = async () => {
  const out = {};
  for (const name of NAMES) {
    const Comp = ALL[name];
    const el = document.createElement('div'); document.body.appendChild(el);
    try {
      const root = createRoot(el);
      root.render(React.createElement(ThemeProvider,null,
        React.createElement(ToastProvider,null,
          React.createElement(AuthProvider,null,
            React.createElement(I18nProvider,null,
              React.createElement(ConfirmProvider,null,
                React.createElement(Comp,{serverId:'S1', server:{ id:'S1', name:'Src', wmspanelServerId:'w1', playbackEndpoints:[{ label:'CDN', host:'cdn.example.com', hlsPort:8081, rtmpPort:1935, ssl:false }] }})))))));
      await new Promise(r=>setTimeout(r,400));
      out[name] = { ok:true, len: el.innerHTML.length, html: el.innerHTML };
    } catch(e){ out[name] = { ok:false, error:String(e&&e.message||e) }; }
  }
  return out;
};
`;
const res = await build({ stdin:{contents:entry,resolveDir:SRC,loader:'jsx'}, bundle:true, format:'iife', write:false, jsx:'automatic', loader:{'.js':'jsx'}, logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'} });
const code = res.outputFiles[0].text;

const dom = new JSDOM('<!doctype html><body></body>', { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/' });
const { window } = dom;
const consoleErrors = [];
window.console.error = (...a)=>consoleErrors.push(a.map(String).join(' '));
window.fetch = (u)=>Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(pick(u)), text:()=>Promise.resolve(JSON.stringify(pick(u))) });
window.localStorage.setItem('nc_token','smoke-token');
window.eval(code);
const results = await window.__RENDER_ALL();

console.log('RENDER SMOKE (with data):');
let bad=0;
for (const [n,r] of Object.entries(results)){ if(!r.ok)bad++; console.log(`  ${r.ok?'✓':'✗'} ${n}: ${r.ok?('ok, '+r.len+' chars'):('CRASH: '+r.error)}`); }
// Invariant: action buttons (Refresh / + New) must render ABOVE the list table.
// Streams rows must offer the player once the server has playback endpoints.
const streamsHtml = results.WmsStreamsTab?.html || '';
const hasWatch = /Watch|Смотреть/.test(streamsHtml);
console.log('\nPLAYBACK:');
console.log(`  ${hasWatch ? '✓' : '✗'} Streams rows expose the watch action when endpoints are configured`);
if (!hasWatch) bad++;

console.log('\nBUTTON PLACEMENT (Refresh must precede <table>):');
for (const [n,r] of Object.entries(results)) {
  if (!r.ok || !r.html) continue;
  const iBtn = r.html.indexOf('Refresh');
  const iTbl = r.html.indexOf('<table');
  if (iBtn === -1 || iTbl === -1) { console.log(`  – ${n}: n/a`); continue; }
  const good = iBtn < iTbl;
  if (!good) bad++;
  console.log(`  ${good?'✓':'✗'} ${n}: ${good?'buttons on top':'BUTTONS BELOW TABLE'}`);
}

const realErrs = consoleErrors.filter(e=>/is not defined|Cannot read|is not a function|Minified React error/.test(e));
if(realErrs.length){ console.log('\nRENDER ERRORS:'); realErrs.slice(0,8).forEach(e=>console.log('  !', e.slice(0,160))); bad+=realErrs.length; }
process.exit(bad?1:0);
