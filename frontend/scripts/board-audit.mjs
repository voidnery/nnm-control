// Editing a scenario has to look like the scenario.
//
// The read-only view drew source -> processing -> encoders per pipeline. Both
// screens that *change* a scenario flattened every element of every pipeline of
// both kinds into one table: a four-decoder scenario became rows that did not
// say which stage, which pipeline, or even which of video/audio they belonged
// to. In the clone wizard that is not merely ugly — retargeting the wrong
// encoder there creates a second scenario writing over the first one's output.
//
// So this renders the editor and the wizard against a real scenario shape and
// asserts the structure is actually on screen, rather than asserting that some
// component was imported. The last two checks are the contradiction of the bug:
// a flat table of elements must not come back.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

// The shape captured from the fleet: one video pipeline with four decoders,
// three scale filters, three overlays and a single encoder — the scenario in
// the screenshots — plus an audio pipeline so both kinds are exercised.
const GRAPH = {
  transcoder: { id: 'T1', name: 'MultiWallTest', paused: true, serverId: 'w1' },
  panelServerName: 'NimbleEU-Tunnel',
  liveAvailable: false,
  live: {},
  video: [{
    id: 'p1',
    inputs: [
      { id: 'i1', app: 'MV', stream: 'MultiView_Flow1', main: true, type: 'stream' },
      { id: 'i2', app: 'MV', stream: 'MultiView_Flow2', type: 'stream' },
      { id: 'i3', app: 'MV', stream: 'MultiView_Flow3', type: 'stream' },
      { id: 'i4', app: 'MV', stream: 'MultiView_Flow4', type: 'stream' },
    ],
    filters: [
      { id: 'f1', type: 'custom', name: 'scale', params: 'w=960:h=540' },
      { id: 'f2', type: 'custom', name: 'scale', params: 'w=960:h=540' },
      { id: 'f3', type: 'custom', name: 'scale', params: 'w=960:h=540' },
      { id: 'f4', type: 'custom', name: 'overlay', params: 'x=960' },
      { id: 'f5', type: 'custom', name: 'overlay', params: 'y=540' },
      { id: 'f6', type: 'custom', name: 'overlay', params: 'x=960:y=540' },
    ],
    outputs: [{ id: 'o1', app: 'testWall', stream: 'testWallStream1', codec: 'h264', encoder: 'libx264',
                params: [{ name: 'b', value: '6000' }], forward_sei_timecodes: true }],
  }],
  audio: [{
    id: 'p2',
    inputs: [{ id: 'ai1', app: 'MV', stream: 'MultiView_Flow1', main: true }],
    filters: [{ id: 'af1', type: 'custom', name: 'aformat', params: 'sample_fmts=fltp' }],
    outputs: [{ id: 'ao1', app: 'testWall', stream: 'testWallStream1', codec: 'aac', encoder: 'FFmpeg' }],
  }],
};

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '${SRC}/i18n.jsx';
import { ToastProvider } from '${SRC}/toast.jsx';
import { ConfirmProvider } from '${SRC}/confirm.jsx';
import { AuthProvider } from '${SRC}/auth.jsx';
import { ThemeProvider } from '${SRC}/theme.jsx';
import TranscoderGraph from '${SRC}/components/TranscoderGraph.jsx';
import ScenarioEditor from '${SRC}/components/ScenarioEditor.jsx';
import TemplateWizard from '${SRC}/components/TemplateWizard.jsx';
const wrap = (el) => React.createElement(ThemeProvider,null,
  React.createElement(ToastProvider,null,
    React.createElement(AuthProvider,null,
      React.createElement(I18nProvider,null,
        React.createElement(ConfirmProvider,null, el)))));
window.__RENDER = async () => {
  const out = {};
  const cases = {
    graph: React.createElement(TranscoderGraph,{ transcoderId:'T1' }),
    editor: React.createElement(ScenarioEditor,{ transcoderId:'T1' }),
    wizard: React.createElement(TemplateWizard,{ template:{ id:'T1', name:'MultiWallTest' },
      servers:[{ id:'S1', name:'Src', wmspanelServerId:'w1' }], onClose(){}, onCreated(){} }),
  };
  for (const [name, el] of Object.entries(cases)) {
    const host = document.createElement('div'); document.body.appendChild(host);
    try {
      createRoot(host).render(wrap(el));
      await new Promise(r=>setTimeout(r,400));
      // The wizard portals into a modal, so read the whole document for it.
      out[name] = { ok:true, html: name==='wizard' ? document.body.innerHTML : host.innerHTML };
    } catch(e) { out[name] = { ok:false, error:String(e&&e.message||e) }; }
    host.remove();
  }
  return out;
};
`;

const res = await build({ stdin: { contents: entry, resolveDir: SRC, loader: 'jsx' }, bundle: true,
  format: 'iife', write: false, jsx: 'automatic', loader: { '.js': 'jsx', '.css': 'empty' },
  logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' } });

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const consoleErrors = [];
window.console.error = (...a) => consoleErrors.push(a.map(String).join(' '));
window.fetch = () => Promise.resolve({ ok: true, status: 200,
  json: () => Promise.resolve(GRAPH), text: () => Promise.resolve(JSON.stringify(GRAPH)) });
window.localStorage.setItem('nc_token', 'board-audit');
window.eval(res.outputFiles[0].text);
const r = await window.__RENDER();

let bad = 0;
const ck = (n, ok, d = '') => { if (ok) console.log(`  ✓ ${n}`); else { bad++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };
const count = (h, re) => (h.match(re) || []).length;

console.log('ALL THREE SCREENS RENDER THE SCENARIO:');
for (const [n, v] of Object.entries(r)) ck(`${n} renders`, v.ok, v.error);
if (Object.values(r).some(v => !v.ok)) { console.log('\naborting: a screen crashed'); process.exit(1); }

for (const [n, v] of Object.entries(r)) {
  const h = v.html;
  // Two pipelines in the fixture, one video and one audio.
  ck(`${n}: one card per pipeline (2)`, count(h, /class="gpipe-card"/g) === 2,
     `got ${count(h, /class="gpipe-card"/g)}`);
  ck(`${n}: three stage headings per pipeline (6)`, count(h, /class="gcol-h"/g) === 6,
     `got ${count(h, /class="gcol-h"/g)}`);
  ck(`${n}: each pipeline is titled`, count(h, /gpipe-name/g) === 2);
}

console.log('\nELEMENTS LAND IN THE RIGHT STAGE:');
for (const n of ['editor', 'wizard']) {
  const h = r[n].html;
  const src = h.indexOf('MultiView_Flow4');
  const enc = h.indexOf('testWallStream1');
  ck(`${n}: the fourth decoder precedes the encoder in the document`, src !== -1 && enc !== -1 && src < enc);
  // Four decoders, each an editable node with its own app and stream fields.
  ck(`${n}: every endpoint is an editable node`, count(h, /gnode[^"]*edit/g) >= 6,
     `got ${count(h, /gnode[^"]*edit/g)}`);
  ck(`${n}: processing stage is drawn, not dropped`, /scale|overlay|aformat/.test(h));
}

console.log('\nTHE FLAT TABLE MUST NOT COME BACK:');
for (const n of ['editor', 'wizard']) {
  const h = r[n].html;
  ck(`${n}: no element table`, !/<table/.test(h), 'a <table> is back in this screen');
}
for (const f of ['ScenarioEditor.jsx', 'TemplateWizard.jsx', 'TranscoderGraph.jsx']) {
  const s = readFileSync(path.join(SRC, 'components', f), 'utf8');
  ck(`${f} lays out through the shared board`, /from '\.\/PipelineBoard\.jsx'/.test(s));
}

console.log('\nWIZARD-SPECIFIC:');
{
  const h = r.wizard.html;
  // Named by the controls themselves: a class can survive a feature being
  // pulled out from under it.
  const bulkLabels = ['app for all sources', 'app for all encoders', 'suffix for encoder streams'];
  ck('all three bulk retarget helpers are offered',
     bulkLabels.every(l => h.includes(l)),
     `missing: ${bulkLabels.filter(l => !h.includes(l)).join(', ') || 'none'}`);
  ck('filters are shown as copied, not editable', count(h, /gnode[^"]*copied/g) >= 4,
     `got ${count(h, /gnode[^"]*copied/g)}`);
}

const realErrs = consoleErrors.filter(e => /is not defined|Cannot read|is not a function|Minified React error/.test(e));
if (realErrs.length) { console.log('\nRENDER ERRORS:'); realErrs.slice(0, 6).forEach(e => console.log('  !', e.slice(0, 160))); bad += realErrs.length; }

console.log(bad ? `\n${bad} problem(s) in the pipeline board` : '\nboard audit: OK');
process.exit(bad ? 1 : 0);
