import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { useTheme } from './theme.jsx';
import { useI18n } from './i18n.jsx';

// Injected by Vite from package.json — never edit by hand. The fallback only
// applies to the audit harnesses, which bundle these files with esbuild rather
// than Vite and so have no define step.
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
import { api } from './api.js';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import ServersPage from './pages/ServersPage.jsx';
import ServerDetailPage from './pages/ServerDetailPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import RolesPage from './pages/RolesPage.jsx';
import ZabbixPage from './pages/ZabbixPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import FunctionsPage from './pages/FunctionsPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import PlaylistsPage from './pages/PlaylistsPage.jsx';
import ServerAgentsPage from './pages/ServerAgentsPage.jsx';
import LogsPage from './pages/LogsPage.jsx';
import LogCategoriesPage from './pages/LogCategoriesPage.jsx';
import LogDashboardsPage from './pages/LogDashboardsPage.jsx';
import SharedLogsPage from './pages/SharedLogsPage.jsx';
import CategoriesPage from './pages/CategoriesPage.jsx';
import TranscodersPage from './pages/TranscodersPage.jsx';
import DistributionPage from './pages/DistributionPage.jsx';

function Layout({ children }) {
  const { user, logout, can, sys } = useAuth();
  const { applyPreferred } = useTheme();
  const { t } = useI18n();
  useEffect(() => { if (user?.preferences?.theme) applyPreferred(user.preferences.theme); }, [user]);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">NNM<b>CONTROL</b></div>
        <nav className="nav">
          {can('servers.view') && <NavLink to="/" end>Dashboard</NavLink>}
          {can('servers.view') && <NavLink to="/servers">{t('nav.servers')}</NavLink>}
          {(can('functions.execute') || can('functions.manage')) && <NavLink to="/functions">{t('nav.functions')}</NavLink>}
          {can('wmsobjects.view') && sys?.controlPlane === 'wmspanel' && <NavLink to="/transcoders">{t('nav.transcoders')}</NavLink>}
          {can('wmsobjects.view') && sys?.controlPlane === 'wmspanel' && <NavLink to="/distribution">{t('nav.distribution')}</NavLink>}
          {can('playlist.view') && <NavLink to="/playlists">{t('nav.playlists')}</NavLink>}
          {can('streams.view') && <NavLink to="/logs">{t('nav.logs')}</NavLink>}
          {can('streams.view') && <NavLink to="/logs/categories">{t('nav.logCategories')}</NavLink>}
          {can('streams.view') && <NavLink to="/logs/dashboards">{t('nav.logDashboards')}</NavLink>}
          {can('servers.manage') && <NavLink to="/agents">{t('nav.agents')}</NavLink>}
          {can('category.view') && <NavLink to="/categories">{t('nav.categories')}</NavLink>}
          {can('users.manage') && <NavLink to="/users">{t('nav.users')}</NavLink>}
          {can('roles.manage') && <NavLink to="/roles">{t('nav.roles')}</NavLink>}
          {can('zabbix.view') && <NavLink to="/zabbix">{t('nav.zabbix')}</NavLink>}
          {can('audit.view') && <NavLink to="/audit">{t('nav.audit')}</NavLink>}
          {can('settings.manage') && <NavLink to="/settings">{t('nav.settings')}</NavLink>}
          <NavLink to="/profile">{t('nav.profile')}</NavLink>
        </nav>
        <div className="spacer" />
        <div className="verline">NNM Control v{APP_VERSION}</div>
        <div className="userbox">
          <div className="mono">{user.username}</div>
          <div>{user.roleType}</div>
          <button style={{ marginTop: 8 }} onClick={logout}>{t('action.logout')}</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export default function App() {
  const { user, ready } = useAuth();
  const loc = useLocation();
  // needsSetup: null = unknown (loading), true/false = resolved.
  const [needsSetup, setNeedsSetup] = useState(null);

  useEffect(() => {
    api('/setup/status')
      .then(s => setNeedsSetup(Boolean(s.needsSetup)))
      .catch(() => setNeedsSetup(false)); // backend down -> fall through to login, which will show its own error
  }, []);

  // iter10 m5 — a shared dashboard is answered before anything to do with
  // sessions. Someone watching a wall display has no account, and running the
  // setup or login checks first would send them to a login page they cannot
  // use.
  if (loc.pathname.startsWith('/shared/logs/')) {
    return <SharedLogsPage token={decodeURIComponent(loc.pathname.slice('/shared/logs/'.length))} />;
  }

  if (!ready || needsSetup === null) return null;
  if (needsSetup) return <SetupPage onDone={() => setNeedsSetup(false)} />;
  if (!user) {
    if (loc.pathname !== '/login') return <Navigate to="/login" replace />;
    return <LoginPage />;
  }
  if (loc.pathname === '/login') return <Navigate to="/" replace />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/servers/:id" element={<ServerDetailPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/zabbix" element={<ZabbixPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/functions" element={<FunctionsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/playlists" element={<PlaylistsPage />} />
        <Route path="/agents" element={<ServerAgentsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/logs/categories" element={<LogCategoriesPage />} />
        <Route path="/logs/dashboards" element={<LogDashboardsPage />} />
        <Route path="/categories" element={<CategoriesPage />} />
        <Route path="/transcoders" element={<TranscodersPage />} />
        <Route path="/distribution" element={<DistributionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
