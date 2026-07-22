import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [sys, setSys] = useState(null); // { controlPlane, wmspanelConfigured }

  const refreshSystem = async () => {
    try { setSys(await api('/settings/public')); }
    catch { setSys({ controlPlane: 'native', wmspanelConfigured: false }); }
  };
  useEffect(() => { if (user) refreshSystem(); }, [user]);

  useEffect(() => {
    (async () => {
      if (getToken()) {
        try { setUser(await api('/auth/me')); } catch { clearToken(); }
      }
      setReady(true);
    })();
  }, []);

  const refreshUser = async () => { try { setUser(await api('/auth/me')); } catch { /* ignore */ } };

  const login = async (username, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    setToken(data.token);
    setUser(data.user);
  };
  const logout = () => { clearToken(); setUser(null); };
  const can = (perm) => !!user && (user.permissions.includes('*') || user.permissions.includes(perm));

  return <AuthCtx.Provider value={{ user, ready, login, logout, can, sys, refreshSystem, refreshUser, setUser }}>{children}</AuthCtx.Provider>;
}
