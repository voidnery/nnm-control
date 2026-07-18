// Central config from environment. No dotenv: env comes from docker compose.
export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://mongo:27017/nnm_control',
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  jwtTtl: process.env.JWT_TTL || '12h',
  // One-time token printed by the installer (apt postinst). Required to claim
  // the superadmin account on first open — prevents a race where a random
  // visitor who opens the domain first becomes superadmin.
  setupToken: process.env.SETUP_TOKEN || '',
  zabbixToken: process.env.ZABBIX_TOKEN || '',
  hostFs: process.env.HOST_FS || '/', // read-only host root mount for disk stats
};
