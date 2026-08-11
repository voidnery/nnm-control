// Places to measure *towards*, when the thing being measured is not ours.
//
// Node-to-node probes answer "can this edge reach that origin". They cannot
// answer "how far is this edge from viewers in Germany", because we have no
// machine in Germany. The nearest honest substitute is a well-known host that
// is definitely in that country, reached from our node — so this is a list of
// such hosts.
//
// Three rules shaped it, and each one rules something out:
//
//   1. No anycast. 1.1.1.1 and 8.8.8.8 answer from whichever site is nearest
//      to the *prober*, so measuring "to Germany" against them measures
//      nothing about Germany. Every entry here resolves to one region.
//   2. Latency only, never throughput. These hosts belong to other people.
//      Connect time and reachability cost them a TCP handshake; pulling
//      payload to measure bandwidth would be taking their bandwidth to answer
//      a question about ours. Capacity is measured between our own nodes,
//      where both ends are ours, or not at all.
//   3. Purpose-built for being asked. Country mirrors of Linux distributions
//      exist to serve bulk traffic to that country, and cloud storage regional
//      endpoints exist at a named location. Neither is being abused by an
//      occasional connect.
//
// These are a starting set, not an authority. Hostnames change, mirrors are
// retired, and a name that no longer resolves must not read as "that region is
// unreachable" — so the prober reports an entry that fails from *every* node
// as a probably-stale entry rather than as a network fault, and the operator
// can edit the list.
export const REFERENCE_POINTS = [
  // Country mirrors of the Ubuntu archive. The `<cc>.archive.ubuntu.com`
  // convention is long-standing and each is hosted in the country it names.
  { id: 'ubuntu-de', kind: 'mirror', host: 'de.archive.ubuntu.com', port: 80,
    country: 'DE', label: 'Ubuntu mirror, Germany', lat: 51.16, lon: 10.45 },
  { id: 'ubuntu-fr', kind: 'mirror', host: 'fr.archive.ubuntu.com', port: 80,
    country: 'FR', label: 'Ubuntu mirror, France', lat: 46.6, lon: 2.2 },
  { id: 'ubuntu-nl', kind: 'mirror', host: 'nl.archive.ubuntu.com', port: 80,
    country: 'NL', label: 'Ubuntu mirror, Netherlands', lat: 52.2, lon: 5.3 },
  { id: 'ubuntu-fi', kind: 'mirror', host: 'fi.archive.ubuntu.com', port: 80,
    country: 'FI', label: 'Ubuntu mirror, Finland', lat: 61.9, lon: 25.7 },
  { id: 'ubuntu-ru', kind: 'mirror', host: 'ru.archive.ubuntu.com', port: 80,
    country: 'RU', label: 'Ubuntu mirror, Russia', lat: 55.75, lon: 37.62 },
  { id: 'ubuntu-us', kind: 'mirror', host: 'us.archive.ubuntu.com', port: 80,
    country: 'US', label: 'Ubuntu mirror, United States', lat: 39.8, lon: -98.6 },
  { id: 'ubuntu-gb', kind: 'mirror', host: 'gb.archive.ubuntu.com', port: 80,
    country: 'GB', label: 'Ubuntu mirror, United Kingdom', lat: 54.0, lon: -2.0 },

  // Cloud storage endpoints, which name their region in the hostname and are
  // not anycast. Useful where a distro mirror is absent or unreliable.
  { id: 's3-eu-central-1', kind: 'cloud', host: 's3.eu-central-1.amazonaws.com', port: 443,
    country: 'DE', label: 'AWS eu-central-1 (Frankfurt)', lat: 50.11, lon: 8.68 },
  { id: 's3-eu-west-1', kind: 'cloud', host: 's3.eu-west-1.amazonaws.com', port: 443,
    country: 'IE', label: 'AWS eu-west-1 (Ireland)', lat: 53.35, lon: -6.26 },
  { id: 's3-eu-north-1', kind: 'cloud', host: 's3.eu-north-1.amazonaws.com', port: 443,
    country: 'SE', label: 'AWS eu-north-1 (Stockholm)', lat: 59.33, lon: 18.07 },
  { id: 's3-us-east-1', kind: 'cloud', host: 's3.us-east-1.amazonaws.com', port: 443,
    country: 'US', label: 'AWS us-east-1 (N. Virginia)', lat: 38.95, lon: -77.45 },
  { id: 's3-ap-northeast-1', kind: 'cloud', host: 's3.ap-northeast-1.amazonaws.com', port: 443,
    country: 'JP', label: 'AWS ap-northeast-1 (Tokyo)', lat: 35.68, lon: 139.75 },
  { id: 's3-ap-southeast-1', kind: 'cloud', host: 's3.ap-southeast-1.amazonaws.com', port: 443,
    country: 'SG', label: 'AWS ap-southeast-1 (Singapore)', lat: 1.35, lon: 103.82 },
  { id: 's3-sa-east-1', kind: 'cloud', host: 's3.sa-east-1.amazonaws.com', port: 443,
    country: 'BR', label: 'AWS sa-east-1 (São Paulo)', lat: -23.55, lon: -46.63 },
];

const RAD = Math.PI / 180;

// Great-circle distance, so "nearest reference points to where the operator
// clicked" is a real answer rather than a comparison of raw coordinates, which
// is wrong everywhere except near the equator.
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// The points worth probing for a place. Country first, because a host inside
// the country is the better answer even when one across a border is physically
// closer; then by distance, so an operator clicking the middle of Europe gets
// something sensible rather than nothing.
export function pointsNear({ lat, lon, country = '' }, { limit = 4, points = REFERENCE_POINTS } = {}) {
  const scored = points.map(p => ({
    ...p,
    distanceKm: Math.round(distanceKm({ lat, lon }, p)),
    inCountry: Boolean(country) && p.country === country,
  }));
  scored.sort((a, b) => (Number(b.inCountry) - Number(a.inCountry)) || (a.distanceKm - b.distanceKm));
  return scored.slice(0, limit);
}
