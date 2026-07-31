// The share link pointed at :443, where a different application answers.
//
// `req.get('host')` carries a port only if the client sent one AND the proxy
// passed it through. nginx's common `proxy_set_header Host $host` strips it —
// `$http_host` would have kept it — so a panel published on :8095 handed out
// links to the default port.
import assert from 'node:assert/strict';
import { fromRequest } from '../src/services/publicUrl.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const req = (host, headers = {}, protocol = 'http') => ({
  protocol, headers, get: (k) => (k.toLowerCase() === 'host' ? host : undefined),
});

console.log('DERIVING THE PANEL ADDRESS:');

check('a Host that kept its port is used as-is', () => {
  assert.equal(fromRequest(req('host-service.bbesport.com:8095')), 'http://host-service.bbesport.com:8095');
});

check('a port the proxy moved into X-Forwarded-Port is put back', () => {
  assert.equal(
    fromRequest(req('host-service.bbesport.com', { 'x-forwarded-port': '8095' })),
    'http://host-service.bbesport.com:8095',
  );
});

check('a default port is not appended', () => {
  assert.equal(
    fromRequest(req('example.com', { 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' })),
    'https://example.com',
  );
  assert.equal(fromRequest(req('example.com', { 'x-forwarded-port': '80' })), 'http://example.com');
});

check('X-Forwarded-Host outranks the internal Host', () => {
  assert.equal(
    fromRequest(req('backend:4000', { 'x-forwarded-host': 'panel.example', 'x-forwarded-proto': 'https' })),
    'https://panel.example',
  );
});

check('a comma-separated forwarded chain uses the first hop', () => {
  assert.equal(
    fromRequest(req('x', { 'x-forwarded-host': 'panel.example, inner', 'x-forwarded-proto': 'https, http' })),
    'https://panel.example',
  );
});

check('an existing port is never doubled', () => {
  assert.equal(
    fromRequest(req('panel.example:8095', { 'x-forwarded-port': '8095' })),
    'http://panel.example:8095',
  );
});

check('no trailing slash, so a path can be appended safely', () => {
  assert.ok(!fromRequest(req('panel.example')).endsWith('/'));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall public-url checks passed');
process.exit(fail ? 1 : 0);
