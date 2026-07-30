// navigator.clipboard exists only in a secure context. On a panel served over
// plain HTTP — or over HTTPS with a certificate the browser will not fully
// trust — it is simply `undefined`, and `navigator.clipboard?.writeText(...)`
// then does nothing at all. Every copy button in the panel was written that
// way and paired with an unconditional "copied" toast, so the failure was not
// just silent, it actively lied.
//
// This tries the real API, falls back to the old execCommand path (which has
// no secure-context requirement), and returns whether it actually worked so
// the caller can tell the truth either way.
export async function copyText(text) {
  const s = String(text ?? '');
  if (!s) return false;

  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(s); return true; }
    catch { /* denied or unavailable — fall through */ }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    // Off-screen rather than hidden: an element with display:none or
    // visibility:hidden cannot be selected, and the copy silently fails.
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
