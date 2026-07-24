// Fleet health is the one genuinely new judgement here: it must not claim a
// scenario is fine when the panel simply has no way to know.
import { classifyHealth } from '../src/routes/transcoderFleet.js';

let bad = 0;
const ck = (n, ok, d = '') => { if (ok) console.log(`  ✓ ${n}`); else { bad++; console.log(`  ✗ ${n} ${d}`); } };

const H = (o) => classifyHealth({ paused: false, outputs: ['a/1', 'a/2'], flowing: 2, hasMetrics: true, known: true, ...o });

console.log('FLEET HEALTH:');
ck('all outputs flowing -> ok', H() === 'ok', H());
ck('some outputs silent -> partial', H({ flowing: 1 }) === 'partial', H({ flowing: 1 }));
ck('running but nothing flowing -> silent', H({ flowing: 0 }) === 'silent', H({ flowing: 0 }));
ck('paused is reported as paused, not silent', H({ paused: true, flowing: 0 }) === 'paused', H({ paused: true, flowing: 0 }));

console.log('\nWHEN THE PANEL CANNOT KNOW (must not be dressed up as health):');
ck('no metrics collected -> unknown', H({ hasMetrics: false }) === 'unknown', H({ hasMetrics: false }));
ck('scenario shape not cached -> unknown', H({ known: false }) === 'unknown', H({ known: false }));
ck('scenario with no outputs -> unknown', H({ outputs: [] }) === 'unknown', H({ outputs: [] }));
ck('paused without metrics is still unknown, not paused',
   H({ paused: true, hasMetrics: false }) === 'unknown', H({ paused: true, hasMetrics: false }));

console.log(bad ? `\n${bad} failure(s)` : '\nall fleet-health checks passed');
process.exit(bad ? 1 : 0);
