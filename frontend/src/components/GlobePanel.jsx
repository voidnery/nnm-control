import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { toVector, toLatLon, arcPoints, countryAt, nearestCountry } from '../lib/globeGeo.js';
import COUNTRIES from '../assets/countries.json';

// The network on a globe.
//
// Vector coastlines rather than a photographic texture: sharp at any zoom, no
// multi-megabyte image to ship, no licence to track — and, honestly, a glowing
// wireframe reads better than a satellite picture behind data drawn on top of
// it. The polygons are Natural Earth 110m, public domain, and they do double
// duty: they are the drawing *and* the answer to "which country did the
// operator just click", with no external service involved.
//
// three.js is imported lazily. It is comparable in size to everything else in
// the bundle put together, and this is one tab of one page.
//
// What is drawn is only what is known. A node with no coordinates is not
// placed at 0,0 in the Atlantic — it is listed beside the globe as unplaced,
// because a marker nobody can account for is worse than a marker missing.

const R = 1;

export default function GlobePanel({ network, servers = [] }) {
  const { t } = useI18n();
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState('');
  const [picked, setPicked] = useState(null);
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);

  const nodes = (network.nodes || [])
    .map(n => ({ n, s: servers.find(x => x.id === n.server) }))
    .filter(x => x.s);
  const placed = nodes.filter(x => Number.isFinite(x.s.geo?.lat) && Number.isFinite(x.s.geo?.lon));
  const unplaced = nodes.filter(x => !placed.includes(x));

  // Links to draw: every edge to what it takes content from.
  const links = [];
  for (const { n, s } of placed) {
    for (const up of n.upstream || []) {
      const from = placed.find(x => String(x.n.id) === String(up));
      if (from) links.push({ from: from.s, to: s });
    }
  }

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      let THREE;
      try { THREE = await import('three'); }
      catch (e) { setFailed(e.message); return; }
      if (disposed || !mountRef.current) return;

      const host = mountRef.current;
      const width = host.clientWidth || 800;
      const height = Math.round(Math.min(560, Math.max(360, width * 0.6)));

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 100);
      // Distance from the centre, not a scale on the world: moving the camera
      // keeps the markers the same size on screen while the planet grows,
      // which is what "zoom in on the globe" means to the person asking.
      const DIST = { min: 1.35, max: 4.6, now: 3.1 };
      const place = () => {
        camera.position.set(0, DIST.now * 0.29, DIST.now * 0.96);
        camera.lookAt(0, 0, 0);
      };
      place();

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch (e) {
        // A machine with no WebGL is a real machine. Saying so beats a blank
        // rectangle the operator has to guess about.
        setFailed('webgl');
        return;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(width, height);
      host.appendChild(renderer.domElement);

      const world = new THREE.Group();
      scene.add(world);

      const css = getComputedStyle(document.documentElement);
      const colour = (name, fallback) =>
        new THREE.Color((css.getPropertyValue(name) || '').trim() || fallback);
      const accent = colour('--accent', '#35d0ba');
      const line = colour('--line', '#2a3340');
      const dim = colour('--text-dim', '#7b8794');

      // The ocean: a dark sphere slightly inside the coastlines, so lines on
      // the far side are hidden by it and the globe reads as solid.
      const ocean = new THREE.Mesh(
        new THREE.SphereGeometry(R * 0.995, 64, 48),
        new THREE.MeshBasicMaterial({ color: colour('--bg-panel', '#111820') }),
      );
      world.add(ocean);

      // Graticule, faint — without it a rotating sphere of coastlines has no
      // sense of motion between continents.
      const grid = [];
      for (let lat = -60; lat <= 60; lat += 30) {
        for (let lon = -180; lon < 180; lon += 4) {
          grid.push(toVector(lat, lon, R), toVector(lat, lon + 4, R));
        }
      }
      for (let lon = -180; lon < 180; lon += 30) {
        for (let lat = -88; lat < 88; lat += 4) {
          grid.push(toVector(lat, lon, R), toVector(lat + 4, lon, R));
        }
      }
      const gridGeom = new THREE.BufferGeometry().setAttribute('position',
        new THREE.Float32BufferAttribute(grid.flatMap(p => [p.x, p.y, p.z]), 3));
      world.add(new THREE.LineSegments(gridGeom,
        new THREE.LineBasicMaterial({ color: line, transparent: true, opacity: 0.35 })));

      // Coastlines.
      const coast = [];
      for (const f of COUNTRIES) {
        for (const poly of f.p) {
          const ring = poly[0];
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            // A segment spanning the antimeridian would be drawn straight
            // through the middle of the planet.
            if (Math.abs(a[0] - b[0]) > 180) continue;
            coast.push(toVector(a[1], a[0], R * 1.001), toVector(b[1], b[0], R * 1.001));
          }
        }
      }
      const coastGeom = new THREE.BufferGeometry().setAttribute('position',
        new THREE.Float32BufferAttribute(coast.flatMap(p => [p.x, p.y, p.z]), 3));
      world.add(new THREE.LineSegments(coastGeom,
        new THREE.LineBasicMaterial({ color: dim, transparent: true, opacity: 0.85 })));

      // Nodes.
      const markerGeom = new THREE.SphereGeometry(0.018, 12, 12);
      for (const { n, s } of placed) {
        const v = toVector(s.geo.lat, s.geo.lon, R * 1.012);
        const m = new THREE.Mesh(markerGeom, new THREE.MeshBasicMaterial({
          color: n.role === 'origin' ? accent : (n.role === 'edge' ? colour('--ok', '#5ad18f') : dim),
        }));
        m.position.set(v.x, v.y, v.z);
        world.add(m);
      }

      // Links, as great-circle arcs.
      for (const l of links) {
        const pts = arcPoints({ lat: l.from.geo.lat, lon: l.from.geo.lon },
                              { lat: l.to.geo.lat, lon: l.to.geo.lon });
        const g = new THREE.BufferGeometry().setAttribute('position',
          new THREE.Float32BufferAttribute(pts.flatMap(p => [p.x, p.y, p.z]), 3));
        world.add(new THREE.Line(g, new THREE.LineBasicMaterial({
          color: accent, transparent: true, opacity: 0.8,
        })));
      }

      // Where the operator clicked, marked so the answer beside the globe can
      // be matched to a place on it.
      const pin = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 12),
        new THREE.MeshBasicMaterial({ color: colour('--warn', '#d2a04a') }));
      pin.visible = false;
      world.add(pin);

      const raycaster = new THREE.Raycaster();
      let dragging = false, moved = false, lastX = 0, lastY = 0;
      let spin = 0.0012;

      const onDown = (e) => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; };
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        lastX = e.clientX; lastY = e.clientY;
        world.rotation.y += dx * 0.005;
        world.rotation.x = Math.max(-1.2, Math.min(1.2, world.rotation.x + dy * 0.005));
        spin = 0;   // a globe that keeps drifting under the cursor is a fight
      };
      const onUp = (e) => {
        dragging = false;
        if (moved) return;   // a drag is not a click
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObject(ocean, false)[0];
        if (!hit) { setPicked(null); return; }
        const local = world.worldToLocal(hit.point.clone());
        const { lat, lon } = toLatLon(local);
        const exact = countryAt(lon, lat, COUNTRIES);
        const near = exact || nearestCountry(lon, lat, COUNTRIES);
        pin.position.copy(local.normalize().multiplyScalar(R * 1.012));
        pin.visible = true;
        setProbe(null);
        setPicked({ lat, lon, cc: near?.cc || '', name: near?.name || '', exact: Boolean(exact) });
      };

      // Wheel, pinch, and buttons. The wheel is damped and clamped: an
      // untrimmed wheel handler on a globe either does nothing on a trackpad
      // or throws the camera inside the planet on a mouse.
      const zoomBy = (factor) => {
        DIST.now = Math.min(DIST.max, Math.max(DIST.min, DIST.now * factor));
        place();
      };
      stateRef.current.zoomBy = zoomBy;
      const onWheel = (e) => {
        e.preventDefault();
        zoomBy(Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0016))));
      };

      const el = renderer.domElement;
      el.style.cursor = 'grab';
      el.addEventListener('wheel', onWheel, { passive: false });
      el.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);

      let raf = 0;
      const tick = () => {
        world.rotation.y += spin;
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      tick();
      setReady(true);

      cleanup = () => {
        cancelAnimationFrame(raf);
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('wheel', onWheel);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        renderer.dispose();
        scene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        el.remove();
      };
    })();

    return () => { disposed = true; cleanup(); };
  }, [network.id, servers.length]);

  const measure = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      setProbe(await api(`/cdn/networks/${network.id}/probe/region`, {
        method: 'POST', body: { lat: picked.lat, lon: picked.lon, country: picked.cc },
      }));
    } catch (e) { setProbe({ error: e.data?.error || e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{t('globe.title')}</h2>
      <div className="hint">{t('globe.intro')}</div>

      {failed && (
        <div className="error-box" style={{ marginTop: 8 }}>
          {t(failed === 'webgl' ? 'globe.noWebgl' : 'globe.failed')}
        </div>
      )}
      {/* Side by side. The answer used to appear below the globe, which put
          it off-screen at the moment it arrived: you click a place, the thing
          you clicked for renders under the fold, and the globe you are still
          looking at says nothing. Reading and pointing belong next to each
          other. */}
      <div className="globe-layout">
      <div className="globe-aside">
        {!picked && <div className="hint">{t('globe.clickPrompt')}</div>}
        {picked && (
          <>
            <div className="gsection" style={{ marginTop: 0 }}>{picked.name || t('globe.openSea')}</div>
            <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              {picked.cc && <span className="badge">{picked.cc}</span>}
              <span className="mono hint">{picked.lat.toFixed(2)}, {picked.lon.toFixed(2)}</span>
            </div>
            {!picked.exact && <div className="hint" style={{ marginTop: 4 }}>{t('globe.nearest')}</div>}
            <button className="primary" style={{ marginTop: 10 }} disabled={busy} onClick={measure}>
              {busy ? '…' : t('globe.measure')}
            </button>
            <div className="hint" style={{ marginTop: 6 }}>{t('globe.measureHint')}</div>

            {probe?.error && <div className="error-box">{probe.error}</div>}
            {probe?.rows?.length > 0 && (
              <div className="inset">
                {probe.rows.map((r, i) => (
                  <div key={i} className="globe-row">
                    <div>{r.from}</div>
                    <div className="hint">{r.label} · {r.distanceKm} km</div>
                    <div>{r.ok
                      ? <b>{r.minMs} ms</b>
                      : <span className="badge err">{t('pr.noAnswer')}</span>}</div>
                  </div>
                ))}
              </div>
            )}
            {probe && !probe.rows?.length && !probe.error && (
              <div className="hint inset">{t('globe.nothingToMeasure')}</div>
            )}
            {probe?.suspect?.length > 0 && (
              <div className="hint" style={{ marginTop: 6 }}>
                {t('globe.suspect')} {probe.suspect.map(s => s.label).join(', ')}
              </div>
            )}
            {probe?.skipped?.length > 0 && (
              <div className="hint" style={{ marginTop: 4 }}>
                {t('pr.skippedTitle')} {probe.skipped.map(s => s.node).join(', ')}
              </div>
            )}
          </>
        )}
        {unplaced.length > 0 && (
          <div className="hint inset">{t('globe.unplaced')} {unplaced.map(x => x.s.name).join(', ')}</div>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <div ref={mountRef} style={{ minHeight: 360 }} />
        {ready && (
          <div className="globe-zoom">
            <button title={t('globe.zoomIn')} onClick={() => stateRef.current.zoomBy?.(0.8)}>+</button>
            <button title={t('globe.zoomOut')} onClick={() => stateRef.current.zoomBy?.(1.25)}>−</button>
          </div>
        )}
      </div>
      </div>
      {!ready && !failed && <div className="hint">{t('globe.loading')}</div>}

      {/* Natural Earth is public domain and asks for nothing; DB-IP's licence
          asks for a link wherever its results are shown, and the coordinates
          on this globe are its results. */}
      <div className="hint attribution" style={{ marginTop: 10 }}>
        {t('globe.credits')}{' '}
        <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener noreferrer">Natural Earth</a>
        {' · '}
        <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">IP Geolocation by DB-IP</a>
        {' · '}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>
      </div>
    </div>
  );
}
