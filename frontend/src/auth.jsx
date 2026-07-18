import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (getToken()) {
        try { setUser(await api('/auth/me')); } catch { clearToken(); }
      }
      setReady(true);
    })();
  }, []);

  const login = async (username, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    setToken(data.token);
    setUser(data.user);
  };
  const logout = () => { clearToken(); setUser(null); };
  const can = (perm) => !!user && (user.permissions.includes('*') || user.permissions.includes(perm));

  return <AuthCtx.Provider value={{ user, ready, login, logout, can }}>{children}</AuthCtx.Provider>;
}
