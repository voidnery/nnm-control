import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { useTheme } from './theme.jsx';
import { useI18n } from './i18n.jsx';

// Injected by Vite from package.json — never edit by hand. The fallback only
// applies to the audit harnesses, which bundle these files with esbuild rather
// than Vite and so have no define step.
// One place that decides what is in the sidebar and in what order.
//
// `end` matters on /logs: React Router marks a NavLink active for descendant
// routes too, so without it /logs/dashboards lit up both "Logs" and
// "Log dashboards" at once. /servers deliberately does NOT set it — a server's
// detail page should keep its section highlighted.
const NAV_GROUPS = [
  { key: 'overview', items: [
    { to: '/', key: 'nav.dashboard', label: 'Dashboard', end: true, show: ({ can }) => can('servers.view') },
  ] },
  { key: 'broadcast', items: [
    { to: '/servers', key: 'nav.servers', show: ({ can }) => can('servers.view') },
    { to: '/functions', key: 'nav.functions', show: ({ can }) => can('functions.execute') || can('functions.manage') },
    { to: '/transcoders', key: 'nav.transcoders', show: ({ can, sys }) => can('wmsobjects.view') && sys?.controlPlane === 'wmspanel' },
    { to: '/distribution', key: 'nav.distribution', show: ({ can, sys }) => can('wmsobjects.view') && sys?.controlPlane === 'wmspanel' },
    // Under broadcast rather than infrastructure: it is a delivery property of
    // channels, and the operator who cares about latency is the one who lives
    // on these pages.
    { to: '/llhls', key: 'nav.llhls', show: ({ can }) => can('servers.view') },
    { to: '/playlists', key: 'nav.playlists', show: ({ can }) => can('playlist.view') },
  ] },
  { key: 'logs', items: [
    { to: '/logs', key: 'nav.logs', end: true, show: ({ can }) => can('streams.view') },
    { to: '/logs/categories', key: 'nav.logCategories', show: ({ can }) => can('streams.view') },
    { to: '/logs/dashboards', key: 'nav.logDashboards', show: ({ can }) => can('streams.view') },
  ] },
  { key: 'infra', items: [
    // The WMSPanel account objects. Infrastructure rather than broadcast: they
    // are account-wide settings edited by someone who already knows what an ABR
    // ladder is, and an operator building a delivery network has no reason to
    // walk past them.
    { to: '/account-objects', key: 'nav.objects', show: ({ can, sys }) => can('wmsobjects.view') && sys?.controlPlane === 'wmspanel' },
    { to: '/agents', key: 'nav.agents', show: ({ can }) => can('servers.manage') },
    { to: '/categories', key: 'nav.categories', show: ({ can }) => can('category.view') },
    { to: '/zabbix', key: 'nav.zabbix', show: ({ can }) => can('zabbix.view') },
  ] },
  { key: 'access', items: [
    { to: '/users', key: 'nav.users', show: ({ can }) => can('users.manage') },
    { to: '/roles', key: 'nav.roles', show: ({ can }) => can('roles.manage') },
    { to: '/audit', key: 'nav.audit', show: ({ can }) => can('audit.view') },
  ] },
  { key: 'system', items: [
    { to: '/settings', key: 'nav.settings', show: ({ can }) => can('settings.manage') },
    { to: '/profile', key: 'nav.profile' },
  ] },
];

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
import LlhlsPage from './pages/LlhlsPage.jsx';
import AccountObjectsPage from './pages/AccountObjectsPage.jsx';
import { NoticeTray } from './notices.jsx';

function Layout({ children }) {
  const { user, logout, can, sys } = useAuth();
  const { applyPreferred } = useTheme();
  const { t } = useI18n();
  useEffect(() => { if (user?.preferences?.theme) applyPreferred(user.preferences.theme); }, [user]);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">NNM<b>CONTROL</b></div>
        {/* Grouped rather than one flat list of seventeen entries.
            Data-driven so a group whose items are all hidden by permissions
            disappears with them — a limited role must not be shown the
            heading of a section it has nothing in. */}
        <nav className="nav">
          {NAV_GROUPS.map(group => {
            const items = group.items.filter(it => !it.show || it.show({ can, sys }));
            if (items.length === 0) return null;
            return (
              <div className="nav-group" key={group.key}>
                {group.key !== 'overview' && <div className="nav-group-title">{t(`nav.g.${group.key}`)}</div>}
                {items.map(it => (
                  <NavLink key={it.to} to={it.to} end={it.end}>{it.label ? it.label : t(it.key)}</NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="spacer" />
        <div className="verline">NNM Control v{APP_VERSION}</div>
        <div className="userbox">
          <div className="mono">{user.username}</div>
          <div>{user.roleType}</div>
          <button style={{ marginTop: 8 }} onClick={logout}>{t('action.logout')}</button>
        </div>
      </aside>
      {/* Top right, above the content and out of its way — the corner nothing
          else claims, so it never moves the page it comments on. */}
      <NoticeTray />
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
        <Route path="/llhls" element={<LlhlsPage />} />
        <Route path="/account-objects" element={<AccountObjectsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
