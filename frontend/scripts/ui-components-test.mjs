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
  // Portals stack in <body>; drop leftovers from previous runs so we inspect
  // only the popup this run creates.
  document.body.querySelectorAll('.tag-pop').forEach(n => n.remove());
  const host = document.createElement('div'); document.body.appendChild(host);
  createRoot(host).render(React.createElement(Wrap,null,React.createElement(TagHost,{kind, objId:'newObj'})));
  await new Promise(r=>setTimeout(r,250));
  // enter edit mode
  host.querySelector('.tag-btn.ghost')?.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,150));
  const popInHost = host.querySelector('.tag-pop');
  const pops = document.body.querySelectorAll('.tag-pop');
  const popInBody = pops.length ? pops[pops.length-1] : null;
  const opts = popInBody ? Array.from(popInBody.querySelectorAll('.cselect-opt')).map(d=>d.textContent.trim()) : [];
  return {
    opened: !!popInBody,
    portaled: !!popInBody && !popInHost,
    suggestions: opts,
  };
};
`;

const res = await build({ stdin:{contents:entry,resolveDir:SRC,loader:'jsx'}, bundle:true, format:'iife', write:false, jsx:'automatic', logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'} });

const dom = new JSDOM('<!doctype html><body></body>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const { window } = dom;
window.fetch = (u) => {
  const s = String(u);
  let body = { status:'Ok' };
  if (s.includes('/stream-tags/')) body = { map: TAG_MAP };
  else if (s.includes('/auth/me')) body = { id:'U1', username:'t', permissions:['*'] };
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
process.exit(bad?1:0);
