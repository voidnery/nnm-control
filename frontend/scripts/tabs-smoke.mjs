// Every panel behind a tab, mounted.
//
// pages-smoke opens each page on whichever tab it defaults to and never
// touches the others, so a panel two clicks in could crash for weeks with 213
// checks green — which is exactly what happened: a `useEffect` dependency
// referring to state that had been renamed took the Delivery tab to a black
// screen, and nothing noticed because the page defaults to Channels.
//
// The lesson is not "add this one panel to a fixture". It is that a gate which
// only exercises first screens tests first screens.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

const TABS = [
  ['ChannelsPanel', "{ }"],
  ['DeliveryNetworkPanel', "{ servers: [], onServersChanged(){} }"],
  ['DeliveryGeoPanel', "{ servers: [], onServersChanged(){} }"],
  ['ConfigOverviewPanel', "{ network: { id:'N1', name:'x' } }"],
  ['DeliveryRoutesPanel', "{ network: { id:'N1', name:'x' }, servers: [] }"],
  ['GatewayPanel', "{ network: { id:'N1', name:'x', gateway:{ mode:'direct', policy:'nearest', whenAllDown:'fail' } }, servers: [] }"],
  ['ProbePanel', "{ network: { id:'N1', name:'x' } }"],
  // jsdom has no WebGL, so the globe takes its own no-WebGL path here. That is
  // the point: this asserts it degrades to a message rather than to a blank
  // rectangle, which is a real browser state on machines without hardware
  // acceleration.
  ['GlobePanel', "{ network: { id:'N1', name:'x', nodes: [] }, servers: [] }"],
];

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '${SRC}/i18n.jsx';
import { ToastProvider } from '${SRC}/toast.jsx';
import { ConfirmProvider } from '${SRC}/confirm.jsx';
import { AuthProvider } from '${SRC}/auth.jsx';
import { ThemeProvider } from '${SRC}/theme.jsx';
${TABS.map(([n]) => `import ${n} from '${SRC}/components/${n}.jsx';`).join('\n')}
class B extends React.Component {
  constructor(p){ super(p); this.state = {}; }
  static getDerivedStateFromError(e){ return { e }; }
  componentDidCatch(e){ this.props.onErr(e.message); }
  render(){ return this.state.e ? null : this.props.children; }
}
const wrap = (el, onErr) => React.createElement(B, { onErr },
  React.createElement(ThemeProvider, null, React.createElement(ToastProvider, null,
    React.createElement(AuthProvider, null, React.createElement(I18nProvider, null,
      React.createElement(ConfirmProvider, null, el))))));
window.__RUN = async () => {
  const out = {};
  const cases = { ${TABS.map(([n, p]) => `${n}: React.createElement(${n}, ${p})`).join(', ')} };
  for (const [name, el] of Object.entries(cases)) {
    let err = null;
    const host = document.createElement('div'); document.body.appendChild(host);
    createRoot(host).render(wrap(el, (m) => { err = m; }));
    await new Promise(r => setTimeout(r, 350));
    out[name] = err ? { ok:false, error: err } : { ok: host.innerHTML.length > 40, len: host.innerHTML.length };
    host.remove();
  }
  return out;
};
`;

const res = await build({ stdin:{ contents: entry, resolveDir: SRC, loader:'jsx' }, bundle:true,
  format:'iife', write:false, jsx:'automatic', loader:{'.js':'jsx','.css':'empty','.json':'json'},
  logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'} });

const { VirtualConsole } = await import('jsdom');
const vc = new VirtualConsole();   // deliberately silent: see below
const dom = new JSDOM('<!doctype html><body></body>', { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/', virtualConsole: vc });
dom.window.console.error = () => {};
// jsdom has no canvas, and the globe asks for a WebGL context on purpose to
// find out. The resulting "not implemented" arrives on the virtual console,
// not through console.error, and would otherwise bury the actual results.
dom.virtualConsole?.removeAllListeners?.('jsdomError');
// The real shape: /auth/me answers the user flat, not wrapped in { user }.
dom.window.fetch = (u) => {
  const s = String(u);
  let body = {};
  if (s.includes('/auth/me')) body = { id:'u1', username:'superadmin', roleType:'superadmin', permissions:['*'], preferences:{} };
  else if (/\/cdn\/channels\/overview/.test(s)) body = { rows: [], routesRead: true };
  else if (/\/cdn\/channels/.test(s)) body = { channels: [] };
  else if (/\/cdn\/networks$/.test(s)) body = { networks: [{ id:'N1', name:'x', audience:'internal', nodes:[] }] };
  else if (/\/overview$/.test(s)) body = { summary:{ roles:{}, gateway:{ mode:'direct', policy:'nearest', whenAllDown:'fail', domain:'', node:'' }, audience:'internal', geo:null, routes:0, agents:0, nodes:0 }, findings:[], counts:{ block:0, warn:0, note:0 } };
  else if (/applications$/.test(s)) body = { applications: [], asked: [] };
  else if (/\/cdn\/routes/.test(s)) body = { routes: [] };
  else if (/\/geoip/.test(s)) body = { present:false, editions:[], attribution:{ text:'x', url:'https://db-ip.com' } };
  else if (/\/servers/.test(s)) body = [];
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(body), text:()=>Promise.resolve('{}') });
};
dom.window.localStorage.setItem('nc_token','t');
dom.window.eval(res.outputFiles[0].text);
const r = await dom.window.__RUN();
let bad = 0;
for (const [name, v] of Object.entries(r)) {
  if (v.ok) console.log(`  ✓ ${name} renders (${v.len} chars)`);
  else { console.log(`  ✗ ${name}: ${v.error || 'rendered nothing'}`); bad++; }
}

// The list must not fall behind the tabs. A panel added to the page and not to
// this file is a panel nobody mounts, which is how the gap opened.
const { readFileSync } = await import('node:fs');
const pageSrc = readFileSync(path.join(SRC, 'pages/DistributionPage.jsx'), 'utf8');
const netSrc = readFileSync(path.join(SRC, 'components/DeliveryNetworkPanel.jsx'), 'utf8');
const referenced = new Set([...`${pageSrc}\n${netSrc}`.matchAll(/<(\w+Panel)\b/g)].map(m => m[1]));
const covered = new Set(TABS.map(([n]) => n));
for (const name of referenced) {
  if (!covered.has(name)) {
    console.log(`  ✗ ${name} is rendered by a tab and never mounted here`);
    bad++;
  }
}
if (!bad) console.log(`  ✓ ${covered.size} panel(s) covered, none missing from the page`);

console.log(bad ? `\n${bad} tab problem(s)` : '\ntab smoke: OK');
process.exit(bad ? 1 : 0);
