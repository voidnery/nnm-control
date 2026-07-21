import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
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

function Layout({ children }) {
  const { user, logout, can } = useAuth();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">NNM<b>CONTROL</b></div>
        <nav className="nav">
          {can('servers.view') && <NavLink to="/" end>Dashboard</NavLink>}
          {can('servers.view') && <NavLink to="/servers">Servers</NavLink>}
          {(can('functions.execute') || can('functions.manage')) && <NavLink to="/functions">Functions</NavLink>}
          {can('users.manage') && <NavLink to="/users">Users</NavLink>}
          {can('roles.manage') && <NavLink to="/roles">Roles</NavLink>}
          {can('zabbix.view') && <NavLink to="/zabbix">Zabbix</NavLink>}
          {can('audit.view') && <NavLink to="/audit">Audit</NavLink>}
          {can('settings.manage') && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <div className="spacer" />
        <div className="userbox">
          <div className="mono">{user.username}</div>
          <div>{user.roleType}</div>
          <button style={{ marginTop: 8 }} onClick={logout}>Log out</button>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
