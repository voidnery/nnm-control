// The Eterix package (packaging/eterix, build.sh) — what DIST-Control and eterix-updater require of it,
// checked from the files on every run, where a mistake is cheap. The built .deb is checked again by
// eterix-ci check-deb (package job) and installed for real by ci/e2e-deb.sh (gates); this file is
// what catches the same mistakes on a machine without dpkg, and on every push.
//
// Rules by code: upd-desc/0 §5 (descriptor), upd/0 §11 P1–P19 (package), rev.17 §8.3 (hooks and
// secrets), ERS/1 §4 (no epochs). Plus one of our own: the stack is upgrade-compatible with the
// package of the old APT path — same project, volumes and environment file — so whatever is decided
// about the epoch (docs/EPOCH-MIGRATION.md), a host that switches packages keeps its data.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const E = 'packaging/eterix';
const P = 'nnm-control';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const desc = JSON.parse(read(`${E}/updater.json`));
const compose = yamlLoad(read(`${E}/compose.yml`));
const legacy = yamlLoad(read('docker-compose.yml'));
const postinst = read(`${E}/debian/postinst`);
const preinst = read(`${E}/debian/preinst`);
const prerm = read(`${E}/debian/prerm`);
const control = read(`${E}/debian/control`);
const build = read('build.sh');
const code = (s) => s.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');   // comments may name the rule

console.log('\nDESCRIPTOR (upd-desc/0 §5):');

check('every field, nothing else, with the values the engine demands', () => {
  assert.deepEqual(Object.keys(desc).sort(),
    ['apt', 'compose', 'docker_config', 'health', 'hooks', 'min_engine', 'package', 'product', 'schema_version']);
  assert.equal(desc.schema_version, 'upd-desc/0');
  assert.equal(desc.product, P);
  assert.equal(desc.package, P);
  assert.equal(desc.docker_config, `/etc/eterix/${P}/docker`);
  assert.equal(desc.apt.sources_file, `/etc/apt/sources.list.d/eterix-${P}.sources`);
  assert.deepEqual(desc.apt.components, ['main', 'core']);
  assert.match(desc.min_engine, /^\d+\.\d+\.\d+$/);
  assert.equal(desc.compose, `/opt/${P}/docker-compose.yml`);
});

check('health is on loopback, within the engine\'s window', () => {
  const u = new URL(desc.health.url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname), `${u.hostname} is not loopback`);
  assert.ok(Number.isInteger(desc.health.timeout_sec) && desc.health.timeout_sec >= 1 && desc.health.timeout_sec <= 3600);
});

check('four hooks, directly in /usr/lib/eterix/<p>/hooks, each in the package and valid sh', () => {
  for (const h of ['snapshot', 'restore', 'stop', 'start']) {
    assert.equal(desc.hooks[h], `/usr/lib/eterix/${P}/hooks/${h}`);
    assert.ok(existsSync(path.join(ROOT, E, 'hooks', h)), `hooks/${h} missing`);
    execFileSync('sh', ['-n', path.join(ROOT, E, 'hooks', h)]);
    assert.ok(build.includes('for h in snapshot restore stop start; do install -m 0755'), 'build.sh does not install the hooks 0755');
  }
});

check('the health URL is the one compose publishes and postinst waits on', () => {
  const port = new URL(desc.health.url).port;
  assert.ok(compose.services.web.ports.includes(`127.0.0.1:${port}:80`), `compose does not publish 127.0.0.1:${port}`);
  assert.ok(postinst.includes(`HEALTH=${desc.health.url}`), 'postinst waits on another URL');
});

check('Depends carries the engine at min_engine and the keyring (P9, P16)', () => {
  const dep = control.match(/^Depends: (.*)$/m)[1];
  assert.ok(dep.includes(`eterix-updater (>= ${desc.min_engine})`), 'eterix-updater >= min_engine missing');
  assert.match(dep, /(^|, )eterix-keyring(,|$)/);
  assert.match(control, /^Package: nnm-control$/m);
  assert.match(control, /^Architecture: all$/m);
  assert.match(control, /^Eterix-Security: no$/m);
});

console.log('\nTHE STACK (P1, P2, P13):');

check('every image is a stock image pinned by digest — nothing from our registry, nothing built', () => {
  for (const [name, s] of Object.entries(compose.services)) {
    assert.ok(!s.build, `${name} builds on the host`);
    assert.match(s.image, /^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${name}: ${s.image}`);
    assert.ok(!/ghcr\.io/.test(s.image), `${name} still comes from GHCR`);
  }
});

check('the application comes from the package, read-only', () => {
  assert.ok(compose.services.backend.volumes.includes(`/opt/${P}/backend:/app:ro`));
  assert.ok(compose.services.web.volumes.includes(`/opt/${P}/www:/usr/share/nginx/html:ro`));
  assert.ok(compose.services.web.volumes.includes(`/opt/${P}/nginx:/etc/nginx/templates:ro`));
});

check('the project name is fixed in the compose file and in the wrapper', () => {
  assert.equal(compose.name, P);
  assert.match(read(`${E}/compose-wrapper.sh`), /--project-name nnm-control .*--env-file \/etc\/nnm-control\/nnm-control\.env/s);
});

check('MongoDB is not published to the host', () => {
  assert.ok(!compose.services.mongo.ports, 'mongo has ports');
});

console.log('\nUPGRADE-COMPATIBLE WITH THE OLD APT PACKAGE:');

check('the same volumes, mounted at the same paths', () => {
  assert.deepEqual(Object.keys(compose.volumes).sort(), Object.keys(legacy.volumes).sort());
  for (const svc of ['mongo', 'backend']) {
    for (const v of legacy.services[svc].volumes.filter(x => !x.startsWith('/'))) {
      assert.ok(compose.services[svc].volumes.includes(v), `${svc}: ${v} is gone`);
    }
  }
});

check('the same database, environment file and panel port', () => {
  const env = (s) => (s.environment || []).find(e => e.startsWith('MONGO_URI='));
  assert.equal(env(compose.services.backend), env(legacy.services.backend));
  assert.ok(compose.services.web.ports.includes('${APP_PORT:-8090}:80'));
  assert.match(postinst, /^ENVF=\$CONF\/nnm-control\.env$/m);
  assert.match(postinst, /^CONF=\/etc\/nnm-control$/m);
  // The same debconf questions — the remembered answers carry over.
  const t = read(`${E}/debian/templates`);
  assert.match(t, /^Template: nnm-control\/domain$/m);
  assert.match(t, /^Template: nnm-control\/port$/m);
});

check('secrets are generated only when absent, so JWT_SECRET (and the field key) survives', () => {
  for (const k of ['JWT_SECRET', 'ZABBIX_TOKEN', 'SETUP_TOKEN']) assert.match(postinst, new RegExp(`ensure_secret ${k} `));
  assert.match(postinst, /ensure_secret\(\) \{\s*\n\s*\[ -n "\$\(kv_get "\$ENVF" "\$1"\)" \] \|\|/);
});

check('every path the old package installed, the new one installs at the same name', () => {
  // merged-/usr: /lib and /usr/lib are one directory, and a file that moves between the two names
  // inside one package is deleted by dpkg on upgrade (DEP17, problem P1). So the unit stays under
  // /lib, as packaging/build-deb.sh put it.
  const old = read('packaging/build-deb.sh');
  for (const p of ['/lib/systemd/system/nnm-control.service', '/opt/nnm-control/docker-compose.yml', '/usr/bin/nnm-control']) {
    const name = p.split('/').pop();
    assert.ok(old.includes(p.replace(/\/[^/]+$/, '')) && old.includes(name), `the old package no longer installs ${p}`);
  }
  assert.match(build, /"\$STAGE\/lib\/systemd\/system\/\$P\.service"/, 'the unit moved away from /lib/systemd/system');
  assert.match(build, /nnm-control-backup\.timer "\$STAGE\/lib\/systemd\/system\/"/);
  assert.match(build, /"\$APP\/docker-compose\.yml"/);
  assert.match(build, /"\$STAGE\/usr\/bin\/nnm-control"/);
  assert.ok(!/usr\/lib\/systemd/.test(build), 'a unit is installed under /usr/lib/systemd');
});

check('purge keeps the data volumes, as the old package did', () => {
  // The hint printed for the operator names the command; only a line that RUNS it is a fault.
  const runs = code(read(`${E}/debian/postrm`)).split('\n').filter(l => !/^\s*echo\b/.test(l));
  assert.ok(!runs.some(l => /docker volume rm/.test(l)), 'postrm removes a volume');
});

console.log('\nMAINTAINER SCRIPTS (P4–P19, Н3, R1, R4):');

check('all maintainer scripts are valid sh', () => {
  for (const f of ['preinst', 'postinst', 'prerm', 'postrm', 'config']) execFileSync('sh', ['-n', path.join(ROOT, E, 'debian', f)]);
});

check('preinst: no snapshot on a downgrade, none twice, otherwise the hook, then record-preinstall (P4, R1, Н4, P12)', () => {
  const c = code(preinst);
  assert.match(c, /dpkg --compare-versions "\$old" gt "\$SELF"/);
  assert.match(c, /grep -qx "v0=\$old" "\$MARK" && grep -qx "target=\$SELF" "\$MARK"/);
  const hook = c.indexOf('id=$("$HOOK")');
  const rec = c.indexOf('eterix-update record-preinstall $P --from "$old" --snapshot "$id"');
  assert.ok(hook > 0 && rec > hook, 'record-preinstall is missing or comes before the snapshot');
  assert.match(c, /record-preinstall[^\n]*\\\n\s*\|\| \{[^}]*exit 1; \}/, 'a refusal of the engine is swallowed (P12)');
});

check('prerm leaves the old stack running on upgrade (P4) and unsubscribes on removal (P14)', () => {
  assert.match(prerm, /upgrade\|failed-upgrade\) : ;;/);
  assert.match(prerm, /systemctl disable --now "eterix-update@\$P\.path" "eterix-update-check@\$P\.timer"/);
});

check('postinst: interrupted rollback, engine directories, channel only if absent (Н3, P15, P19, R4)', () => {
  const c = code(postinst);
  assert.match(c, /rollback\.pending/);
  assert.match(c, /ETERIX_ROLLBACK_TOKEN/);
  assert.match(c, /install -d -m 0770 -o root -g root \/var\/lib\/eterix\/\$P\/requests/);
  assert.match(c, /if \[ ! -f "\$CH" \] && \[ -f "\$SRC" \]/);
  assert.match(c, /export DOCKER_CONFIG=\/etc\/eterix\/\$P\/docker/);
});

check('postinst waits for THIS version, fails loudly and names the rollback (P5, P7)', () => {
  const c = code(postinst);
  assert.match(c, /"\\"version\\":\\"\$SELF\\""/);
  assert.match(c, /sudo eterix-update rollback \$P/);
  assert.match(c, /exit 1\n\s*fi\n\n\s*# P14|exit 1\n\s*fi\n\s*\n/);
});

check('postinst subscribes to updates (P14) and starts through the hooks (P17)', () => {
  assert.match(postinst, /systemctl enable --now "eterix-update@\$P\.path" "eterix-update-check@\$P\.timer"/);
  assert.match(code(postinst), /"\$H\/stop"\n\s*"\$H\/start"/);
  assert.match(read(`${E}/hooks/start`), /systemctl restart nnm-control\.service/);
});

check('no secret is printed — the setup token is named by command, never shown (rev.17 §8.3)', () => {
  const c = code(postinst);
  for (const line of c.split('\n').filter(l => /\becho\b|printf/.test(l))) {
    assert.ok(!/\$\(?kv_get "\$ENVF" (JWT_SECRET|SETUP_TOKEN|ZABBIX_TOKEN)/.test(line), `prints a secret: ${line.trim()}`);
    assert.ok(!/SETUP_TOKEN_VALUE|\$SETUP_TOKEN/.test(line), `prints the setup token: ${line.trim()}`);
  }
  assert.match(c, /sudo nnm-control setup-token/);
  assert.ok(!/^\s*read\s/m.test(c), 'postinst reads stdin');
});

check('the unit uses the wrapper and never waits forever', () => {
  const u = read(`${E}/nnm-control.service`);
  assert.match(u, /^ExecStart=\/usr\/lib\/nnm-control\/compose up -d/m);
  assert.match(u, /^Environment=DOCKER_CONFIG=\/etc\/eterix\/nnm-control\/docker$/m);
  const t = u.match(/^TimeoutStartSec=(\S+)$/m)?.[1];
  assert.ok(t && !/^(0|0s|infinity)$/.test(t), `TimeoutStartSec=${t}`);
});

console.log('\nTHE BUILD:');

check('the package version is VERSION, without an epoch (ERS/1 §4)', () => {
  assert.match(build, /VER=\$\(tr -d '\\r\\n' < VERSION\)/);
  assert.match(control, /^Version: @VERSION@$/m);
  assert.ok(!/[0-9]:@VERSION@|"1:/.test(build + control), 'an epoch crept into the thin package');
});

check('build.sh refuses package.json that disagrees with VERSION, and native modules', () => {
  assert.match(build, /поднимите оба package\.json/);
  assert.match(build, /-name '\*\.node'/);
  assert.match(build, /npm ci --omit=dev --omit=optional --ignore-scripts/);
});

check('a defective build only from defective/X.Y.Z (D-0032)', () => {
  assert.match(build, /defective\/\*\) DEFECT=/);
  assert.match(build, /файл DEFECT в ветке/);
  assert.match(postinst, /"@SKIP_PROBE@" = yes/);
});

check('the package carries the third-party notices', () => {
  assert.match(build, /node ci\/license-audit\.mjs --notices "\$DOC\/THIRD-PARTY-NOTICES"/);
});

console.log(failures ? `\n${failures} package check(s) failed` : '\nall package checks passed');
process.exit(failures ? 1 : 0);
