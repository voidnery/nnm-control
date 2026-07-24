// Turns a WMSPanel pipeline into something drawable.
//
// The API gives { inputs[], filters[], outputs[] } and no edges at all — the
// chain is implied by array order. A split/asplit filter fans the chain out to
// the outputs, but which post-split filter belongs to which branch is NOT
// expressed anywhere (a real scenario has 3 filters after the split feeding 2
// outputs). So the layout marks that section as unassigned instead of inventing
// a mapping that would quietly mislead the operator.
const SPLIT = /^(a?split)$/i;

export function layoutPipeline(pipeline = {}) {
  const filters = pipeline.filters || [];
  const outputs = pipeline.outputs || [];
  const idx = filters.findIndex(f => SPLIT.test(String(f.type || '')));

  if (idx === -1) {
    return {
      inputs: pipeline.inputs || [],
      pre: filters,
      split: null,
      post: [],
      outputs,
      // Without a split the order fully determines the chain.
      deterministic: true,
    };
  }
  return {
    inputs: pipeline.inputs || [],
    pre: filters.slice(0, idx),
    split: filters[idx],
    post: filters.slice(idx + 1),
    outputs,
    deterministic: false,
  };
}

export function filterLabel(f = {}) {
  const type = String(f.type || 'filter');
  if (SPLIT.test(type)) return f.outputs_number ? `${type} ×${f.outputs_number}` : type;
  if (type === 'picture') return f.filename ? `picture: ${f.filename}` : 'picture';
  const name = f.name ? String(f.name) : '';
  const params = f.params !== undefined && f.params !== null && f.params !== ''
    ? String(f.params) : '';
  if (name && params) return `${name} (${params})`;
  return name || type;
}

export function ioLabel(io = {}) {
  const path = `${io.app || '?'}/${io.stream || '?'}`;
  return io.main ? `${path} · main` : path;
}

export function codecLabel(o = {}) {
  const codec = o.codec || '';
  const enc = o.encoder || '';
  return codec && enc ? `${codec} · ${enc}` : codec || enc;
}

// Bitrate the encoder was configured with, when it is stated in params — useful
// next to the measured value.
export function configuredBitrate(o = {}) {
  const params = Array.isArray(o.params) ? o.params : [];
  const hit = params.find(p => /^(b|bitrate|maxrate|b:v|b:a)$/i.test(String(p.name || '')));
  return hit ? String(hit.value) : null;
}
