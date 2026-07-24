// Layout of a scenario graph, checked against the shape captured from a real
// account dump (1 input, format/bwdif/split/fps/fps/picture, 2 encoders).
import { build } from 'esbuild';
import { rmSync } from 'fs';
const SRC = '/home/claude/nnm-control/frontend/src';
const out = '/tmp/.pl-layout.mjs';
await build({ stdin: { contents: `export * from '${SRC}/lib/pipelineLayout.js';`, resolveDir: SRC, loader: 'js' },
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const { layoutPipeline, filterLabel, ioLabel, codecLabel, configuredBitrate } = await import(out);
rmSync(out, { force: true });

let bad = 0;
const ck = (n, ok, d = '') => { if (ok) console.log(`  ✓ ${n}`); else { bad++; console.log(`  ✗ ${n} ${d}`); } };

const vp = { id: 'p1', inputs: [{ id: 'i', app: 'RGLBm', stream: 'flow4', main: true }],
  filters: [{ type: 'custom', name: 'format', params: 'pix_fmts=yuv420p' }, { type: 'custom', name: 'bwdif', params: '1:0:1' },
            { type: 'split' }, { type: 'custom', name: 'fps', params: '60' }, { type: 'custom', name: 'fps', params: '25' },
            { type: 'picture', filename: 'logo.png' }],
  outputs: [{ app: 'RGLBm', stream: 'flow4_bw60_cf', codec: 'hevc_nvenc', encoder: 'FFmpeg', params: [{ name: 'b', value: '8M' }] },
            { app: 'RGLBm', stream: 'flow4_bw25_cf', codec: 'h264', encoder: 'libx264' }] };

console.log('REAL SCENARIO SHAPE:');
const L = layoutPipeline(vp);
ck('shared filters end at the split', L.pre.length === 2, JSON.stringify(L.pre.map(f => f.name)));
ck('split identified', L.split?.type === 'split');
ck('3 post-split filters kept together for 2 encoders', L.post.length === 3);
ck('branch assignment reported as not derivable', L.deterministic === false);
ck('both encoders preserved', L.outputs.length === 2);

console.log('\nSIMPLE AND EDGE CASES:');
const lin = layoutPipeline({ inputs: [{ app: 'a', stream: 's' }], filters: [{ type: 'custom', name: 'fps', params: '25' }], outputs: [{ app: 'a', stream: 'o' }] });
ck('chain without split is deterministic', lin.deterministic === true && lin.post.length === 0);
ck('audio asplit is recognised too', layoutPipeline({ filters: [{ type: 'asplit', outputs_number: 2 }] }).split?.type === 'asplit');
ck('empty pipeline is safe', layoutPipeline({}).outputs.length === 0 && layoutPipeline().pre.length === 0);
ck('passthrough (no filters) stays deterministic', layoutPipeline({ inputs: [{ app: 'a', stream: 'b' }], outputs: [{ app: 'a', stream: 'c' }] }).deterministic === true);

console.log('\nLABELS:');
ck('filter name + params', filterLabel({ type: 'custom', name: 'fps', params: '60' }) === 'fps (60)');
ck('asplit fan-out count', filterLabel({ type: 'asplit', outputs_number: 2 }) === 'asplit ×2');
ck('picture overlay shows the file', filterLabel({ type: 'picture', filename: 'logo.png' }) === 'picture: logo.png');
ck('main input marked', ioLabel({ app: 'a', stream: 's', main: true }) === 'a/s · main');
ck('missing fields do not render "undefined"', !/undefined/.test(ioLabel({}) + filterLabel({}) + codecLabel({})), ioLabel({}) + '|' + filterLabel({}));
ck('codec + encoder', codecLabel(vp.outputs[0]) === 'hevc_nvenc · FFmpeg');
ck('configured bitrate from params', configuredBitrate(vp.outputs[0]) === '8M');
ck('no bitrate -> null', configuredBitrate(vp.outputs[1]) === null);

console.log(bad ? `\n${bad} failure(s)` : '\nall scenario-graph checks passed');
process.exit(bad ? 1 : 0);
