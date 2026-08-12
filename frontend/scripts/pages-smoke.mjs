import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Mounts every top-level page with providers + router and sample API data.
// The tab-level smoke never covered these, so a crash in ServersPage/UsersPage/
// etc. could ship unnoticed.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

const PAGES = [
  ['DashboardPage','/'], ['ServersPage','/servers'], ['ServerDetailPage','/servers/S1'],
  ['UsersPage','/users'], ['RolesPage','/roles'], ['AuditPage','/audit'],
  ['SettingsPage','/settings'], ['FunctionsPage','/functions'], ['TranscodersPage','/transcoders'],
  ['DistributionPage','/distribution'], ['AccountObjectsPage','/account-objects'], ['PlaylistsPage','/playlists'], ['ZabbixPage','/zabbix'], ['CategoriesPage','/categories'],
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
  // So a render warning names the page that produced it.
  window.__page = name;
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
    // Buttons were collected once, before any click — so anything a click
    // revealed (a dialog, an expanded row) was never exercised. Rescanning
    // after each click covers those, and a seen-set keeps it from looping on
    // a toggle that puts the same button back.
    const seen = new WeakSet();
    let clicked = 0;
    for (let pass = 0; pass < 6; pass++) {
      const btns = Array.from(host.querySelectorAll('button'))
        .filter(b => !b.disabled && !seen.has(b));
      if (!btns.length) break;
      for (const b of btns) {
        seen.add(b);
        try { b.dispatchEvent(new window.MouseEvent('click',{bubbles:true})); }
        catch (e) { onErr(e); }
        clicked++;
        await new Promise(r=>setTimeout(r,5));
      }
      await new Promise(r=>setTimeout(r,40));   // let the render settle
    }
    return { ok:true, clicked, faults };
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
  // This harness checks that pages render and that their buttons are bound,
  // not how they look; a stylesheet import has no output path here.
  write:false, jsx:'automatic', loader:{'.css':'empty'}, logLevel:'silent',
  define:{'process.env.NODE_ENV':'"development"'} });

const dom = new JSDOM('<!doctype html><body></body>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const { window } = dom;
const errors = [];
window.console.error = (...a) => errors.push(`${window.__page || '?'}: ` + a.map(String).join(' '));
window.fetch = (u) => {
  const s = String(u);
  let body = { status:'Ok' };
  // iter20 m1 - the delivery network and the geolocation database. Without
  // these the Distribution page renders its network view against undefined
  // and the whole page comes back empty.
  // iter20 m2 - the routes that actually exist, now shown under the plan.
  if (/\/cdn\/routes$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    status:'Ok', routes:[{ id:'r1', from:'/test2/', to:'79.98.187.66:8081/test2/',
                           servers:['6a18e008dc73c6feb3a4f1e9'] }] }), text:()=>Promise.resolve('{}') });
  if (/\/channels\/discovered$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    found:[{ key:'ewc_chess/main', application:'ewc_chess', stream:'main', origin:'selectel(24/7)', bandwidth:3200000 }],
    unreachable:[] }), text:()=>Promise.resolve('{}') });
  if (/\/channels\/overview$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    routesRead:true,
    rows:[{ channel:{ id:'C1', application:'test2', stream:'test_stream', label:'', kind:'production', network:'N1', name:'test2/test_stream' },
            network:{ id:'N1', name:'Prod', audience:'internal' },
            edges:[{ name:'RU-2', healthy:true, routed:true, serving:false }],
            protection:{ mode:'token', chosen:'token', applied:false, effective:false, code:'not-applied' },
            links:{ path:'/test2/test_stream',
                    production:{ url:'http://10.0.0.2:8081/test2/test_stream/playlist.m3u8', exposes:'edge-address',
                                 resolvedTo:'RU-2', reason:'only-candidate', stable:true, mode:'direct', policy:'nearest' },
                    productionReason:null, whenAllDown:'fail',
                    tests:[{ edge:'RU-2', url:'http://10.0.0.2:8081/test2/test_stream/playlist.m3u8', exposes:'edge-address', routed:true, healthy:true }] } },
          { channel:{ id:'C2', application:'povtor_tennis', stream:'main', label:'', kind:'production', network:null, name:'povtor_tennis/main' },
            network:null, edges:[], links:null, code:'not-delivered' }] }), text:()=>Promise.resolve('{}') });
  if (/\/networks\/[^/]+\/derived$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    items:[{ kind:'route', action:'create', why:'edge-needs-route', subject:'RU-2', application:'test2',
             detail:{ from:'/test2/', to:'79.98.187.66:8081/test2/' },
             provenance:{ origin:'selectel(24/7)', host:'79.98.187.66', hostSource:'management-host', port:8081, portSource:'configured' } }],
    problems:[], blocking:[], unservable:[], summary:{ create:1, update:0, keep:0 }, inSync:false,
    channels:[{ id:'C1', application:'test2', stream:'test_stream', readiness:{ code:'pending', ready:false, pending:1 } }] }), text:()=>Promise.resolve('{}') });
  if (/\/cdn\/channels$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ channels:[] }), text:()=>Promise.resolve('{}') });
  if (/\/cdn\/networks$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    networks:[{ id:'N1', name:'Prod', description:'', audience:'public', nodes:[
      { id:'n1', server:'S1', role:'origin', upstream:[], weight:100, enabled:true, notes:'' },
      { id:'n2', server:'S2', role:'edge', upstream:['n1'], weight:100, enabled:true, notes:'' },
    ], updatedAt:new Date().toISOString() }],
    roles:['ingest','origin','mid','edge','gateway'],
    attribution:{ text:'IP Geolocation by DB-IP', url:'https://db-ip.com' } }), text:()=>Promise.resolve('{}') });
  // iter20 m2 - the plan endpoint. Without it the routes panel renders against
  // undefined the moment a network is selected.
  // Scoped to the delivery network. A bare /overview$ also matches
  // /agent-fleet/overview, and answering that with this shape blanked the
  // agents page — a fixture stealing another page's endpoint.
  if (/\/cdn\/networks\/[^/]+\/overview/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    summary:{ roles:{origin:1,edge:1}, gateway:{mode:'direct',policy:'nearest',whenAllDown:'fail',domain:'',node:''},
              audience:'internal', geo:{present:true,edition:'city',hasCoordinates:true}, routes:2, agents:1, nodes:2 },
    findings:[{ code:'node-without-agent', severity:'note', subject:'Nimble RU-2' }],
    counts:{block:0,warn:0,note:1} }), text:()=>Promise.resolve('{}') });
  if (/\/gateway$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    gateway:{ enabled:false, mode:'direct', policy:'nearest', whenAllDown:'fail', domain:'', node:null } }), text:()=>Promise.resolve('{}') });
  if (/resolve-preview$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    decision:{ edge:{ name:'Nimble RU-2' }, reason:'nearest', distanceKm:420, runnersUp:[{ edge:'RU-3', distanceKm:900 }] },
    viewerFrom:'geoip', mode:'direct', url:'http://79.98.187.66:8081/test2/s/playlist.m3u8', exposes:'edge-address', via:'edge' }), text:()=>Promise.resolve('{}') });
  if (/\/networks\/[^/]+\/cache$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    rows:[{ server:'Nimble RU-2', ok:true, transport:'direct', reported:[{ path:'RamCacheSize', value:4096, counter:false }],
            hitRatio:null, hasAnyCacheData:true, expected:{ bytes:9000000, streams:1, chunksPerStream:12, chunkSeconds:6, independentOfViewers:true } }],
    chunkSeconds:6, at:new Date().toISOString() }), text:()=>Promise.resolve('{}') });
  if (/\/probe\/matrix$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    cells:[{ from:'selectel(24/7)', to:'Nimble RU-3', ok:true, minMs:12.4, avgMs:13, maxMs:14, jitterMs:1.6, lossPct:0 },
           { from:'Nimble RU-3', to:'selectel(24/7)', ok:false, error:'ETIMEDOUT', minMs:null, lossPct:null }],
    skipped:[{ node:'Nimble RU-2', code:'no-agent' }], at:new Date().toISOString() }), text:()=>Promise.resolve('{}') });
  if (/\/networks\/[^/]+\/applications$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    applications:[{ application:'test2', streams:1, servers:['selectel(24/7)'] }],
    asked:[{ server:'selectel(24/7)', ok:true, transport:'agent' }] }), text:()=>Promise.resolve('{}') });
  if (/\/networks\/[^/]+\/state$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    rows:[{ edge:'Nimble RU-2', origin:'selectel(24/7)', application:'test2', routeId:'r1',
            edgeStreams:1, edgeBandwidth:880000, originStreams:1, originBandwidth:900000, verdict:'flowing',
            edgeProbe:{ ok:true, transport:'agent', hadAgent:true },
            originProbe:{ ok:true, transport:'direct', hadAgent:false } }],
    drift:[{ code:'unplanned-route', edge:'Nimble RU-2', from:'/test1/', to:'79.98.187.66:8081/test1/', routeId:'r0' }],
    unreachable:[{ server:'NimbleRU-3', ok:false, hadAgent:false, transport:'direct', reason:'no-agent-and-direct-failed', error:'connect ETIMEDOUT' }], summary:{ flowing:1, broken:0, unknown:1 } }), text:()=>Promise.resolve('{}') });
  if (/\/networks\/[^/]+\/(plan|apply)$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    planned:[{ action:'create', application:'kp_24-7', server:'Nimble RU-2', from:'/kp_24-7/',
               to:'10.0.0.10:8081/kp_24-7/', portSource:'nimble-default' }],
    problems:[{ code:'origin-http-port-assumed', severity:'warn', server:'selectel(24/7)', port:8081 }],
    blocking:[], summary:{ create:1, update:0, keep:0 } }), text:()=>Promise.resolve('{}') });
  if (/\/geoip$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    present:true, edition:'country', release:'2026-08', size:8.1e6, hasCoordinates:false,
    editions:[{ id:'country', label:'DB-IP Country Lite', approxBytes:7.9e6, accuracyIndex:81, hasCoordinates:false },
              { id:'city', label:'DB-IP City Lite', approxBytes:124.2e6, accuracyIndex:77, hasCoordinates:true }],
    attribution:{ text:'IP Geolocation by DB-IP', url:'https://db-ip.com' } }), text:()=>Promise.resolve('{}') });
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
  if (/\/settings$/.test(s)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    controlPlane:'wmspanel', srtHelperEnabled:true, wmspanel:{ clientId:'c', baseUrl:'https://api.wmspanel.ru/v1' },
    stats:{ enabled:true, intervalSec:10, retentionDays:3, groups:{} },
    logs:{ enabled:true, files:['nimble.log'] } }), text:()=>Promise.resolve('{}') });  // settings.logs fixture
  if (s.includes('/agent-fleet/overview')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    shipped:{ version:7, sha256:'a'.repeat(64), bytes:27123 },
    watchdog:{ tickMs:30000, confirmAfter:3, active:true, tracking:[] },
    unacknowledged:2,
    servers:[
      { id:'S1', name:'NimbleFIN-1', host:'194.34.236.205', enabled:true, code:'healthy', severity:'ok',
        evidence:'agent polling normally', lastContactAt:new Date().toISOString(), sinceContactMs:4000,
        restarts:0, version:6, versionState:'outdated', selfUpdate:true, pendingUpdate:false },
      { id:'S2', name:'NimbleRU-4', host:'95.181.213.127', enabled:true, code:'stopped-polling', severity:'error',
        evidence:'last contact was 300s ago', sinceContactMs:300000, restarts:0, version:7,
        versionState:'current', selfUpdate:false, pendingUpdate:false },
      { id:'S3', name:'mediaserver', host:'192.168.200.129', enabled:false, code:'not-configured' }],
    summary:{ total:3, configured:2, healthy:1, faulty:1, outdated:1 } }), text:()=>Promise.resolve('{}') });
  if (s.includes('/agent-fleet/events')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([
    { id:'E1', serverId:'S2', serverName:'NimbleRU-4', code:'stopped-polling', kind:'fault', severity:'error',
      evidence:'last contact was 300s ago', detail:null, createdAt:new Date().toISOString(),
      acknowledgedAt:null, acknowledgedBy:'' }]), text:()=>Promise.resolve('{}') });
  if (s.includes('/stats/api-quota')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    day:'2026-07-31', used:11840, limit:15000, remaining:3160, pctUsed:78.9,
    resetsInMs:5*3600*1000, projected:16400,
    top:[{path:'/server/:id/rtmp/republish',calls:5200},{path:'/server/:id/mpegts/outgoing',calls:3100}],
    note:'panel-only' }), text:()=>Promise.resolve('{}') });
  if (s.includes('/stats/streams')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    minutes:60, servers:[
      { id:'S1', name:'NimbleFIN-1', total:9, shown:2, streams:[
        { subject:'stream:cct/feed1', label:'cct/feed1', metric:'bandwidth', latest:6100000, last:new Date().toISOString(),
          points:[{ ts:new Date(Date.now()-60000).toISOString(), v:[6000000] }, { ts:new Date().toISOString(), v:[6100000] }] },
        // Deliberately on a different timeline, to exercise the alignment.
        { subject:'stream:cct/feed2', label:'cct/feed2', metric:'bandwidth', latest:4200000, last:new Date().toISOString(),
          points:[{ ts:new Date(Date.now()-30000).toISOString(), v:[4200000] }] },
        // And one Nimble reports without any bitrate field at all.
        { subject:'stream:cct/feed3', label:'cct/feed3', metric:'', latest:null, last:new Date().toISOString(), points:[] }] },
      { id:'S2', name:'NimbleRU-4', total:0, shown:0, streams:[] },
      { id:'S3', name:'mediaserver', total:0, shown:0, streams:[] }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/stats/host')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    minutes:60, metrics:['cpu_pct','cpu_steal_pct','cpu_iowait_pct','mem_used_pct','swap_used_pct','net_rx_bps','net_tx_bps'],
    servers:[
      { id:'S1', name:'NimbleFIN-1', host:'194.34.236.205', agent:true, lastContactAt:new Date().toISOString(),
        bucketMs:0, latest:[12,0.5,1,44,0,120000000,340000000],
        points:[{ ts:new Date(Date.now()-60000).toISOString(), v:[10,0.4,1,43,0,1.1e8,3.3e8] },
                { ts:new Date().toISOString(), v:[12,0.5,1,44,0,1.2e8,3.4e8] }] },
      { id:'S2', name:'NimbleRU-4', host:'95.181.213.127', agent:true,
        lastContactAt:new Date(Date.now()-400000).toISOString(), bucketMs:0, latest:null, points:[] },
      { id:'S3', name:'mediaserver', host:'192.168.200.129', agent:false, lastContactAt:null, bucketMs:0, latest:null, points:[] }] }),
    text:()=>Promise.resolve('{}') });
  if (/wmspanel\/server\/[^/]+\/mpegts\/incoming/.test(s)) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ streams:[
      { id:'o1', name:'CCT_FEED2_FIN_Net', description:'CCT_FEED2_FIN', protocol:'srt', ip:'0.0.0.0', port:40002, receive_mode:'listen', pmts:[] },
      { id:'o2', name:'CCT_FEED1_FIN_NET', description:'CCT_FEED1_FIN', protocol:'srt', ip:'0.0.0.0', port:40001, receive_mode:'listen', pmts:[] }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/multi')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    minutes:60, metrics:['stats_recv_mbpsRate'], series:[
      { subject:'srt-receiver:A', label:'CCT_FEED2_FIN · in', bucketMs:0, latest:[5.54],
        points:[{ ts:new Date(Date.now()-60000).toISOString(), v:[5.53] }, { ts:new Date().toISOString(), v:[5.54] }] },
      { subject:'srt-receiver:B', label:'CCT_FEED1_EU_BACKUP · in', bucketMs:0, latest:[0.027],
        points:[{ ts:new Date().toISOString(), v:[0.027] }] }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/stats/') && s.includes('series')) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ subject:'srt-receiver:o1', metrics:[], bucketMs:0, points:[
      // rate, send-rate, rtt, lost, dropped, belated, retrans, naks, bw, maxbw, flow, cong, flight, bytes×3, retries
      { ts:new Date(Date.now()-60000).toISOString(), v:[6.4,null,9.8,10,0,3,5,2,81.3,50,8192,8192,0,29e9,8.3e6,0,39] },
      { ts:new Date().toISOString(),                 v:[6.5,null,10.1,12,0,3,6,2,81.5,50,8192,8192,0,30e9,8.4e6,0,39] }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/agent/config-list')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    dir:'/srv/nimble/conf', readable:true, files:[{ name:'playlist.json' }, { name:'server_playlist.json' }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/agent/playlist-state')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    name:'server-playlist.json', exists:true,
    parsed:{ ok:true, tasks:[{ stream:'povtor_tennis/video_playlist_02_03', count:24, distinct:9,
      blocks:[{ index:0, id:'b517f333', loops:true, count:24 }], items:[] }], sources:[] },
    media:{ checked:16, missing:[{ path:'/srv/nimble/media/x.mp4', reason:'missing' }] } }), text:()=>Promise.resolve('{}') });
  if (s.includes('/agent/playlist-advice')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    drift:{ state:'drifted', since:new Date().toISOString() },
    joins:[{ stream:'povtor_tennis/video_playlist_02_03', issues:[{ at:3, diffs:[{ what:'frame rate', from:25, to:30 }] }], unknown:[] }],
    timings:[{ stream:'povtor_tennis/video_playlist_02_03', totalMs:7_740_000, loopsForever:true,
      blocks:[{ complete:true }], endsAt:null, endsInMs:null }], endingSoon:[] }), text:()=>Promise.resolve('{}') });
  if (s.includes('/agent/playlist-history/')) return Promise.resolve({ ok:true, status:200,
    json:()=>Promise.resolve({ _id:'v1', createdAt:new Date().toISOString(), content:'{"Tasks":[{"Stream":"old/one"}]}' }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/agent/playlist-history')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    versions:[{ _id:'v1', createdAt:new Date().toISOString(), by:'superadmin', bytes:7422, origin:'panel', forced:false, missingAtDeploy:[] }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/agent/media')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    dir:'/srv/nimble/media/gallery',
    files:[{ name:'adds/reklama_1.mp4', size:12e6 }, { name:'matches/match_1.mp4', size:900e6 }] }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/live-objects/')) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({
    kind:'incoming', available:true, strategy:'name', matched:1, objects:2, entries:1,
    live:{ 'o1': { bps:6200000, online:true, idle:false, rtt:9.8, loss:0.81, retries:39 }, 'o2': { bps:0, online:true, idle:true, rtt:9.3, loss:null, retries:51427 } }, diagnostics:null }),
    text:()=>Promise.resolve('{}') });
  if (s.includes('/auth/me')) body = { id:'U1', username:'smoke', permissions:['*'],
    preferences:{ dashboard:{ charts:['cpu','mem','net','streams'], range:'1h', columns:'2', refreshSec:15, streamLimit:6 } } };
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
  // The functions endpoint returns raw mongoose documents, so `_id` is what
  // the page reads. A fixture carrying only `id` made every row key undefined
  // and React fell back to index — which reconciles the wrong row when a
  // function is deleted. The fixture was the thing that was wrong.
  else if (s.includes('/functions')) body = [{ _id:'F1', id:'F1', name:'Fn', description:'', steps:[
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

// A crash and a React warning are different findings and were being counted
// as one: the `undefined` in the filter matched any warning whose formatted
// text happened to end that way, so a duplicate key was reported as a render
// error. Both stay visible; only the first fails the gate.
const isWarning = (e) => /^\S*:? ?Warning:/.test(e) || e.includes('Warning:');
const real = errors.filter(e => !isWarning(e) && /is not defined|Cannot read|is not a function/.test(e));
const warnings = [...new Set(errors.filter(isWarning).map(e => e.split('.')[0]))];

if (real.length) {
  console.log('\nRENDER ERRORS:');
  real.slice(0, 6).forEach(e => console.log('  !', e.slice(0, 200)));
  bad += real.length;
}
if (warnings.length) {
  // Reported, attributed, and not fatal. A duplicate key makes React reuse the
  // wrong node — worth fixing, not worth blocking a release over.
  console.log('\nREACT WARNINGS (not fatal, but real):');
  warnings.slice(0, 6).forEach(w => console.log('  ~', w.slice(0, 160)));
}
process.exit(bad ? 1 : 0);
