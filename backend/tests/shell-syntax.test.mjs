// Every script this panel generates must parse as shell.
//
// The privileged helper's installer carried an unbalanced parenthesis for
// eight releases' worth of debugging — two edits each adding a closing bracket
// to the same subshell. `sh` refused the file at line 140, so nothing in it
// ran: not the unit, not the echo that would have said why, not the journal
// dump added specifically to explain failures. The install log showed the
// helper block starting and then silence.
//
// Every fault this feature had was invisible from one side. This one was
// visible from here, in one command, and I never ran it — reading the code
// instead, eight times, including the two edits that broke it.
//
// `sh -n` parses without executing. It costs milliseconds and would have
// caught this before it left the machine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privilegedInstaller } from '../src/services/privilegedHelper.js';
import { installScript } from '../src/services/agentInstaller.js';
import { uninstallScript } from '../src/services/agentUninstaller.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const dir = mkdtempSync(path.join(tmpdir(), 'nnm-sh-'));
const parses = (name, text) => {
  const file = path.join(dir, `${name}.sh`);
  writeFileSync(file, text);
  try {
    // POSIX sh, not bash: the target is Ubuntu's /bin/sh, which is dash, and
    // a construct bash forgives is a construct dash refuses on a real machine.
    execFileSync('sh', ['-n', file], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`${name} does not parse: ${String(e.stderr || e.message).trim()}`);
  }
};

console.log('\nEVERY GENERATED SCRIPT PARSES:');

check('the privileged helper installer', () => {
  parses('helper', privilegedInstaller({ panelUrl: 'http://panel:8095', port: 8091 }));
});

check('the agent installer, for a media server', () => {
  parses('agent-nimble', installScript({ panelUrl: 'http://panel:8095', ticket: 'T', purpose: 'nimble' }));
});

check('the agent installer, for a gateway — which embeds the helper', () => {
  // The variant that was broken, and the only one that is: the helper is
  // absent from the other. A check that only tried one would have passed.
  parses('agent-gateway', installScript({ panelUrl: 'http://panel:8095', ticket: 'T', purpose: 'gateway' }));
});

check('the uninstaller, both ways', () => {
  parses('uninstall', uninstallScript({}));
  parses('uninstall-purge', uninstallScript({ purge: true, removeHelper: false }));
});

console.log('\nAND THE PIECES THAT VARY:');

check('a domain with punctuation does not break quoting', () => {
  // Names reach these scripts from a text box. A quote or a semicolon in one
  // must be an argument, never an instruction.
  for (const domain of ['cdn.example.com', "a'b.example.com", 'a$b.example.com', 'a`b.example.com']) {
    const { gatewayPlan } = { gatewayPlan: null };
    parses('helper-domain', privilegedInstaller({ panelUrl: `http://panel/${domain}` }));
  }
});

check('a token with awkward characters survives', () => {
  parses('helper-token', privilegedInstaller({ panelUrl: "http://p'x", port: 8091 }));
});

console.log(failures ? `\n${failures} shell-syntax check(s) failed` : '\nall shell-syntax checks passed');
process.exit(failures ? 1 : 0);
