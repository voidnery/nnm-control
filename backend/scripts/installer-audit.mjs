// The generated installer, run as a script that may have no Node on the box.
//
// v0.29.0 made Node optional and fetched it — and then four places went on
// calling `node` by bare name. The install downloaded Node, unpacked it,
// reported success, and died two lines later with "node: not found". Each of
// those calls was written when Node was a prerequisite and none of them was
// wrong at the time, which is exactly why a person re-reading the diff misses
// them.
//
// So the script is generated and inspected, rather than trusted to a review.
import { installScript } from '../src/services/agentInstaller.js';

const sh = installScript({ panelUrl: 'https://panel.example', ticket: 'a'.repeat(64) });
const lines = sh.split('\n');

let bad = 0;
const fail = (i, why) => { console.log(`  ✗ line ${i + 1}: ${why}\n      ${lines[i].trim().slice(0, 100)}`); bad++; };

lines.forEach((line, i) => {
  const code = line.replace(/#.*$/, '');
  // node used as a command: at the start, after a pipe, inside $( ), or with
  // an env prefix. Not `node_ok`, not `$NODE_BIN`, not the word in a string.
  if (/(^|\||\$\(|;|&&|\s)(?<![-_/$."'\w])node\s+-[a-z]/.test(code)) {
    fail(i, 'calls node by bare name — the machine may not have one');
  }
  // Resolving node from PATH is legitimate in exactly one place: the line that
  // decides whether a system Node exists and assigns $NODE_BIN from it.
  if (/command -v node\b/.test(code) && !/NODE_BIN=/.test(code)) {
    fail(i, 'resolves node from PATH outside the discovery step');
  }
});

// And the unit must not resolve it either: systemd's PATH is not the shell's.
const unit = sh.slice(sh.indexOf('[Service]'), sh.indexOf('[Install]'));
if (!/ExecStart=\$NODE_BIN/.test(unit)) {
  console.log('  ✗ the systemd unit does not run $NODE_BIN');
  bad++;
}

// A sanity floor: if this finds nothing at all, the regex has probably stopped
// matching the script rather than the script having become clean.
const viaBin = (sh.match(/\$NODE_BIN/g) || []).length;
if (viaBin < 3) {
  console.log(`  ✗ only ${viaBin} uses of $NODE_BIN — this check is probably looking at the wrong thing`);
  bad++;
}

console.log(bad
  ? `\n${bad} problem(s) in the generated installer`
  : `installer audit: OK (${lines.length} lines, ${viaBin} uses of $NODE_BIN, no bare node calls)`);
process.exit(bad ? 1 : 0);
