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
  ['ProfilePage','/profile'],
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
  if (s.includes('/auth/me')) body = { id:'U1', username:'smoke', permissions:['*'] };
  else if (s.includes('/settings/public')) body = { controlPlane:'wmspanel', wmspanelConfigured:true };
  else if (s.includes('/stream-tags/')) body = { map:{} };
  else if (s.endsWith('/servers')) body = [{ id:'S1', name:'Srv', host:'h', port:8082, wmspanelServerId:'w1', tags:[], online:true }];
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
  else if (s.includes('transcoders')) body = { transcoders: [], licenses: [] };
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

const real = errors.filter(e => /is not defined|Cannot read|is not a function|undefined/.test(e));
if (real.length) {
  console.log('\nRENDER ERRORS:');
  real.slice(0,6).forEach(e => console.log('  !', e.slice(0,200)));
  bad += real.length;
}
process.exit(bad ? 1 : 0);
