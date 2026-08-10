// The attribution DB-IP's licence requires, checked like any other invariant.
//
// The geolocation database is CC BY 4.0: free to use in this application on
// one condition — a link back to db-ip.com on the pages that display results
// from it. That is a licence term, not a courtesy, and the usual way it gets
// broken is not malice but a refactor: a panel gets split into two, the block
// carrying the link stays behind, and nothing anywhere reports it. That is
// exactly what happened when the geography half moved to its own tab, and
// only the click gate caught it, and only because the component was left
// referenced rather than deleted.
//
// So: whichever component renders geolocation results must render the link,
// and the link must point where the licence says.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.jsx')) files.push(p);
  }
})(SRC);

let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };
const ok = (why) => console.log(`  ✓ ${why}`);

// A component shows geolocation results if it renders a server's resolved
// country or the state of the database itself.
const SHOWS_GEO = /geo\?\.countryCode|cdn\.geoDbLoaded|cdn\.geography/;
// The dictionaries hold the strings, not the results — matching them would
// make the check fail on the file that defines the label it matches.
const showing = files
  .filter(f => path.basename(f) !== 'i18n.jsx')
  .filter(f => SHOWS_GEO.test(readFileSync(f, 'utf8')));

if (!showing.length) {
  fail('no component renders geolocation results — the check has lost its subject');
} else {
  ok(`${showing.length} component(s) render geolocation results`);
}

for (const f of showing) {
  const src = readFileSync(f, 'utf8');
  const name = path.basename(f);
  // Either it renders the attribution itself, or it renders a component
  // defined in the same file that does.
  const hasLink = /https:\/\/db-ip\.com/.test(src);
  const usesComponent = /<DbIpAttribution\s*\/>/.test(src);
  const definesComponent = /function DbIpAttribution\s*\(/.test(src);

  if (!hasLink) {
    fail(`${name} shows geolocation results with no link back to db-ip.com — CC BY 4.0 requires one`);
    continue;
  }
  if (usesComponent && !definesComponent) {
    fail(`${name} renders <DbIpAttribution/> but does not define it — the link would throw, not appear`);
    continue;
  }
  if (!/creativecommons\.org\/licenses\/by\/4\.0/.test(src)) {
    fail(`${name} links to db-ip.com but not to the licence it is granted under`);
    continue;
  }
  ok(`${name} carries the required attribution`);
}

// The service is where the terms are recorded; if the URL there drifts, the
// page could be attributing the wrong place.
const svc = readFileSync(path.resolve(SRC, '../../backend/src/services/geoip.js'), 'utf8');
if (!/url:\s*'https:\/\/db-ip\.com'/.test(svc)) {
  fail('the attribution URL in the geoip service is not db-ip.com');
} else {
  ok('the service and the page attribute the same source');
}

console.log(bad ? `\n${bad} attribution problem(s)` : '\nattribution audit: OK');
process.exit(bad ? 1 : 0);
