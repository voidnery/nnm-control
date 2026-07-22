// Renders arbitrary JSON-ish data as readable key/value fields instead of a
// raw dump. Objects become labelled rows; arrays become numbered blocks;
// primitives render inline. A "Copy JSON" affordance keeps the raw available.
function Value({ v }) {
  if (v === null || v === undefined) return <span className="hint">—</span>;
  if (typeof v === 'boolean') return <span className={'lamp ' + (v ? 'on' : 'off')} />;
  if (typeof v === 'object') return <DataView data={v} nested />;
  return <span className="mono">{String(v)}</span>;
}

export default function DataView({ data, nested = false }) {
  if (data === null || data === undefined) return <span className="hint">—</span>;
  if (typeof data !== 'object') return <span className="mono">{String(data)}</span>;

  const entries = Array.isArray(data)
    ? data.map((v, i) => [String(i + 1), v])
    : Object.entries(data);

  if (entries.length === 0) return <span className="hint">{Array.isArray(data) ? '(empty list)' : '(none)'}</span>;

  return (
    <div className="kv-grid" style={nested ? { marginLeft: 10, paddingLeft: 10, borderLeft: '1px solid var(--line)' } : undefined}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <div className="kv-k">{k}</div>
          <div className="kv-v"><Value v={v} /></div>
        </div>
      ))}
    </div>
  );
}

export function CopyJsonButton({ data }) {
  return (
    <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(data, null, 2))}>Copy JSON</button>
  );
}
