// Regression guard for the Functions engine: new per-kind actions must work AND
// steps saved before this change (which carry no objectKind and always meant
// MPEGTS outgoing) must behave exactly as before.
import assert from 'assert';
import { wmspanel } from '../src/services/wmspanelClient.js';
import { NimbleServer } from '../src/models/NimbleServer.js';
import { applyStep, rollbackStep } from '../src/services/functionRunner.js';

const calls = [];
// Minimal stateful fake of the WMSPanel side: actions/patches mutate the stored
// object so the runner's verify step can observe the change (the real API is
// eventually consistent; the runner polls until it matches).
const store = { paused: false };
const rec = (name, effect) => (...args) => {
  calls.push({ name, args: args.slice(1) });
  if (effect) effect(...args.slice(1));
  return { status: 'Ok' };
};

wmspanel.outgoingAction = rec('outgoingAction', (_sid, _id, action) => {
  if (action === 'pause') store.paused = true;
  if (action === 'resume') store.paused = false;
});
for (const m of ['republishUpdate','udpUpdate','hotswapUpdate','livePullUpdate','incomingUpdate']) {
  wmspanel[m] = rec(m, (_sid, _id, patch) => {
    if (patch && 'paused' in patch) store.paused = Boolean(patch.paused);
  });
}
for (const m of ['republishRestart','livePullRestart','transcoderPause','transcoderResume']) {
  wmspanel[m] = rec(m);
}
const listed = () => {
  const o = { id: 'OBJ1', paused: store.paused };
  return { status: 'Ok', settings: [o], streams: [o], rules: [o] };
};
for (const m of ['outgoingList','republishList','udpList','hotswapList','livePullList','incomingList']) {
  wmspanel[m] = async () => listed();
}
NimbleServer.findById = async () => ({ _id: 'S1', name: 'srv', wmspanelServerId: 'w1' });

const mkRun = () => ({ steps: [{}], markModified() {}, async save() {} });
const cfg = {};
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
};

async function run(step, initialPaused = false) { calls.length = 0; store.paused = initialPaused; await applyStep(cfg, mkRun(), 0, { serverId: 'S1', targetId: 'OBJ1', ...step }); return [...calls]; }
async function roll(step, snapshot) {
  calls.length = 0;
  const r = mkRun(); r.steps[0] = { snapshot, detail: '' };
  await rollbackStep(cfg, r, 0, step);
  return [...calls];
}

console.log('BACKWARD COMPATIBILITY (steps saved before this change):');
let c = await run({ type: 'action', action: 'pause' });                  // no objectKind
check('legacy pause -> outgoingAction(pause)', c.some(x => x.name === 'outgoingAction' && x.args[2] === 'pause'), JSON.stringify(c));
c = await run({ type: 'action', action: 'restart' });
check('legacy restart -> outgoingAction(restart)', c.some(x => x.name === 'outgoingAction' && x.args[2] === 'restart'), JSON.stringify(c));
c = await run({ type: 'action', objectKind: 'live_pull', action: 'restart' });
check('live_pull restart -> livePullRestart', c.some(x => x.name === 'livePullRestart'), JSON.stringify(c));
c = await roll({ type: 'action', action: 'pause' }, { sid: 'w1', targetId: 'OBJ1', action: 'pause', wasPaused: false });
check('legacy rollback (no kind) -> outgoingAction(resume)', c.some(x => x.name === 'outgoingAction' && x.args[2] === 'resume'), JSON.stringify(c));

console.log('\nNEW PER-KIND ACTIONS:');
c = await run({ type: 'action', objectKind: 'republish', action: 'pause' });
check('RTMP Push stop -> republishUpdate {paused:true}', c.some(x => x.name === 'republishUpdate' && x.args[2]?.paused === true), JSON.stringify(c));
c = await run({ type: 'action', objectKind: 'republish', action: 'resume' }, true);
check('RTMP Push start -> republishUpdate {paused:false}', c.some(x => x.name === 'republishUpdate' && x.args[2]?.paused === false), JSON.stringify(c));
c = await run({ type: 'action', objectKind: 'republish', action: 'restart' });
check('RTMP Push restart -> republishRestart', c.some(x => x.name === 'republishRestart'), JSON.stringify(c));
c = await run({ type: 'action', objectKind: 'udp', action: 'pause' });
check('SRT Out stop -> udpUpdate {paused:true}', c.some(x => x.name === 'udpUpdate' && x.args[2]?.paused === true), JSON.stringify(c));
c = await run({ type: 'action', objectKind: 'live_pull', action: 'pause' });
check('RTMP Pull stop -> livePullUpdate {paused:true}', c.some(x => x.name === 'livePullUpdate' && x.args[2]?.paused === true), JSON.stringify(c));
c = await roll({ type: 'action', action: 'pause' }, { sid: 'w1', kind: 'republish', targetId: 'OBJ1', action: 'pause', wasPaused: false });
check('RTMP Push rollback -> republishUpdate {paused:false}', c.some(x => x.name === 'republishUpdate' && x.args[2]?.paused === false), JSON.stringify(c));

console.log('\nCOMPOSITE RESTART (kinds the API has no restart endpoint for):');
// dwell set to 0 so the test does not actually wait out the sync cycle
c = await run({ type: 'action', objectKind: 'udp', action: 'restart', restartDwellSec: 0 });
const puts = c.filter(x => x.name === 'udpUpdate').map(x => x.args[2]?.paused);
check('SRT Out restart -> stop then start, in that order',
      puts.length === 2 && puts[0] === true && puts[1] === false, JSON.stringify(puts));
c = await run({ type: 'action', objectKind: 'incoming', action: 'restart', restartDwellSec: 0 });
const iputs = c.filter(x => x.name === 'incomingUpdate').map(x => x.args[2]?.paused);
check('SRT In restart -> stop then start', iputs.length === 2 && iputs[0] === true && iputs[1] === false, JSON.stringify(iputs));

let stoppedErr = null;
try { await run({ type: 'action', objectKind: 'udp', action: 'restart', restartDwellSec: 0 }, true); }
catch (e) { stoppedErr = e.message; }
check('restart on an already stopped object is refused', /already stopped/.test(stoppedErr || ''), stoppedErr || '(no error)');

c = await roll({ type: 'action', action: 'restart' },
               { sid: 'w1', kind: 'udp', targetId: 'OBJ1', action: 'restart', wasPaused: false, composite: true });
check('composite rollback -> restores running', c.some(x => x.name === 'udpUpdate' && x.args[2]?.paused === false), JSON.stringify(c));

console.log('\nUNSUPPORTED COMBINATIONS FAIL LOUDLY (used to hit the wrong endpoint):');
for (const [kind, action] of [['abr','pause'], ['alias','restart']]) {
  let threw = null;
  try { await run({ type: 'action', objectKind: kind, action }); } catch (e) { threw = e.message; }
  check(`${kind} ${action} rejected`, Boolean(threw), threw || '(no error thrown)');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall action-routing checks passed');
process.exit(failures ? 1 : 0);
