// Granular permission keys. Custom roles get a subset of these.
// superadmin/admin implicitly have ALL permissions (admin additionally cannot
// touch the superadmin account itself — enforced in routes/users.js).
export const PERMISSIONS = [
  { key: 'servers.view',     label: 'Servers: view list & status' },
  { key: 'servers.manage',   label: 'Servers: add / edit / delete' },
  { key: 'streams.view',     label: 'Streams: view live streams & RTMP settings' },
  { key: 'sessions.view',    label: 'Sessions: view viewer sessions' },
  { key: 'sessions.manage',  label: 'Sessions: disconnect viewers' },
  { key: 'srt.view',         label: 'SRT: view sender/receiver stats' },
  { key: 'republish.view',   label: 'Republish: view rules & stats' },
  { key: 'republish.manage', label: 'Republish: create / delete rules' },
  { key: 'mpegts.view',      label: 'MPEG-TS: view status & settings' },
  { key: 'playlist.view',    label: 'Playout: view server playlist status' },
  { key: 'control.manage',   label: 'Control: reload config / SSL, sync WMSPanel' },
  { key: 'users.manage',     label: 'Users: manage panel users' },
  { key: 'roles.manage',     label: 'Roles: manage custom roles' },
  { key: 'zabbix.view',      label: 'Zabbix: view integration tokens/URLs' },
];
export const PERMISSION_KEYS = PERMISSIONS.map(p => p.key);
