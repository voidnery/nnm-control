// The kinds of WMSPanel object a function step can address.
//
// There were three copies of this list — the runner's KIND_OPS, the object
// browser's if-chain, and the model's enum — and they drifted. `incoming` was
// in the runner and in the UI's presets but in neither of the others, so the
// SRT In steps could be built, could not be browsed, and failed to save with a
// 500 from a mongoose enum violation. One list now, and a test asserts the
// runner covers exactly it.
export const OBJECT_KINDS = [
  'republish',
  'udp',
  'outgoing',
  'incoming',
  'hotswap',
  'live_pull',
  // Account-level: the server id is ignored for these.
  'transcoder',
  'abr',
  'alias',
];

export const ACCOUNT_KINDS = new Set(['transcoder', 'abr', 'alias']);
