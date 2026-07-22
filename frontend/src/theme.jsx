import { createContext, useContext, useEffect, useState } from 'react';

// Theme is persisted server-side later (profile settings, iter3 m2). For now
// it lives in memory + a cookie so a reload keeps it without localStorage
// (artifacts/CSP-friendly and consistent with the rest of the app).
const ThemeCtx = createContext(null);
const COOKIE = 'nnm_theme';

function readCookie() {
  const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : 'system';
}
function writeCookie(v) {
  document.cookie = `${COOKIE}=${encodeURIComponent(v)}; path=/; max-age=${3600 * 24 * 365}`;
}

function apply(theme) {
  const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme === 'system' ? (sysDark ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', effective);
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readCookie());
  useEffect(() => {
    apply(theme);
    if (theme === 'system' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const h = () => apply('system');
      mq.addEventListener?.('change', h);
      return () => mq.removeEventListener?.('change', h);
    }
  }, [theme]);
  const setTheme = (t) => { writeCookie(t); setThemeState(t); };
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);
