import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { NimbleServer } from '../models/NimbleServer.js';

// Token-protected plain endpoints for Zabbix HTTP Agent items.
// Auth: ?token=... or header X-Zabbix-Token. Static token from .env.
export const zabbixRouter = Router();

zabbixRouter.use((req, res, next) => {
  const token = req.query.token || req.headers['x-zabbix-token'];
  if (!config.zabbixToken || token !== config.zabbixToken) {
    return res.status(401).json({ error: 'Invalid zabbix token' });
  }
  next();
});

// Application-level metrics.
zabbixRouter.get('/app', async (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    app: 'nnm-control',
    uptime_sec: Math.round(process.uptime()),
    node_version: process.version,
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    mongo_connected: mongoose.connection.readyState === 1 ? 1 : 0,
    managed_servers: await NimbleServer.countDocuments().catch(() => -1),
  });
});

// Machine-level metrics. Disk is read from the read-only host mount (HOST_FS)
// so numbers reflect the HOST filesystem, not the container overlay.
zabbixRouter.get('/system', async (_req, res) => {
  const load = os.loadavg();
  let disk = null;
  try {
    const st = await fs.statfs(config.hostFs);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    disk = {
      total_bytes: total,
      free_bytes: free,
      used_bytes: total - free,
      used_percent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
    };
  } catch (e) {
    disk = { error: e.message };
  }
  res.json({
    hostname: os.hostname(),
    uptime_sec: Math.round(os.uptime()),
    cpu_cores: os.cpus().length,
    load_1m: load[0], load_5m: load[1], load_15m: load[2],
    mem_total_bytes: os.totalmem(),
    mem_free_bytes: os.freemem(),
    mem_used_percent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10,
    disk_root: disk,
  });
});
