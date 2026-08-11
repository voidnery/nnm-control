// One place that turns a failure into something a person can act on.
//
// The pattern this replaces: a route answers `{"error":"not-found"}`, the page
// puts that string in a red bar at the top, and the operator reads "not-found"
// about a server whose address is 192.168.200.129. Every part of that is
// technically true and none of it says what happened, whose fault it is, or
// what to do — and the answer here happens to be "nothing is broken, type the
// city in", which is unguessable from the word shown.
//
// So a failure carries three things from now on: what happened, why, and what
// to do about it. The raw detail stays, folded, for the case where the reader
// is the person who will fix the code.
//
// The API's part of the contract is to send a stable `code`. The dictionary's
// part is to have `err.<code>` and `err.<code>.fix` for it — enforced by
// audit:errors, so a new code cannot reach a user as a bare string.

export function explainError(e, t) {
  const data = e?.data || {};
  const code = data.code || data.error || '';
  const known = code && t('err.' + code) !== 'err.' + code;

  return {
    code,
    // Named for the reader, not for the endpoint.
    title: known ? t('err.' + code) : t('err.unknown'),
    fix: known && t('err.' + code + '.fix') !== 'err.' + code + '.fix'
      ? t('err.' + code + '.fix') : '',
    server: data.server || '',
    host: data.host || '',
    // What was actually looked at, which is usually the missing piece: an
    // operator told "cannot locate this server" still needs to know it was the
    // LAN address that got looked up.
    subject: data.ip ? `${data.ip}${data.via === 'dns' ? ` (${t('err.viaDns')})` : ''}` : '',
    // Whether the panel can offer to do something about it here and now.
    fixable: code === 'private-address' || code === 'not-found',
    status: e?.status ?? null,
    detail: e?.message || String(e),
  };
}
