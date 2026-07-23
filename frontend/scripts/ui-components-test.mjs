import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = '/home/claude/nnm-control/frontend/src';

// Tags on this server span several tabs; the RTMP Pull tab must only ever
// offer its own vocabulary.
const TAG_MAP = {
  'livepull:p1': ['EWC/VALORANT'],
  'republish:r1': ['youtube-main'],
  'udp:u1': ['edge-eu'],
};

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '${SRC}/i18n.jsx';
import { ToastProvider } from '${SRC}/toast.jsx';
import { ConfirmProvider } from '${SRC}/confirm.jsx';
import { AuthProvider } from '${SRC}/auth.jsx';
import { ThemeProvider } from '${SRC}/theme.jsx';
import SearchInput from '${SRC}/components/SearchInput.jsx';
import { useStreamTags, TagChips } from '${SRC}/components/StreamTags.jsx';

function Wrap({ children }) {
  return React.createElement(ThemeProvider,null,
    React.createElement(ToastProvider,null,
      React.createElement(AuthProvider,null,
        React.createElement(I18nProvider,null,
          React.createElement(ConfirmProvider,null,children)))));
}

function TagHost({ kind, objId }) {
  const st = useStreamTags('S1', kind);
  return React.createElement('div',{className:'panel',style:{overflow:'auto',maxHeight:'200px'}},
    React.createElement(TagChips,{ st, kind, objId }));
}

function SearchHost() {
  const [v, setV] = React.useState('fghsfh');
  return React.createElement('div',null,
    React.createElement(SearchInput,{ value:v, onChange:setV }),
    React.createElement('span',{id:'val'}, v));
}

window.__T = {};

window.__T.search = async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  createRoot(host).render(React.createElement(Wrap,null,React.createElement(SearchHost)));
  await new Promise(r=>setTimeout(r,150));
  const before = host.querySelector('#val').textContent;
  const clear = host.querySelector('.searchbox-clear');
  const hadClear = !!clear;
  clear?.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,80));
  const after = host.querySelector('#val').textContent;
  const clearGoneWhenEmpty = !host.querySelector('.searchbox-clear');
  return { before, hadClear, after, clearGoneWhenEmpty };
};

window.__T.tags = async (kind) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); root.render(React.createElement(Wrap,null,React.createElement(TagHost,{kind, objId:'newObj'})));
  await new Promise(r=>setTimeout(r,250));
  host.querySelector('.tag-btn.ghost')?.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,150));
  const pops = document.body.querySelectorAll('.tag-pop');
  const popInBody = pops.length ? pops[pops.length-1] : null;
  const popInHost = host.querySelector('.tag-pop');
  const opts = popInBody ? Array.from(popInBody.querySelectorAll('.tagopt')).map(d=>d.textContent.replace('✓','').trim()) : [];
  const out = { opened: !!popInBody, portaled: !!popInBody && !popInHost, suggestions: opts };
  root.unmount(); host.remove();
  return out;
};

// Regression: removing a chip while the picker is open must reach the server.
// The old inline editor dismissed itself on mousedown, so the × click never landed.
window.__T.remove = async () => {
  window.__PUTS = [];
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); root.render(React.createElement(Wrap,null,React.createElement(TagHost,{kind:'livepull', objId:'p1'})));
  await new Promise(r=>setTimeout(r,250));
  host.querySelector('.tag-btn.ghost')?.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,120));
  const x = host.querySelector('.tagchip.static .x');
  if (!x) return { error: 'no remove (x) affordance' };
  x.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true}));
  await new Promise(r=>setTimeout(r,20));
  const survived = !!host.querySelector('.tagchip.static .x');
  x.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,220));
  const out = { survived, puts: window.__PUTS, chips: Array.from(host.querySelectorAll('.tagchip.static')).map(n=>n.textContent.replace('×','').trim()) };
  root.unmount(); host.remove();
  return out;
};

// Toggling a row in the picker assigns the tag.
window.__T.assign = async () => {
  window.__PUTS = [];
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); root.render(React.createElement(Wrap,null,React.createElement(TagHost,{kind:'livepull', objId:'p9'})));
  await new Promise(r=>setTimeout(r,250));
  host.querySelector('.tag-btn.ghost')?.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,120));
  const pops = document.body.querySelectorAll('.tag-pop');
  const pop = pops[pops.length-1];
  const row = pop?.querySelector('.tagopt');
  row?.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,220));
  const out = { puts: window.__PUTS };
  root.unmount(); host.remove();
  return out;
};
`;

const res = await build({ stdin:{contents:entry,resolveDir:SRC,loader:'jsx'}, bundle:true, format:'iife', write:false, jsx:'automatic', logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'} });

const dom = new JSDOM('<!doctype html><body></body>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const { window } = dom;
window.__PUTS = [];
window.fetch = (u, opt = {}) => {
  const s = String(u);
  let body = { status:'Ok' };
  if (s.includes('/stream-tags/')) {
    if ((opt.method || 'GET') === 'PUT') { const b = JSON.parse(opt.body); window.__PUTS.push(b); body = { tags: b.tags }; }
    else body = { map: TAG_MAP };
  }
  if (s.includes('/auth/me')) body = { id:'U1', username:'t', permissions:['*'] };
  else if (s.includes('/settings/public')) body = { controlPlane:'wmspanel', wmspanelConfigured:true };
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(body), text:()=>Promise.resolve(JSON.stringify(body)) });
};
window.localStorage.setItem('nc_token','t');
window.eval(res.outputFiles[0].text);

let bad = 0;
const s = await window.__T.search();
console.log('SEARCH CLEAR (×):');
console.log(`  ${s.hadClear?'✓':'✗'} clear button shown when text present`);
console.log(`  ${s.after===''?'✓':'✗'} clears the field ("${s.before}" -> "${s.after}")`);
console.log(`  ${s.clearGoneWhenEmpty?'✓':'✗'} button hidden when field is empty`);
if(!s.hadClear||s.after!==''||!s.clearGoneWhenEmpty) bad++;

console.log('\nTAG DROPDOWN (per-tab vocabulary, portaled):');
for (const [kind, expected] of [['livepull',['EWC/VALORANT']], ['republish',['youtube-main']], ['apps',[]]]) {
  const r = await window.__T.tags(kind);
  const sugg = r.suggestions.filter(x => !/^(Create|No )/.test(x));
  const match = JSON.stringify(sugg) === JSON.stringify(expected);
  if (!r.opened || !r.portaled || !match) bad++;
  console.log(`  ${r.opened&&r.portaled&&match?'✓':'✗'} ${kind.padEnd(10)} portaled=${r.portaled} suggestions=[${sugg.join(', ')}] (expected [${expected.join(', ')}])`);
}

const rm = await window.__T.remove();
console.log('\nTAG REMOVAL (CRUD delete, picker open):');
if (rm.error) { console.log('  ✗ ' + rm.error); bad++; }
else {
  const sentRemoval = (rm.puts || []).some(p => !p.tags.includes('EWC/VALORANT'));
  console.log(`  ${rm.survived?'✓':'✗'} remove control survives mousedown (was the old bug)`);
  console.log(`  ${sentRemoval?'✓':'✗'} removal persisted: ${JSON.stringify(rm.puts)}`);
  console.log(`  ${!rm.chips.includes('EWC/VALORANT')?'✓':'✗'} chip gone from the cell -> ${JSON.stringify(rm.chips)}`);
  if (!rm.survived || !sentRemoval || rm.chips.includes('EWC/VALORANT')) bad++;
}

const asg = await window.__T.assign();
const assigned = (asg.puts || []).some(p => p.tags.includes('EWC/VALORANT'));
console.log('\nTAG ASSIGN (CRUD create via picker row):');
console.log(`  ${assigned?'✓':'✗'} assignment persisted: ${JSON.stringify(asg.puts)}`);
if (!assigned) bad++;

process.exit(bad?1:0);
