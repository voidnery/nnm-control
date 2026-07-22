// Ported from srt_engine.py (SRT Settings Helper). Pure logic, no UI.
// Computes latency/maxbw/buffers/fc + sysctl for Nimble SRT based on bitrate,
// channel scenario and whether drops are observed. Kept faithful to the
// original so numbers match the desktop tool exactly.

const MB = 1048576;
const SRT_PAYLOAD = 1316;

export const PROFILES = {
  local:  { rtt: 3,  maxbw_mult: 3.0, lat_mult: 6, lat_floor: 120, buf_mb: 8,  titleKey: 'srt.scenario.local' },
  russia: { rtt: 40, maxbw_mult: 4.0, lat_mult: 4, lat_floor: 140, buf_mb: 16, titleKey: 'srt.scenario.russia' },
  inter:  { rtt: 90, maxbw_mult: 4.0, lat_mult: 4, lat_floor: 300, buf_mb: 32, titleKey: 'srt.scenario.inter' },
};
export const SCENARIOS = ['local', 'russia', 'inter'];
const DROPS_BUF_TIER = { 8: 16, 16: 32, 32: 48 };

const kbpsToBytesS = (kbps) => kbps * 1000 / 8.0;

export function compute(bitrateKbps, scenario = 'russia', drops = false, rttOverride = null) {
  if (!PROFILES[scenario]) scenario = 'russia';
  if (!bitrateKbps || bitrateKbps <= 0) throw new Error('Bitrate must be greater than zero.');

  const p = PROFILES[scenario];
  const bytesS = kbpsToBytesS(bitrateKbps);
  const rtt = (rttOverride !== null && rttOverride !== '' && Number(rttOverride) !== 0)
    ? parseInt(rttOverride, 10) : p.rtt;

  // maxbw (bytes/s): healthy channel uses profile mult; drops narrow to 2x
  const maxbwMult = drops ? 2.0 : p.maxbw_mult;
  const maxbw = Math.round(bytesS * maxbwMult);
  const oheadbw = Math.round((maxbwMult - 1) * 100);

  // latency (ms)
  const latMult = p.lat_mult + (drops ? 3 : 0);
  const latFloor = drops ? Math.round(p.lat_floor * 1.5) : p.lat_floor;
  const latency = Math.max(latFloor, Math.round(latMult * rtt / 10.0) * 10);

  // buffers
  const baseMb = drops ? DROPS_BUF_TIER[p.buf_mb] : p.buf_mb;
  const needBytes = bytesS * (latency + rtt) / 1000.0 * 1.5;
  const bufBytes = Math.max(baseMb * MB, needBytes);
  const bufMb = Math.min(64, Math.ceil(bufBytes / MB));
  const buf = bufMb * MB;
  const fc = Math.ceil(buf / SRT_PAYLOAD);
  const needFc = bufMb > 32;
  const sysBytes = Math.max(buf, 32 * MB);

  const paramLines = [`latency=${latency}`, `maxbw=${maxbw}`, `sndbuf=${buf}`, `rcvbuf=${buf}`];
  if (needFc) paramLines.push(`fc=${fc}`);
  const paramBlock = paramLines.join('\n');
  const urlQuery = '?' + paramLines.join('&');

  const sysctlBlock = [
    `net.core.rmem_max = ${sysBytes}`,
    `net.core.wmem_max = ${sysBytes}`,
    `net.core.rmem_default = ${sysBytes}`,
    `net.core.wmem_default = ${sysBytes}`,
  ].join('\n');

  return {
    scenario, drops, bitrateKbps, bitrateMbps: bitrateKbps / 1000.0,
    bytesS: Math.round(bytesS), rtt, latency, latMult,
    maxbw, maxbwMult, maxbwMbps: maxbw * 8 / 1e6,
    oheadbw, inputbw: Math.round(bytesS),
    buf, bufMb, fc, needFc, sysBytes,
    paramBlock, urlQuery, sysctlBlock,
  };
}
