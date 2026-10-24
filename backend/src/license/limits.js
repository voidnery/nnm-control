// The ONE place where the panel learns its licence limits (edition Free / Pro / …).
//
// Today there is no licence: the panel runs as Free of the approved feature matrix v2 (HQ D-0029,
// R-0005 §2, R-0004 §2.3): ONE server — the unit NNM-Control is sold by («сервер Nimble», later an
// Eterix media server). Pro opens later through ETL2: getLicenseLimits() starts reading the
// licence/entitlement (ETL2 key `servers`), while the guards that call it stay as they are.
// Changing the licence format is a cross-product contract (HO/2 §4.1): announce it before wiring.
//
// What counts: every server record of the panel, whatever its purpose (nimble, nimble-cdn,
// gateway) — each is a machine the panel manages, and counting by purpose would let an edit of the
// purpose field add a server.
//
// Over-limit data is never deleted: a panel that already manages more servers keeps all of them —
// listing, editing, agents, delivery — and only ADDING one is refused, by hand or by the WMSPanel
// import alike.
//
// Other Free points of the matrix (LL-HLS and mass operations — Pro; statistics 24 h; one agent)
// are not enforced here yet.

export const FREE = Object.freeze({
  edition: 'free',
  max: Object.freeze({ servers: 1 }),
});

const EDITION = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise' };
const RESOURCES = {
  servers: { label: 'серверов', what: 'сервер', hint: 'удалите лишний' },
};

export function getLicenseLimits() {
  return FREE;
}

/** Whether `wanted` items of `resource` fit (null or absent limit — unlimited). */
export function fits(limits, resource, wanted) {
  const max = limits.max[resource];
  return max === null || max === undefined || wanted <= max;
}

/**
 * The refusal body. `error` is the sentence a person reads — the panel shows `error` of a failed
 * request as it is — and `code` is the stable part for a program.
 */
export function refusal(limits, resource) {
  const max = limits.max[resource];
  const r = RESOURCES[resource];
  const message = `Редакция ${EDITION[limits.edition] || limits.edition}: ${r.label} — не больше ${max}. ` +
    `Чтобы добавить ${r.what}, ${r.hint}; больше даёт редакция Pro.`;
  return { error: message, code: 'license_limit', resource, limit: max, edition: limits.edition, message };
}

/** For code that creates without a request (the WMSPanel import): may one more be created? */
export async function mayAdd(resource, count, limitsOf = getLicenseLimits) {
  const limits = limitsOf();
  if (limits.max[resource] === null || limits.max[resource] === undefined) return { ok: true };
  if (fits(limits, resource, (await count()) + 1)) return { ok: true };
  return { ok: false, refusal: refusal(limits, resource) };
}

/**
 * Route guard for creating one more item of `resource`: `count()` says how many exist now.
 * Over the limit → 403 with the refusal body.
 */
export function withinLicense(resource, count, limitsOf = getLicenseLimits) {
  return async (req, res, next) => {
    try {
      const r = await mayAdd(resource, () => count(req), limitsOf);
      if (r.ok) return next();
      res.status(403).json(r.refusal);
    } catch (e) {
      next(e);
    }
  };
}
