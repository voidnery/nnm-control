import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = '/home/claude/nnm-control/frontend/src';
const SAMPLE = {
  servers: [{ id: 'S1', name: 'Src', wmspanelServerId: 'w1' }, { id: 'S2', name: 'Dst', wmspanelServerId: 'w2' }],
  udp: { settings: [{ id: 'u1', name: 'out1', protocol: 'srt', ip: '1.2.3.4', port: 9000, paused: false, source_streams: [{ application: 'a', stream: 's' }] }] },
  outgoing: { streams: [{ id: 'o1', application: 'app', stream: 'st', paused: 'false', status: 'synced', video_source: { id: 'v' } }] },
  livepull: { settings: [{ id: 'p1', application: 'app', stream: 'st', url: 'rtmp://x', fallback_urls: [], paused: false }] },
  incoming: { streams: [{ id: 'i1', name: 'in1', protocol: 'srt', ip: '1.2.3.4', port: 9000, status: 'online', receive_mode: 'listen' }] },
  hotswap: { settings: [] }, apps: { applications: [] }, interfaces: { interfaces: [] }, streams: { streams: [] },
  tags: { map: {}, catalog: [] },
};
function pick(u){
  u=String(u);
  if(u.includes('/stream-tags/'))return SAMPLE.tags;
  if(u.endsWith('/servers'))return SAMPLE.servers;
  if(u.includes('/udp'))return SAMPLE.udp;
  if(u.includes('/outgoing'))return SAMPLE.outgoing;
  if(u.includes('/livepull')||u.includes('/live_pull'))return SAMPLE.livepull;
  if(u.includes('/incoming'))return SAMPLE.incoming;
  if(u.includes('/hotswap'))return SAMPLE.hotswap;
  if(u.includes('/applications')||u.includes('/apps'))return SAMPLE.apps;
  if(u.includes('/interfaces'))return SAMPLE.interfaces;
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
const NAMES = ['UdpTab','OutgoingTab','LivePullTab','MpegtsInTab','HotswapTab','AppsTab','InterfacesTab','WmsStreamsTab'];
window.__RENDER_ALL = async () => {
  const out = {};
  for (const name of NAMES) {
    const Comp = Tabs[name];
    const el = document.createElement('div'); document.body.appendChild(el);
    try {
      const root = createRoot(el);
      root.render(React.createElement(ThemeProvider,null,
        React.createElement(ToastProvider,null,
          React.createElement(AuthProvider,null,
            React.createElement(I18nProvider,null,
              React.createElement(ConfirmProvider,null,
                React.createElement(Comp,{serverId:'S1'})))))));
      await new Promise(r=>setTimeout(r,200));
      out[name] = { ok:true, len: el.innerHTML.length };
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
window.eval(code);
const results = await window.__RENDER_ALL();

console.log('RENDER SMOKE (with data):');
let bad=0;
for (const [n,r] of Object.entries(results)){ if(!r.ok)bad++; console.log(`  ${r.ok?'✓':'✗'} ${n}: ${r.ok?('ok, '+r.len+' chars'):('CRASH: '+r.error)}`); }
const realErrs = consoleErrors.filter(e=>/is not defined|Cannot read|is not a function|Minified React error/.test(e));
if(realErrs.length){ console.log('\nRENDER ERRORS:'); realErrs.slice(0,8).forEach(e=>console.log('  !', e.slice(0,160))); bad+=realErrs.length; }
process.exit(bad?1:0);
