// Thin client for the on-server agent. Every call is scoped to one server and
// carries that server's own token — the panel never holds a shared secret.
const TIMEOUT_MS = 20_000;

async function call(server, method, path, { query = {}, body, raw = false } = {}) {
  const cfg = server.agent || {};
  if (!cfg.enabled || !cfg.baseUrl) throw Object.assign(new Error('Agent is not configured for this server'), { status: 409 });
  const url = new URL(path, cfg.baseUrl.replace(/\/+$/, '') + '/');
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), raw ? TIMEOUT_MS * 15 : TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body && !raw ? { 'content-type': 'application/json' } : {}) },
      body: raw ? body : (body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))),
      signal: ctrl.signal,
      duplex: raw ? 'half' : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `agent HTTP ${res.status}`), { status: res.status });
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Agent did not respond in time'), { status: 504 });
    if (e.status) throw e;
    throw Object.assign(new Error(`Agent unreachable: ${e.message}`), { status: 502 });
  } finally { clearTimeout(timer); }
}

export const agent = {
  health:       (s) => call(s, 'GET', 'health'),
  configGet:    (s, name) => call(s, 'GET', 'config', { query: { name } }),
  configPut:    (s, name, content) => call(s, 'PUT', 'config', { query: { name }, body: content, raw: true }),
  mediaList:    (s) => call(s, 'GET', 'media'),
  mediaDelete:  (s, name) => call(s, 'DELETE', 'media', { query: { name } }),
  mediaPut:     (s, name, stream) => call(s, 'PUT', 'media', { query: { name }, body: stream, raw: true }),
};
