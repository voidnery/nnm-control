// The geometry the globe rests on, kept apart from the rendering.
//
// three.js draws it, but nothing here needs three.js: a click that lands on
// Germany has to land on Germany with no renderer present, and the arcs
// between nodes have to follow the sphere whether or not anything is on
// screen. Separated so all of it can be checked without a canvas.

const RAD = Math.PI / 180;

// Latitude and longitude onto a unit sphere, with the equator on the xz plane
// and the prime meridian towards +z. Which convention hardly matters; that it
// is one convention, written down once, matters a great deal — a globe with
// markers mirrored east-west looks almost right, and "almost right" is the
// hardest kind of wrong to notice on a map you are not from.
export function toVector(lat, lon, radius = 1) {
  const phi = (90 - lat) * RAD;
  const theta = (lon + 180) * RAD;
  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

// And back, for turning a point on the sphere under the cursor into a place.
export function toLatLon({ x, y, z }) {
  const r = Math.sqrt(x * x + y * y + z * z) || 1;
  const lat = 90 - Math.acos(y / r) / RAD;
  let lon = ((Math.atan2(z, -x) / RAD) - 180);
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  return { lat, lon };
}

// A great-circle arc, lifted off the surface so it reads as a link rather than
// a coastline. Interpolated on the sphere (slerp), not between the projected
// points: a straight line between two vectors cuts through the planet, which
// looks like a tunnel and is one.
export function arcPoints(a, b, { segments = 48, lift = 0.28 } = {}) {
  const p0 = toVector(a.lat, a.lon);
  const p1 = toVector(b.lat, b.lon);
  const dot = Math.min(1, Math.max(-1, p0.x * p1.x + p0.y * p1.y + p0.z * p1.z));
  const omega = Math.acos(dot);
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let v;
    if (omega < 1e-6) v = p0;
    else {
      const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
      const s1 = Math.sin(t * omega) / Math.sin(omega);
      v = { x: p0.x * s0 + p1.x * s1, y: p0.y * s0 + p1.y * s1, z: p0.z * s0 + p1.z * s1 };
    }
    // Highest in the middle, flat at both ends, so an arc meets its markers.
    const h = 1 + lift * Math.sin(Math.PI * t) * (omega / Math.PI);
    out.push({ x: v.x * h, y: v.y * h, z: v.z * h });
  }
  return out;
}

// Ray casting in lon/lat. Good enough for "which country did they click",
// which is all it is for — and unlike a nearest-centroid guess it does not put
// a click in the middle of France into Switzerland.
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)
        && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// A polygon that crosses the antimeridian arrives with longitudes spanning the
// whole range, and ray casting on it answers nonsense — Russia and Fiji both
// have such rings. Rings wider than half the world are tested in a shifted
// frame where they are contiguous.
function ringContains(lon, lat, ring) {
  let min = 180, max = -180;
  for (const [x] of ring) { if (x < min) min = x; if (x > max) max = x; }
  if (max - min <= 180) return inRing(lon, lat, ring);
  const shift = (x) => (x < 0 ? x + 360 : x);
  return inRing(shift(lon), lat, ring.map(([x, y]) => [shift(x), y]));
}

export function countryAt(lon, lat, features) {
  for (const f of features) {
    for (const poly of f.p) {
      if (ringContains(lon, lat, poly[0])) return { cc: f.cc, name: f.name };
    }
  }
  return null;
}

// Where to put the label and the probe when a click lands in the sea, or in a
// country the dataset does not carry: the nearest country by ring vertex.
// Returned separately from countryAt so the caller can say "nearest" rather
// than presenting a guess as a hit.
export function nearestCountry(lon, lat, features) {
  let best = null, bestD = Infinity;
  for (const f of features) {
    for (const poly of f.p) {
      for (const [x, y] of poly[0]) {
        const dx = Math.min(Math.abs(x - lon), 360 - Math.abs(x - lon));
        const d = dx * dx + (y - lat) * (y - lat);
        if (d < bestD) { bestD = d; best = { cc: f.cc, name: f.name }; }
      }
    }
  }
  return best;
}
