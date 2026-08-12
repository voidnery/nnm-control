// Can this edge carry LL-HLS, iter21 m5.
//
// The first version of the protocol gate read `httpsPort` and
// `http2Confirmed` — fields that existed in no model, no API and no database.
// Every LL-HLS channel was permanently "not ready" and the option was dead
// code wearing a working feature's clothes.
//
// A checkbox would not have fixed it. "This server has HTTP/2" ticked by a
// person is a claim, and the failure it guards against — a player silently
// dropping to ordinary HLS — is invisible precisely because everything looks
// configured. So the panel asks the server, during the TLS handshake, and the
// server answers.
//
// Run against real TLS servers in-process: no fleet, no network, and the same
// code path a live edge takes.
import assert from 'node:assert/strict';
import https from 'node:https';
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { probeTls, tlsSummary } from '../src/services/tlsProbe.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

execSync('openssl req -x509 -newkey rsa:2048 -keyout /tmp/nnm-t-k.pem -out /tmp/nnm-t-c.pem '
       + '-days 2 -nodes -subj "/CN=localhost" 2>/dev/null');
const certs = { key: readFileSync('/tmp/nnm-t-k.pem'), cert: readFileSync('/tmp/nnm-t-c.pem') };
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

console.log('\nTHE SERVER ANSWERS, THE PANEL DOES NOT GUESS:');

const h2 = http2.createSecureServer({ ...certs, allowHTTP1: true });
const h2Port = await listen(h2);

await check('a server speaking HTTP/2 says so through ALPN', async () => {
  const r = await probeTls('127.0.0.1', h2Port);
  assert.equal(r.tls, true);
  assert.equal(r.alpn, 'h2');
  assert.equal(r.http2, true, 'LL-HLS would have been refused on a server that can carry it');
});

const h1 = https.createServer({ ...certs, ALPNProtocols: ['http/1.1'] }, (_q, s) => s.end('ok'));
const h1Port = await listen(h1);

await check('TLS without HTTP/2 is TLS without HTTP/2', async () => {
  // The exact configuration that produces the silent fallback: a working
  // https URL, a playing video, and no low latency anywhere.
  const r = await probeTls('127.0.0.1', h1Port);
  assert.equal(r.tls, true);
  assert.equal(r.alpn, 'http/1.1');
  assert.equal(r.http2, false);
});

console.log('\nA CERTIFICATE PROBLEM IS NOT AN ABSENCE OF TLS:');

await check('a self-signed certificate still yields the ALPN answer', async () => {
  // Refusing the handshake over the certificate would report "no TLS" about a
  // server that has TLS and a certificate problem — two different faults with
  // two different fixes.
  const r = await probeTls('127.0.0.1', h2Port);
  assert.equal(r.tls, true);
  assert.equal(r.certTrusted, false);
  assert.match(r.certError, /SELF_SIGNED/);
});

await check('the certificate is reported with an expiry a person can act on', async () => {
  const r = await probeTls('127.0.0.1', h1Port);
  assert.ok(r.certExpiresAt, 'no expiry reported');
  assert.equal(r.certExpired, false);
});

console.log('\nEACH FAILURE HAS ITS OWN WORD:');

await check('nothing listening is not a handshake failure', async () => {
  const r = await probeTls('127.0.0.1', 1, { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-listener');
});

await check('a hostname that does not resolve says so', async () => {
  const r = await probeTls('nope.invalid.example', 443, { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-such-host');
});

await check('a port that accepts and never speaks TLS times out rather than hanging', async () => {
  const { createServer } = await import('node:net');
  const dead = createServer(() => { /* accept and say nothing, ever */ });
  const port = await listen(dead);
  const r = await probeTls('127.0.0.1', port, { timeoutMs: 400 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  dead.close();
});

console.log('\nAN ANSWER IS STAMPED, NOT TRUSTED FOREVER:');

await check('the summary records when it was found out', async () => {
  // A fact about TLS from three months ago is not a fact about TLS.
  const s = tlsSummary(await probeTls('127.0.0.1', h2Port), new Date('2026-08-12T10:00:00Z'));
  assert.equal(s.checkedAt, '2026-08-12T10:00:00.000Z');
  assert.equal(s.http2, true);
  assert.equal(s.alpn, 'h2');
});

await check('a failed probe summarises as no TLS, with the reason kept', async () => {
  const s = tlsSummary(await probeTls('127.0.0.1', 1, { timeoutMs: 1000 }));
  assert.equal(s.tls, false);
  assert.equal(s.http2, false);
  assert.equal(s.reason, 'no-listener');
});

h2.close(); h1.close();
console.log(failures ? `\n${failures} TLS check(s) failed` : '\nall TLS checks passed');
process.exit(failures ? 1 : 0);
