// The certificate that is there, and what to do about it.
//
// The panel used to have two states: a path is configured, or it is not. That
// is not enough to decide anything. A certificate can be present and expired,
// present and issued for a different name, present and untrusted because it is
// self-signed or missing its intermediate — and each of those has a different
// fix, while "reissue" is only one of them and is sometimes impossible.
//
// So: one verdict, one recommended action, and the reason for both.
//
// Everything here reads the handshake rather than the filesystem. A file at
// the configured path proves nothing: Nimble may not have reloaded, the file
// may be a leftover, and what a viewer gets is decided by what the server
// presents on the wire.

// Below this, warn; certbot renews at 30, so warning at 30 would fire on every
// healthy machine for a month and be ignored by the second week.
export const WARN_DAYS = 20;

export const ACTIONS = {
  issue: 'issue',                  // nothing usable; get one
  keep: 'keep',                    // it works; leave it alone
  reissue: 'reissue',              // same name, run the plan again
  'change-domain': 'change-domain', // this name cannot work here
};

export function certificateVerdict({ tls, certDomain, configuredPath, now = new Date() }) {
  // Nothing was read from the wire. Not "there is no certificate" — nobody
  // looked, or the port did not answer, and those are different problems from
  // a bad certificate.
  if (!tls || tls.tls !== true) {
    return {
      state: configuredPath ? 'unreadable' : 'none',
      action: configuredPath ? null : ACTIONS.issue,
      domain: certDomain || null,
      why: configuredPath
        ? 'nimble.conf names a certificate but nothing answered on the TLS port, so there is nothing to judge.'
        : 'No certificate is configured on this machine.',
    };
  }

  const validTo = tls.certExpiresAt ? new Date(tls.certExpiresAt) : null;
  const daysLeft = validTo ? Math.floor((validTo - now) / 86400000) : null;

  if (tls.certExpired === true || (daysLeft !== null && daysLeft < 0)) {
    return {
      state: 'expired', action: ACTIONS.reissue, domain: certDomain, daysLeft,
      why: 'The certificate has expired. Running the same plan again reissues it for the same name.',
    };
  }

  if (tls.certTrusted !== true) {
    // The handshake worked and a player would refuse it. The error names
    // which of the several reasons it is, and only some of them are fixed by
    // reissuing: a name mismatch needs a different name, not another attempt.
    const err = String(tls.certError || '');
    const nameProblem = /ALTNAME|HOSTNAME|host ?name/i.test(err);
    return {
      state: nameProblem ? 'wrong-domain' : 'untrusted',
      action: nameProblem ? ACTIONS['change-domain'] : ACTIONS.reissue,
      domain: certDomain, daysLeft, error: tls.certError || null,
      why: nameProblem
        ? 'The certificate does not cover the name this edge is reached by. Reissuing it for the same name would produce the same result — the name has to change, or the certificate has to be issued for the one viewers use.'
        : 'A player would refuse this certificate. Most often an intermediate is missing or it is self-signed; reissuing through the panel fixes both.',
    };
  }

  if (daysLeft !== null && daysLeft <= WARN_DAYS) {
    return {
      state: 'expiring', action: ACTIONS.reissue, domain: certDomain, daysLeft,
      why: `${daysLeft} days left. certbot renews on its own timer; if this certificate was uploaded rather than issued, nothing will.`,
    };
  }

  return {
    state: 'ok', action: ACTIONS.keep, domain: certDomain, daysLeft,
    // Said out loud, because "keep" is the one verdict an operator might not
    // believe: the whole page exists because something is not working, and the
    // certificate is the usual suspect.
    why: 'This certificate works: the handshake succeeded and a player would accept it. Nothing here needs doing.',
  };
}

// Why the playlist has no parts, when the transport is up.
//
// The panel used to name both possible causes and leave the operator to find
// out which. It can find out: `alhls_enabled` is readable on the application
// through the same API the panel writes it with.
export function partsDiagnosis({ application, playlist }) {
  if (playlist?.lowLatency?.confirmed) return { state: 'ok', action: null };

  if (!application) {
    return {
      state: 'application-unknown', action: 'name-the-application',
      why: 'The playlist has no parts. Which application it belongs to is not known here, so the WMSPanel half cannot be read — name it and this becomes a definite answer instead of two possibilities.',
    };
  }

  if (application.alhls_enabled !== true) {
    return {
      state: 'off-in-wmspanel', action: 'enable',
      why: 'LL-HLS is switched off on this application in WMSPanel. That is the whole reason there are no parts; the transport is fine.',
    };
  }

  return {
    state: 'needs-restart', action: 'restart-input',
    why: 'LL-HLS is on in WMSPanel and the playlist still has no parts. Nimble keeps packaging a running stream the way it was configured when it started, so the input stream has to be restarted before this changes.',
  };
}
