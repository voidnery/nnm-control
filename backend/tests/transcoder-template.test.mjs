// The wizard writes to pipeline elements — a path that had never been exercised
// against the live API. Its self-check must be trustworthy, so every way it can
// go wrong is pinned here.
import { wmspanel } from '../src/services/wmspanelClient.js';
import { preflightWrite } from '../src/routes/transcoderTemplate.js';

let bad = 0;
const ck = (n, ok, d = '') => { if (ok) console.log(`  ✓ ${n}`); else { bad++; console.log(`  ✗ ${n} ${d}`); } };

const scenario = (input) => ({
  transcoder: { id: 'C1', video_pipelines: [{ id: 'p1', inputs: [input], filters: [], outputs: [] }], audio_pipelines: [] },
});
const baseInput = { id: 'i1', app: 'live', stream: 'src', main: true, type: 'stream', forward_scte35: false };

console.log('PREFLIGHT — write path verification:');

// happy path: the API stores exactly what we sent
let sent = null;
wmspanel.pipelineIoUpdate = async (_c, _id, _k, _p, _io, _iid, body) => { sent = body; return { status: 'Ok' }; };
wmspanel.transcoderGet = async () => scenario({ ...baseInput });
let r = await preflightWrite({}, 'C1', scenario(baseInput).transcoder);
ck('unchanged round-trip reports ok', r.status === 'ok', JSON.stringify(r));
ck('element id is not sent back in the body', sent && !('id' in sent), JSON.stringify(sent));
ck('all other fields are sent', sent.app === 'live' && sent.main === true && 'forward_scte35' in sent);

// the API refuses the shape
wmspanel.pipelineIoUpdate = async () => { throw new Error('400 Bad Request: unknown field'); };
r = await preflightWrite({}, 'C1', scenario(baseInput).transcoder);
ck('rejection is reported, not swallowed', r.status === 'rejected' && /unknown field/.test(r.error), JSON.stringify(r));

// the API accepts but silently stores something else
wmspanel.pipelineIoUpdate = async () => ({ status: 'Ok' });
wmspanel.transcoderGet = async () => scenario({ ...baseInput, main: false });
r = await preflightWrite({}, 'C1', scenario(baseInput).transcoder);
ck('silent drift is caught', r.status === 'drift' && r.drifted.includes('main'), JSON.stringify(r));

// the element vanishes
wmspanel.transcoderGet = async () => ({ transcoder: { video_pipelines: [{ id: 'p1', inputs: [] }], audio_pipelines: [] } });
r = await preflightWrite({}, 'C1', scenario(baseInput).transcoder);
ck('a lost element is caught', r.status === 'lost', JSON.stringify(r));

// nothing to verify against
r = await preflightWrite({}, 'C1', { video_pipelines: [], audio_pipelines: [] });
ck('empty scenario skips rather than failing', r.status === 'skipped', JSON.stringify(r));

// audio-only scenario still finds a subject
wmspanel.pipelineIoUpdate = async (_c, _id, kind) => { sent = kind; return { status: 'Ok' }; };
wmspanel.transcoderGet = async () => ({ transcoder: { video_pipelines: [], audio_pipelines: [{ id: 'a1', inputs: [{ ...baseInput }] }] } });
r = await preflightWrite({}, 'C1', { video_pipelines: [], audio_pipelines: [{ id: 'a1', inputs: [baseInput] }] });
ck('audio-only scenario is verified too', r.status === 'ok' && sent === 'audio', `${r.status}/${sent}`);


// ---- guarded editing (m4) -------------------------------------------------
const { classifyChange, DOCUMENTED_FIELDS } = await import('../src/routes/transcoderEdit.js');

console.log('\nFIELD CLASSIFICATION (what the vendor documents as changeable):');
ck('decoder app is documented', classifyChange('input', 'app') === 'documented');
ck('encoder stream is documented', classifyChange('output', 'stream') === 'documented');
ck('filter params are documented', classifyChange('filter', 'params') === 'documented');
ck('codec is NOT presented as supported', classifyChange('output', 'codec') === 'undocumented');
ck('forward flags are NOT presented as supported', classifyChange('input', 'forward_scte35') === 'undocumented');
ck('keyframe alignment is NOT presented as supported', classifyChange('output', 'key_frame_alignment') === 'undocumented');
ck('documented sets stay minimal', DOCUMENTED_FIELDS.input.length === 2 && DOCUMENTED_FIELDS.output.length === 2);

console.log(bad ? `\n${bad} failure(s)` : '\nall template-wizard checks passed');
process.exit(bad ? 1 : 0);
