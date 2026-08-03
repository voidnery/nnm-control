// Thin fetch wrapper. Token lives in localStorage; 401 clears it.
const TOKEN_KEY = 'nc_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // A raw body is sent as it is: a File or Blob JSON-encoded is the string
  // "{}", which uploads a two-byte file and reports success.
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  else if (raw && body) headers['Content-Type'] = body.type || 'application/octet-stream';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) {
    clearToken();
    if (!path.startsWith('/auth/login')) window.location.href = '/login';
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
