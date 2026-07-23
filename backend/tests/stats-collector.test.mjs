// The collector must cope with response shapes we have not pinned (Nimble's SRT
// counters vary by build), so it harvests numeric fields generically. These
// checks lock that behaviour in.
import { nimble } from '../src/services/nimbleClient.js';
import { collectServer, flattenNumbers } from '../src/services/statsCollector.js';

let bad = 0;
const check = (n, cond, detail = '') => { if (cond) console.log(`  ✓ ${n}`); else { bad++; console.log(`  ✗ ${n} ${detail}`); } };

console.log('FLATTENING:');
const flat = flattenNumbers({ bitrate: 5_000_000, ok: true, name: 'x', nested: { rtt: 12.5, deep: { loss: 3 } }, arr: [1, 2] });
check('numbers kept', flat.bitrate === 5_000_000);
check('booleans become 0/1', flat.ok === 1);
check('strings dropped', !('name' in flat));
check('nested paths flattened', flat['nested.rtt'] === 12.5 && flat['nested.deep.loss'] === 3, JSON.stringify(flat));
check('arrays skipped', !Object.keys(flat).some(k => k.startsWith('arr')));

console.log('\nCOLLECTION (per group):');
nimble.liveStreams = async () => ({ streams: [{ application: 'live', stream: 'cam1', bandwidth: 4_200_000, resolution: '1920x1080' }] });
nimble.republishStats = async () => ({ stats: [{ id: 'r1', src_app: 'live', src_stream: 'cam1', dest_addr: 'a.rtmp.example', state: 'connected', bandwidth: 3_900_000 }] });
// deliberately unusual SRT shape: unknown counter names, nested block
nimble.srtSenderStats = async () => ({ streams: [{ id: 's1', msRTT: 18.4, pktRetrans: 42, buffer: { msSndBuf: 120 } }] });
nimble.srtReceiverStats = async () => ({ streams: [{ id: 'r9', msRTT: 21.0, pktLoss: 7 }] });
nimble.serverStatus = async () => ({ cpu_usage: 12, memory: { free: 900, total: 4096 } });

const { samples, report } = await collectServer({ _id: 'S1', name: 'srv' }, { streams: true, republish: true, srt: true, server: true });
const by = (s) => samples.find(x => x.subject === s);

check('stream subject + bandwidth', by('stream:live/cam1')?.metrics.bandwidth === 4_200_000, JSON.stringify(samples.map(s => s.subject)));
const rp = by('republish:r1');
check('RTMP Push bandwidth captured', rp?.metrics.bandwidth === 3_900_000);
check('RTMP Push state -> connected 1/0', rp?.metrics.connected === 1);
check('RTMP Push label is readable', /a\.rtmp\.example/.test(rp?.label || ''), rp?.label);
const snd = by('srt-sender:s1');
check('unknown SRT counters harvested', snd?.metrics.msRTT === 18.4 && snd?.metrics.pktRetrans === 42, JSON.stringify(snd?.metrics));
check('nested SRT block flattened', snd?.metrics['buffer.msSndBuf'] === 120, JSON.stringify(snd?.metrics));
check('receiver sampled separately', by('srt-receiver:r9')?.metrics.pktLoss === 7);
check('server counters sampled', by('server')?.metrics.cpu_usage === 12);
check('groups tagged', by('stream:live/cam1')?.group === 'streams' && snd?.group === 'srt');

console.log('\nRESILIENCE:');
nimble.srtSenderStats = async () => { throw new Error('endpoint missing on this build'); };
const { samples: partial, report: partialReport } = await collectServer({ _id: 'S1', name: 'srv' }, { streams: true, republish: false, srt: true, server: false });
check('one failing endpoint does not lose the others', partial.some(s => s.subject === 'stream:live/cam1') && partial.some(s => s.subject === 'srt-receiver:r9'),
      JSON.stringify(partial.map(s => s.subject)));

const { samples: off } = await collectServer({ _id: 'S1', name: 'srv' }, { streams: false, republish: false, srt: false, server: false });
check('disabled groups collect nothing', off.length === 0, JSON.stringify(off));

console.log('\nDIAGNOSTICS (why a server shows no data):');
check('successful endpoint reported as ok with a count', report.streams?.status === 'ok' && report.streams.count === 1, JSON.stringify(report.streams));
check('failing endpoint reported as error, not silence', partialReport['srt-sender']?.status === 'error', JSON.stringify(partialReport['srt-sender']));
check('error message is carried through', /endpoint missing/.test(partialReport['srt-sender']?.error || ''), partialReport['srt-sender']?.error);
check('other endpoints still ok in the same run', partialReport['srt-receiver']?.status === 'ok', JSON.stringify(partialReport['srt-receiver']));

nimble.liveStreams = async () => ({ streams: [] });
const { report: emptyReport } = await collectServer({ _id: 'S1', name: 'srv' }, { streams: true });
check('nothing to collect is "empty", not "error"', emptyReport.streams?.status === 'empty', JSON.stringify(emptyReport.streams));
check('empty carries an explanation', /no live streams/.test(emptyReport.streams?.hint || ''), emptyReport.streams?.hint);

console.log(bad ? `\n${bad} failure(s)` : '\nall collector checks passed');
process.exit(bad ? 1 : 0);
