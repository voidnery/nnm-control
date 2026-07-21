export default function ZabbixPage() {
  const base = window.location.origin;
  return (
    <div>
      <h1>Zabbix integration</h1>
      <div className="sub">HTTP Agent endpoints for Zabbix items. The token was generated at first deployment (see .env, ZABBIX_TOKEN).</div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Endpoints</h2>
        <p className="mono">{base}/api/zabbix/panel?token=&lt;ZABBIX_TOKEN&gt;</p>
        <p className="hint">Panel status: version, control plane, mongo, fleet sync age, servers mapped, function runs 24h. Alert if fleet_sync_age_sec &gt; 900 in WMSPanel mode.</p>
        <p className="mono">{base}/api/zabbix/app?token=&lt;ZABBIX_TOKEN&gt;</p>
        <p className="hint">Application metrics: uptime, RSS/heap, Mongo connectivity, managed server count.</p>
        <p className="mono">{base}/api/zabbix/system?token=&lt;ZABBIX_TOKEN&gt;</p>
        <p className="hint">Machine metrics: load average, CPU cores, RAM, host root disk usage (via read-only /host mount).</p>
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Zabbix item setup</h2>
        <p className="hint">
          Create an HTTP Agent item pointing at the URL above (or pass the token via the
          <span className="mono"> X-Zabbix-Token</span> header). Parse the JSON with dependent items and
          <span className="mono"> JSONPath</span> preprocessing, e.g. <span className="mono">$.load_1m</span>,{' '}
          <span className="mono">$.mem_used_percent</span>, <span className="mono">$.disk_root.used_percent</span>,{' '}
          <span className="mono">$.mongo_connected</span>.
        </p>
      </div>
    </div>
  );
}
