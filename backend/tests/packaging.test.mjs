// The package must not say "installed" when the panel is down.
//
// On 2026-08-19 it did. `apt-get install nnm-control=1.20.0` printed two
// warnings on stderr and then the friendly box with the setup token, and
// exited 0. The stack was stopped, one image on disk and one half-fetched, and
// the operator found out from a browser.
//
// The sequence, from `/var/log/apt/term.log` and the journal:
//
//   07:02:13  Setting up nnm-control (1:1.20.0)
//             WARNING: image pull failed (offline?). Will retry on service start.
//             Job for nnm-control.service failed because a timeout was exceeded.
//             WARNING: service failed to start
//             ========== NNM Control installed. ==========
//   07:57:46  Log ended
//
// Fifty-five minutes. The pull in `postinst` did not finish, the unit pulled
// again inside its own start, and systemd killed it at `TimeoutStartSec=300`
// mid-download. A timeout meant to catch a hang produced a certain outage.
//
// These are text checks on a shell script and a unit file, which is a weak
// kind of test — but the alternative is no test at all on the two files that
// decide whether an upgrade lands, and both faults here are visible in the
// text.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (f) => join(here, '..', '..', 'packaging', f);
const postinst = readFileSync(pkg('debian/postinst'), 'utf8');
const unit = readFileSync(pkg('nnm-control.service'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Packaging\n');

check('postinst is valid shell', () => {
  // A syntax error here bricks an upgrade on every machine at once, and
  // nothing else in this suite would notice.
  execFileSync('bash', ['-n', pkg('debian/postinst')]);
});

check('a failed start is not reported as a successful install', () => {
  assert.match(postinst, /START_OK/, 'nothing records whether the service came up');
  assert.match(postinst, /exit 1/, 'postinst cannot fail, so apt cannot report a failure');
  // The banner is the thing that lied: it printed the panel URL and the setup
  // token beneath two warnings.
  const bannerAt = postinst.indexOf('NNM Control installed.');
  const guardAt = postinst.indexOf('if [ "$START_OK" != 1 ]');
  assert.ok(guardAt >= 0 && guardAt < bannerAt,
    'the "installed" banner is still printed before anything checks that it is true');
});

check('the pull is retried and its output is not thrown away', () => {
  assert.ok(!/pull --quiet 2>\/dev\/null/.test(postinst),
    'the pull still hides both its output and its failure');
  assert.match(postinst, /for attempt in/, 'a single attempt over a slow link is what failed');
});

check('a failed pull does not lead to a restart that repeats it', () => {
  // Restarting after a failed pull is what moved the fault from "the upgrade
  // did not happen" to "the previous version is down too".
  // The whole decision block, not a fixed number of characters after a marker
  // — the first version sliced 400 bytes past `START_OK=0` and stopped inside
  // a comment, so it failed on correct code.
  const at = postinst.indexOf('START_OK=0');
  const region = postinst.slice(at, postinst.indexOf('fi', postinst.indexOf('NOT restarting', at)));
  assert.match(region, /if \[ "\$PULL_OK" = 1 \]/,
    'the service is restarted regardless of whether the images arrived');
  assert.match(region, /NOT restarting/);
});

check('the unit allows longer than a cold pull takes', () => {
  const m = unit.match(/TimeoutStartSec=(\d+)/);
  assert.ok(m, 'the unit has no start timeout at all');
  assert.ok(Number(m[1]) >= 900,
    `TimeoutStartSec=${m[1]} — 300 killed docker compose mid-download and left the stack stopped`);
});

check('the unit still passes the env file, which is where the version lives', () => {
  // Running compose without it pulls `latest` and starts a stack with blank
  // secrets. That is not hypothetical: it happened during the incident, from
  // instructions that omitted it.
  const lines = unit.split('\n').filter(l => l.startsWith('Exec'));
  assert.ok(lines.length >= 2, 'the unit has no ExecStart/ExecStop');
  for (const l of lines) {
    assert.match(l, /--env-file \/etc\/nnm-control\/nnm-control\.env/,
      `${l.split('=')[0]} runs compose without the environment file`);
  }
});

console.log(failures ? `\n${failures} packaging check(s) failed` : '\nall packaging checks passed');
process.exit(failures ? 1 : 0);
