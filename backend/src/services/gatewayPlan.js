// Exactly what will be run, and exactly what will be written.
//
// This is the half that must be right before anything is applied, and it has
// one rule above all others: **the plan shown is the plan applied**. Not a
// summary of it, not an approximation — the same objects, produced by this
// function, are what the apply path executes. A preview computed separately
// from the work is a preview that drifts, and the drift is invisible until the
// day it matters.
//
// The panel is about to change a system. Everything it has written until now
// went into somebody else's API, where a wrong call is refused; `apt-get` is
// not refused. So every step here declares what it touches, what it will look
// like afterwards, and how to put it back.

const isDomain = (d) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(String(d || ''));

// A gateway's nginx: TLS in front, and a resolver so edge names are looked up
// per request rather than once at start-up.
//
// The resolver line is not decoration. Without it nginx resolves an upstream
// name when it loads its configuration and keeps that address until somebody
// restarts it — so an edge that changes address, or is replaced, keeps
// receiving nothing until a human notices. That is the failure which makes a
// balancer worse than no balancer, and it is one line.
export function nginxConf({ domain, mode = 'redirect', resolvers = '127.0.0.53 1.1.1.1', edges = [] }) {
  const upstreamBlock = mode === 'proxy'
    ? `
    # Proxy mode: the viewer never learns an edge address, and every byte
    # passes through this machine — which is the cost, stated where it is paid.
    location / {
        # Resolved per request, deliberately: see the resolver note above.
        set $edge "${edges[0]?.host || 'edge.invalid'}:${edges[0]?.httpPort || 8081}";
        proxy_pass http://$edge;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        # Playlists change every segment; segments never change. Letting nginx
        # cache the playlist would serve a stale one to everybody.
        proxy_buffering off;
    }`
    : `
    # Redirect mode: this machine decides which edge and says so with a 302.
    # The viewer then talks to the edge directly, so this box carries decisions
    # and not video — and the edge address ends up in the viewer's hands.
    location / {
        return 302 $scheme://$nnm_edge$request_uri;
    }`;

  return `# Written by NNM Control. Edited by hand? The panel will show a diff
# rather than overwrite silently.
#
# Reload with: nginx -t && systemctl reload nginx

# Names are resolved per request rather than once at start-up. Without this
# nginx keeps the address it saw when it loaded, and an edge that moves keeps
# receiving nothing until somebody restarts it.
resolver ${resolvers} valid=30s ipv6=off;
resolver_timeout 5s;

server {
    listen 80;
    server_name ${domain};

    # ACME first, so renewal keeps working, and only then the redirect. The
    # other order breaks renewal the moment TLS is on.
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    # HTTP/2 is not optional here: LL-HLS requires it, and a player without it
    # falls back to ordinary HLS in silence.
    http2 on;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
${upstreamBlock}
}
`;
}

// The steps, in the order they must happen, each saying what it touches.
//
// Ordered so that nothing irreversible happens before the things that can
// fail: ports are checked, then packages, then a certificate, and only then is
// a configuration written and a service reloaded.
export function gatewayPlan({
  server, domain, mode = 'redirect', edges = [], ports = null, email = '',
}) {
  const problems = [];
  if (!isDomain(domain)) problems.push({ code: 'bad-domain', severity: 'block' });
  if (!['redirect', 'proxy'].includes(mode)) problems.push({ code: 'bad-mode', severity: 'block' });
  if (mode === 'proxy' && !edges.length) problems.push({ code: 'proxy-needs-an-edge', severity: 'block' });

  // Ports first, and blocking. Installing nginx where something already holds
  // 80 produces a broken service rather than an error, and the operator finds
  // out by way of an outage somebody else is having.
  const held = [];
  if (ports) {
    for (const p of [80, 443]) {
      const st = ports[p] || ports[String(p)];
      if (st?.taken) held.push({ port: p, holders: st.holders || [] });
      // Unknown is not free. `ss` missing means the panel could not look, and
      // proceeding on that is exactly the assumption this project keeps
      // refusing to make.
      if (st?.taken === null) problems.push({ code: 'ports-unknown', severity: 'block', port: p });
    }
    if (held.length) problems.push({ code: 'ports-held', severity: 'block', held });
  } else {
    problems.push({ code: 'ports-not-checked', severity: 'block' });
  }

  const conf = nginxConf({ domain, mode, edges });
  const steps = [
    {
      id: 'install-nginx',
      kind: 'package',
      why: 'the gateway terminates TLS and forwards',
      command: ['apt-get', 'install', '-y', 'nginx'],
      // Named so the rollback is not a guess. A step that cannot say how to
      // undo itself does not belong in a plan the panel presents as safe.
      undo: ['apt-get', 'remove', '-y', 'nginx'],
      skipIf: 'nginx-installed',
    },
    {
      id: 'install-certbot',
      kind: 'package',
      why: 'the certificate is issued and renewed automatically',
      command: ['apt-get', 'install', '-y', 'certbot'],
      undo: ['apt-get', 'remove', '-y', 'certbot'],
      skipIf: 'certbot-installed',
    },
    {
      id: 'issue-cert',
      kind: 'command',
      why: `a certificate for ${domain}`,
      // Standalone, with nginx stopped for the moment of issue: certbot binds
      // 80 itself. `--webroot` would need a server already serving the domain,
      // which is the thing being installed.
      command: ['certbot', 'certonly', '--standalone', '--non-interactive', '--agree-tos',
                ...(email ? ['--email', email] : ['--register-unsafely-without-email']),
                '-d', String(domain)],
      // Nothing to undo: a certificate that exists harms nothing, and deleting
      // it would throw away something rate-limited and slow to replace.
      undo: null,
      needsPort: 80,
      skipIf: 'cert-present',
    },
    {
      id: 'write-conf',
      kind: 'file',
      why: 'the gateway configuration itself',
      path: `/etc/nginx/sites-available/nnm-${domain}.conf`,
      content: conf,
      // Backed up before writing, and the backup is what the undo restores.
      backup: true,
      undo: 'restore',
    },
    {
      id: 'enable-site',
      kind: 'command',
      why: 'nginx only reads what is linked',
      command: ['ln', '-sf', `/etc/nginx/sites-available/nnm-${domain}.conf`,
                `/etc/nginx/sites-enabled/nnm-${domain}.conf`],
      undo: ['rm', '-f', `/etc/nginx/sites-enabled/nnm-${domain}.conf`],
    },
    {
      id: 'test-conf',
      kind: 'command',
      why: 'a bad configuration must not reach a reload',
      command: ['nginx', '-t'],
      undo: null,
      // A failure here stops everything after it: reloading nginx onto a
      // configuration it has just rejected is how a working machine stops
      // working.
      halting: true,
    },
    {
      id: 'reload',
      kind: 'command',
      why: 'apply it',
      command: ['systemctl', 'reload-or-restart', 'nginx'],
      undo: ['systemctl', 'reload-or-restart', 'nginx'],
    },
  ];

  return {
    domain, mode,
    steps,
    problems,
    blocking: problems.filter(p => p.severity === 'block'),
    // What the operator is agreeing to, counted rather than described: three
    // packages and two files reads differently from "prepare the machine".
    summary: {
      packages: steps.filter(s => s.kind === 'package').length,
      files: steps.filter(s => s.kind === 'file').length,
      commands: steps.filter(s => s.kind === 'command').length,
    },
  };
}

// Stopping what holds a port. Separate from the plan on purpose: this is the
// one destructive thing here, and it is somebody else's service.
export function replacePlan(held) {
  return held.flatMap(({ port, holders }) => holders.map(h => ({
    id: `stop-${h.pid}`,
    kind: 'command',
    why: `${h.process} is holding ${port}`,
    // A unit is stopped by name; a bare process has to be killed, and the two
    // are not interchangeable — stopping a unit that will be restarted by
    // systemd looks like it worked and is not.
    command: h.unit ? ['systemctl', 'stop', h.unit] : ['kill', String(h.pid)],
    undo: h.unit ? ['systemctl', 'start', h.unit] : null,
    // Said plainly: a process without a unit cannot be started again by the
    // panel, and the operator is agreeing to that.
    reversible: Boolean(h.unit),
  })));
}
