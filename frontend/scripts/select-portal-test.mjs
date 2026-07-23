import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const SRC = '/home/claude/nnm-control/frontend/src';
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Select from '${SRC}/components/Select.jsx';
window.__RUN = async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  // Mimic the real modal: a scroll container that used to clip the popup.
  root.render(React.createElement('div',{className:'modal-back'},
    React.createElement('div',{className:'modal',style:{overflow:'auto',maxHeight:'90vh'}},
      React.createElement(Select,{ value:'', onChange(){}, searchable:true,
        options:[{value:'a',label:'SPORTS_TV-3 (offline)'},{value:'b',label:'SPORTS_TV-4 (offline)'}] }))));
  await new Promise(r=>setTimeout(r,100));
  const btn = host.querySelector('.cselect-btn');
  btn.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,120));
  const popInModal = host.querySelector('.cselect-pop');
  const popInBody = document.body.querySelector('.cselect-pop');
  return {
    opened: !!popInBody,
    portaled: !!popInBody && !popInModal,
    fixed: popInBody ? popInBody.style.position || getComputedStyle(popInBody).position : null,
    optionCount: popInBody ? popInBody.querySelectorAll('.cselect-opt').length : 0,
  };
};
`;
const res = await build({ stdin:{contents:entry,resolveDir:SRC,loader:'jsx'}, bundle:true, format:'iife', write:false, jsx:'automatic', logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'} });
const dom = new JSDOM('<!doctype html><body></body>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
dom.window.eval(res.outputFiles[0].text);
const r = await dom.window.__RUN();
console.log('dropdown opened:      ', r.opened);
console.log('rendered via portal:  ', r.portaled, '(not inside the modal => cannot be clipped)');
console.log('options rendered:     ', r.optionCount);
process.exit(r.opened && r.portaled && r.optionCount === 2 ? 0 : 1);
