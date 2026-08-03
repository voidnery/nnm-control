// The nginx template, checked before it can stop a container from starting.
//
// The image renders it with envsubst, which understands `$NAME` and `${NAME}`
// and nothing else. A shell-style default like `${VAR:-2048}` is left in the
// file verbatim, nginx rejects the directive, and the web container does not
// come up — which is a worse outcome than any limit being wrong.
//
// Also checks the media upload has a body limit at all: nginx defaults to one
// megabyte, so without it every video upload is refused with 413 before it
// reaches a panel that accepts two gigabytes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(fileURLToPath(new URL('../nginx/default.conf.template', import.meta.url)));
const src = readFileSync(file, 'utf8');
// Comments are prose and may legitimately mention the shapes being forbidden.
const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };

for (const m of code.matchAll(/\$\{[^}]*\}/g)) {
  if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(m[0])) {
    fail(`${m[0]} is not something envsubst can render — nginx would refuse to start`);
  }
}

if (!/client_max_body_size/.test(code)) {
  fail('no client_max_body_size anywhere: uploads larger than 1 MB will be refused with 413');
}
if (!/location[^\n]*agent\/media[\s\S]{0,400}client_max_body_size/.test(code)) {
  fail('the media upload location has no body limit of its own');
}
if (!/proxy_request_buffering\s+off/.test(code)) {
  fail('media uploads are buffered to the proxy first, doubling the write and delaying the panel');
}
if (code.split('{').length !== code.split('}').length) {
  fail('braces are unbalanced');
}

console.log(bad ? `\n${bad} problem(s) in the nginx template` : 'nginx audit: OK');
process.exit(bad ? 1 : 0);
