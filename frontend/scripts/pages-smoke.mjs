// Mounts every top-level page with providers + router and sample API data.
// The tab-level smoke never covered these, so a crash in ServersPage/UsersPage/
// etc. could ship unnoticed.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = '/home/claude/nnm-control/frontend/src';

const PAGES = [
  ['DashboardPage','/'], ['ServersPage','/servers'], ['ServerDetailPage','/servers/S1'],
  ['UsersPage','/users'], ['RolesPage','/roles'], ['AuditPage','/audit'],
  ['SettingsPage','/settings'], ['FunctionsPage','/functions'], ['TranscodersPage','/transcoders'],
  ['DistributionPage','/distribution'], ['PlaylistsPage','/playlists'], ['ZabbixPage','/zabbix'], ['CategoriesPage','/categories'],
  ['ProfilePage','/profile'], ['ServerAgentsPage','/agents'], ['LogsPage','/logs'], ['LogCategoriesPage','/logs/categories'], ['LogDashboardsPage','/logs/dashboards'],
];

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nProvider } from '${SRC}/i18n.jsx';
import { ToastProvider } from '${SRC}/toast.jsx';
import { ConfirmProvider } from '${SRC}/confirm.jsx';
import { AuthProvider } from '${SRC}/auth.jsx';
import { ThemeProvider } from '${SRC}/theme.jsx';
${PAGES.map(([p]) => `import ${p} from '${SRC}/pages/${p}.jsx';`).join('\n')}
const PAGES = { ${PAGES.map(([p]) => p).join(', ')} };

// Modals/editors never render on first paint, so a crash inside them (e.g. a
// step editor) survives a plain page smoke. Open them explicitly.
window.__EDITOR = async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(ThemeProvider,null,
    React.createElement(ToastProvider,null,
      React.createElement(AuthProvider,null,
        React.createElement(I18nProvider,null,
          React.createElement(ConfirmProvider,null,
            React.createElement(MemoryRouter,{ initialEntries:['/functions'] },
              React.createElement(PAGES.FunctionsPage))))))));
  await new Promise(r=>setTimeout(r,400));
  const btns = Array.from(host.querySelectorAll('button'));
  const edit = btns.find(b => /Edit|Изменить/i.test(b.textContent));
  if (!edit) { root.unmount(); host.remove(); return { error:'no Edit button rendered' }; }
  edit.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,350));
  const html = document.body.innerHTML;
  const out = { opened: /modal|Step|шаг/i.test(html), len: host.innerHTML.length };
  root.unmount(); host.remove();
  return out;
};

// Rendering a page proves the render path only. A handler that references an
// identifier which was never declared (onClick={() => move(...)} with no move)
// is invisible to esbuild and to a render smoke — it only fails on click. So
// every button on every page gets clicked, and any ReferenceError-class fault
// is reported. Handlers are harmless here: fetch is mocked and nothing leaves
// the jsdom sandbox.
window.__CLICKS = async (name, path) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const Comp = PAGES[name];
  const root = createRoot(host);
  const faults = [];
  const onErr = (ev) => {
    const m = String((ev && ev.error && ev.error.message) || (ev && ev.message) || ev);
    // "Cannot read properties of undefined" is the same class of defect as an
    // unbound handler: a click that takes the page down. Added after the gate
    // watched one happen and stayed green.
    if (/is not defined|is not a function|Cannot read properties/.test(m)) faults.push(m);
  };
  window.addEventListener('error', onErr);
  try {
    root.render(React.createElement(ThemeProvider,null,
      React.createElement(ToastProvider,null,
        React.createElement(AuthProvider,null,
          React.createElement(I18nProvider,null,
            React.createElement(ConfirmProvider,null,
              React.createElement(MemoryRouter,{ initialEntries:[path] },
                React.createElement(Routes,null,
                  React.createElement(Route,{ path: path.includes('S1') ? '/servers/:id' : path, element: React.createElement(Comp) })))))))));
    await new Promise(r=>setTimeout(r,400));
    const btns = Array.from(host.querySelectorAll('button')).filter(b => !b.disabled);
    for (const b of btns) {
      try { b.dispatchEvent(new window.MouseEvent('click',{bubbles:true})); }
      catch (e) { onErr(e); }
      await new Promise(r=>setTimeout(r,5));
    }
    return { ok:true, clicked: btns.length, faults };
  } catch (e) {
    return { ok:false, clicked:0, faults:[String(e && e.message || e)] };
  } finally {
    window.removeEventListener('error', onErr);
    try { root.unmount(); } catch {}
    host.remove();
  }
};

window.__PAGE = async (name, path) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const Comp = PAGES[name];
  const root = createRoot(host);
  try {
    root.render(React.createElement(ThemeProvider,null,
      React.createElement(ToastProvider,null,
        React.createElement(AuthProvider,null,
          React.createElement(I18nProvider,null,
            React.createElement(ConfirmProvider,null,
              React.createElement(MemoryRouter,{ initialEntries:[path] },
                React.createElement(Routes,null,
                  React.createElement(Route,{ path: path.includes('S1') ? '/servers/:id' : path, element: React.createElement(Comp) })))))))));
    await new Promise(r=>setTimeout(r,400));
    const out = { ok:true, len: host.innerHTML.length };
    root.unmount(); host.remove();
    return out;
  } catch(e) {
    try { root.unmount(); } catch {}
    return { ok:false, error: String(e && e.message || e) };
  }
};
`;

const res = await build({ stdin:{contents:entry,resolveDir:SRC,loader:'jsx'}, bundle:true, format:'iife',
  write:false, jsx:'automatic', logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'} });

const dom = new JSDOM('<!doctype html><body></body>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const { window } = dom;
const errors = [];
window.console.error = (...a) => errors.push(a.map(String).join(' '));
window.fetch = (u) => {
  const s = String(u);
  let body = { status:'Ok' };
  // iter9 m2 - resolved playback endpoints; without this the Streams tabs
  // render with no addresses and the watch buttons never appear.
  if (/\/servers\/[^/]+\/playback/.test(s)) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ endpoints:[{ label:'', host:'edge1.example.com', httpPort:8081, rtmpPort:1935, ssl:false,
      origin:'wmspanel', httpPortOrigin:'default', rtmpPortOrigin:'api' }], source:'wmspanel', apiCalls:2, notes:['httpPortAssumed'] }),
    text:()=>Promise.resolve('{}') });
  if (/\/servers\/[^/]+\/agent$/.test(s)) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ enabled:true, baseUrl:'http://10.0.0.5:8090', hasToken:true }), text:()=>Promise.resolve('{}') });
  if (/\/servers\/[^/]+\/agent\/diagnosis$/.test(s)) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ code:'stopped-polling', severity:'error', lastContactAt:new Date().toISOString(),
      sinceContactMs:120000, evidence:'last contact was 120s ago; the agent parks for at most 25s, so it is not polling',
      hint:'agent.hint.stoppedPolling', agentVersion:5, instanceId:'x', recent:[] }), text:()=>Promise.resolve('{}') });
  if (/\/servers\/[^/]+\/agent\/health$/.test(s)) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ ok:true, version:2, logs:true, confDir:'/srv/nimble/conf', mediaDir:'/srv/nimble/media/gallery',
      logDir:'/var/log/nimble', logExists:true, confExists:true }), text:()=>Promise.resolve('{}') });
  if (/\/log-dashboards$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([
    { id:'D1', name:'Ночной мониторинг', description:'', windows:3, columns:2, refreshSec:30,
      shareEnabled:true, shareExpiresAt:null, shareHits:12, shareLastAt:null, createdBy:'op', updatedAt:new Date().toISOString() }]),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/logs/categories')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    definitions:[], counts:[
      { key:'srt', total:121018, errors:15237, subs:['srtpull','srtlisten'], last:new Date().toISOString() },
      { key:'transcoder', total:9447, errors:0, subs:['remtranmgmt'], last:new Date().toISOString() },
      { key:'rtmp', total:1209, errors:0, subs:['rtmp'], last:null },
      { key:'dvr', total:0, errors:0, subs:[], last:null }] }), text:()=>Promise.resolve('{}') });
  if (s.includes('/logs/facets')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    levels:[{key:'E',n:15341},{key:'D',n:130772}], subs:[{key:'srtpull',n:101815},{key:'remtranmgmt',n:9447}], servers:[] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/logs/groups')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    groups:[{ sub:'srtpull', level:'E', template:'connection closed for [#] socket=N errno=N srterror=[Connection does not exist]',
              count:8661, first:new Date().toISOString(), last:new Date().toISOString(), servers:2, sample:'x', lastOffset:1 }],
    distinct:142, scanned:163628, capped:false }), text:()=>Promise.resolve('{}') });
  if (s.includes('/logs/search')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    rows:[{ id:'r1', serverId:'S1', file:'nimble.log', offset:1, ts:new Date().toISOString(), raw:'2026-07-29T19:14:49',
            pid:1, tid:2, tag:'srtpull0', sub:'srtpull', level:'E', msg:'connection closed', cont:'', contLines:0 }],
    nextBefore:null }), text:()=>Promise.resolve('{}') });
  if (s.includes('/logs/status')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    settings:{ enabled:true, files:['nimble.log'] }, collector:{ mode:'push' }, cursors:[] }), text:()=>Promise.resolve('{}') });
  if (s.includes('/auth/me')) body = { id:'U1', username:'smoke', permissions:['*'] };
  else if (s.includes('/settings/public')) body = { controlPlane:'wmspanel', wmspanelConfigured:true };
  else if (s.includes('/stream-tags/')) body = { map:{} };
  // Two rows on purpose: with a single server both reorder buttons render
  // disabled and the handler-binding gate would never exercise them.
  else if (s.endsWith('/servers')) body = [
    { id:'S1', name:'Srv', host:'h', port:8082, wmspanelServerId:'w1', tags:[], online:true, order:0 },
    { id:'S2', name:'Srv2', host:'h2', port:8082, wmspanelServerId:'w2', tags:[], online:true, order:1 }];
  else if (s.includes('/servers/S1')) body = { id:'S1', name:'Srv', host:'h', port:8082, wmspanelServerId:'w1', tags:[] };
  else if (s.includes('/users')) body = [{ id:'U1', username:'admin', role:'superadmin', active:true, createdAt:new Date().toISOString() }];
  else if (s.includes('/roles')) body = [];
  else if (s.includes('/audit')) body = { items: [] };
  else if (s.includes('/functions/runs')) body = [];
  else if (s.includes('/functions')) body = [{ id:'F1', name:'Fn', description:'', steps:[
      { kind:'patch', label:'step', serverId:'S1', objectKind:'outgoing', targetId:'x', patch:{} }] }];
  else if (s.includes('/playlists')) body = [];
  else if (/\/categories\/[^/]+\/state/.test(s)) body = { state: { 'S1:udp:O1': { found: true, paused: false, serverName: 'Srv' } } };
  else if (s.includes('/categories')) body = [{ id:'C1', name:'EU feeds', description:'', color:'',
      members:[{ serverId:'S1', kind:'udp', objId:'O1', title:'live/cam1', key:'S1:udp:O1' }], updatedAt:new Date().toISOString() }];
  else if (s.includes('/settings')) body = { wmspanel:{ baseUrl:'', clientId:'' }, controlPlane:'wmspanel' };
  else if (s.includes('/wmspanel/fleet')) body = { items:[{ id:'T1', name:'TC', paused:false, tags:[], wmspanelServerId:'w1',
      serverName:'Srv', panelServerId:'S1', videoCount:1, audioCount:1, outputs:['live/out'], health:'ok', flowing:1, total:1 }], licenses:[] };
  else if (/transcoders\/[^/]+\/graph/.test(s)) body = { transcoder:{ id:'T1', name:'TC', paused:false, serverId:'w1', tags:[] },
      panelServerId:'S1', panelServerName:'Srv', liveAvailable:true,
      video:[{ id:'p1', inputs:[{ id:'i', app:'live', stream:'src', main:true }],
               filters:[{ type:'custom', name:'format', params:'yuv420p' }, { type:'split' }, { type:'custom', name:'fps', params:'25' }],
               outputs:[{ id:'o', app:'live', stream:'out', codec:'h264', encoder:'libx264', params:[{ name:'b', value:'4M' }] }] }],
      audio:[], live:{ 'live/src': { ts:new Date().toISOString(), bandwidth: 8000000 }, 'live/out': { ts:new Date().toISOString(), bandwidth: 4000000 } } };
  else if (s.includes('transcoders')) body = { transcoders: [{ id:'T1', name:'TC', paused:false, server_id:'w1', tags:[] }], licenses: [] };
  else if (s.includes('/zabbix')) body = { items: [] };
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(body), text:()=>Promise.resolve(JSON.stringify(body)) });
};
window.localStorage.setItem('nc_token','smoke');
window.eval(res.outputFiles[0].text);

let bad = 0;
console.log('PAGE RENDER SMOKE:');
for (const [name, path] of PAGES) {
  const r = await window.__PAGE(name, path);
  if (!r.ok) { bad++; console.log(`  ✗ ${name}: CRASH ${r.error}`); }
  else if (r.len < 40) { bad++; console.log(`  ✗ ${name}: rendered empty (${r.len} chars)`); }
  else console.log(`  ✓ ${name}: ${r.len} chars`);
}
const ed = await window.__EDITOR();
console.log('\nEDITOR SURFACES (open a function for editing):');
if (ed.error) { bad++; console.log('  ✗ ' + ed.error); }
else if (!ed.opened) { bad++; console.log(`  ✗ builder did not render (${ed.len} chars)`); }
else console.log(`  ✓ function builder + step editor render (${ed.len} chars)`);

console.log('\nHANDLER BINDING (every button on every page is clicked, and must not crash):');
let clicks = 0;
for (const [name, path] of PAGES) {
  const r = await window.__CLICKS(name, path);
  clicks += r.clicked;
  if (r.faults.length) {
    bad += r.faults.length;
    console.log(`  ✗ ${name}: ${r.faults.length} unbound handler(s) — ${r.faults[0].slice(0,120)}`);
  }
}
if (!bad) console.log(`  ✓ ${clicks} buttons clicked, every handler bound`);

const real = errors.filter(e => /is not defined|Cannot read|is not a function|undefined/.test(e));
if (real.length) {
  console.log('\nRENDER ERRORS:');
  real.slice(0,6).forEach(e => console.log('  !', e.slice(0,200)));
  bad += real.length;
}
process.exit(bad ? 1 : 0);
