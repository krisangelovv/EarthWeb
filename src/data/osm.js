import { pointInRing, ringBBox, signedArea } from '../geo.js';

// ---------- fetching ----------

function buildQuery(b) {
  const bb = `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
  return `[out:json][timeout:60];(
    way["building"]${bb};
    way["building:part"]${bb};
    relation["building"]["type"="multipolygon"]${bb};
    relation["building:part"]["type"="multipolygon"]${bb};
    way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road)$"]${bb};
    way["highway"="footway"]["footway"="sidewalk"]${bb};
    node["highway"="street_lamp"]${bb};
    way["landuse"~"^(residential|commercial|retail)$"]${bb};
    relation["landuse"~"^(residential|commercial|retail)$"]["type"="multipolygon"]${bb};
    node["natural"="tree"]${bb};
    way["natural"~"^(wood|scrub|grassland)$"]${bb};
    way["landuse"~"^(forest|orchard|cemetery|grass|meadow)$"]${bb};
    way["leisure"~"^(park|garden)$"]${bb};
    relation["natural"~"^(wood|scrub|grassland)$"]["type"="multipolygon"]${bb};
    relation["landuse"~"^(forest|grass|meadow)$"]["type"="multipolygon"]${bb};
    relation["leisure"="park"]["type"="multipolygon"]${bb};
  );out geom qt;`;
}

// Bound the wait for busy public Overpass servers so optional map data cannot stall world loading.
export async function fetchOsm(bbox, { endpoints, signal }) {
  const cacheKey = `https://earthweb.local/osm/${[bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(4)).join('/')}`;
  let cache = null;
  try {
    cache = await caches.open('earthweb-osm-v4');
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();
  } catch { /* Cache API unavailable (e.g. insecure context): just skip caching */ }

  const body = 'data=' + encodeURIComponent(buildQuery(bbox));
  let lastError;
  for (let i = 0; i < endpoints.length; i += 2) {
    const batch = new AbortController();
    const request = async (url) => {
      const signals = [batch.signal, AbortSignal.timeout(8000)];
      if (signal) signals.push(signal);
      const res = await fetch(url, {
        method: 'POST', body, signal: AbortSignal.any(signals),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status} from ${url}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (!Array.isArray(json.elements) || json.remark)
        throw new Error(`Overpass returned incomplete data: ${json.remark || 'missing elements'}`);
      return { json, text };
    };
    try {
      const { json, text } = await Promise.any(endpoints.slice(i, i + 2).map(request));
      batch.abort();
      if (cache) cache.put(cacheKey, new Response(text, { headers: { 'Content-Type': 'application/json' } }))
        .catch((error) => console.warn('Could not cache OSM data', error));
      return json;
    } catch (error) {
      batch.abort();
      if (signal?.aborted) throw signal.reason;
      lastError = error.errors?.[error.errors.length - 1] || error;
    }
  }
  throw lastError ?? new Error('Overpass unavailable');
}

// ---------- parsing ----------

const FT = 0.3048;
function parseLength(v) {
  if (v == null) return NaN;
  const n = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return NaN;
  return /'|ft|feet/i.test(v) ? n * FT : n;
}

// Typical heights (m) when a building has neither height nor levels tagged.
const DEFAULT_HEIGHT = {
  apartments: 18, dormitory: 15, residential: 10, house: 7, detached: 7, semidetached_house: 7, terrace: 7,
  bungalow: 4, hut: 3, shed: 3, garage: 3, garages: 3, carport: 3, roof: 3, kiosk: 3, greenhouse: 4, cabin: 4,
  church: 16, cathedral: 30, chapel: 8, industrial: 9, warehouse: 8, retail: 6, commercial: 14, office: 16,
  hotel: 18, hospital: 16, school: 10, university: 12, civic: 10, public: 10, stable: 5, barn: 7, farm: 6, service: 4,
};

const hash = (n) => {
  let h = (n | 0) * 2654435761;
  h ^= h >>> 15;
  return ((h >>> 0) % 1000) / 1000;
};

function buildingHeights(tags, id) {
  const kind = tags.building && tags.building !== 'yes' ? tags.building : tags['building:part'] || 'yes';
  let height = parseLength(tags.height);
  let guessed = false;
  if (!(height > 0)) {
    const levels = parseFloat(tags['building:levels']);
    const roofLevels = parseFloat(tags['roof:levels']) || 0;
    if (levels > 0) {
      height = levels * 3 + roofLevels * 1.5;
    } else {
      height = (DEFAULT_HEIGHT[kind] ?? 9) * (0.85 + hash(id) * 0.3);
      guessed = true;
    }
  }
  let minHeight = parseLength(tags.min_height);
  if (!(minHeight > 0)) {
    const minLevel = parseFloat(tags['building:min_level']);
    minHeight = minLevel > 0 ? minLevel * 3 : 0;
  }
  const roofHeight = parseLength(tags['roof:height']);
  const roofLevels = Number(tags['roof:levels']);
  const roofDirection = tags['roof:direction'];
  return {
    kind, height: Math.max(height, 2.5), minHeight, guessed,
    roofShape: tags['roof:shape']?.trim().toLowerCase() || null,
    roofHeight: roofHeight > 0 ? roofHeight : roofLevels > 0 ? roofLevels * 1.5 : null,
    roofOrientation: tags['roof:orientation']?.trim().toLowerCase() || null,
    roofDirection: roofDirection == null ? null : String(roofDirection).trim().toUpperCase(),
  };
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]+)$/i;
const cssColor = (v) => (v && COLOR_RE.test(v.trim()) ? v.trim() : null);
const MATERIAL_COLORS = { brick: '#a86d5a', wood: '#a88665', stone: '#b7b0a4', concrete: '#b7b7b3' };

function assembleRings(ways) {
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
  const pool = ways.map((w) => w.filter(Boolean)).filter((w) => w.length > 1);
  const rings = [];
  while (pool.length) {
    let cur = pool.pop().slice();
    let progressed = true;
    while (!same(cur[0], cur[cur.length - 1]) && progressed) {
      progressed = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i], end = cur[cur.length - 1];
        if (same(w[0], end)) cur = cur.concat(w.slice(1));
        else if (same(w[w.length - 1], end)) cur = cur.concat(w.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (same(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

function project(geom, frame) {
  const ring = [];
  for (let i = 0; i < geom.length - 1; i++) {
    const { x, z } = frame.toLocal(geom[i].lat, geom[i].lon);
    const last = ring[ring.length - 1];
    if (!last || Math.abs(last[0] - x) > 0.01 || Math.abs(last[1] - z) > 0.01) ring.push([x, z]);
  }
  return ring.length >= 3 ? ring : null;
}

function polygonsOf(el, frame) {
  if (el.type === 'way') {
    const g = (el.geometry || []).filter(Boolean);
    if (g.length < 4 || g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) return [];
    const outer = project(g, frame);
    return outer ? [{ outer, holes: [] }] : [];
  }
  if (el.type === 'relation') {
    const outers = [], inners = [];
    for (const m of el.members || []) {
      if (m.type === 'way' && m.geometry) (m.role === 'inner' ? inners : outers).push(m.geometry);
    }
    const o = assembleRings(outers).map((g) => project(g, frame)).filter(Boolean);
    const i = assembleRings(inners).map((g) => project(g, frame)).filter(Boolean);
    return o.map((outer) => ({ outer, holes: i.filter((h) => pointInRing(h[0][0], h[0][1], outer)) }));
  }
  return [];
}

function areaKind(t) {
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'scrub') return 'scrub';
  if (t.natural === 'grassland' || t.landuse === 'grass' || t.landuse === 'meadow') return 'grass';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'cemetery' || t.landuse === 'orchard') return 'park';
  return null;
}

const ROAD_WIDTHS = {
  motorway: 14, motorway_link: 6, trunk: 10, trunk_link: 6,
  primary: 9, primary_link: 6, secondary: 8, secondary_link: 6,
  tertiary: 7, tertiary_link: 5, unclassified: 6.5, residential: 6.5,
  living_street: 5, service: 4, road: 6.5,
};

function roadOf(el, frame, bridge = false) {
  const tags = el.tags || {};
  const defaultWidth = ROAD_WIDTHS[tags.highway];
  if (!defaultWidth || tags.area === 'yes' ||
      (!bridge && tags.bridge && tags.bridge !== 'no') || (tags.tunnel && tags.tunnel !== 'no') ||
      tags.location === 'underground' || (!bridge && tags.layer && Number(tags.layer) !== 0) ||
      ['unpaved', 'gravel', 'dirt', 'ground', 'grass', 'sand'].includes(tags.surface)) return null;
  const taggedWidth = parseLength(tags.width);
  const width = taggedWidth > 0 ? taggedWidth : parseLength(tags['width:carriageway']);
  const lanes = Number(tags.lanes);
  const points = (el.geometry || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => frame.toLocal(p.lat, p.lon));
  if (points.length < 2) return null;
  const localRoad = ['unclassified', 'residential', 'living_street', 'service', 'road'].includes(tags.highway);
  const estimate = localRoad && (tags.oneway === 'yes' || tags.oneway === '-1' || tags.junction === 'roundabout')
    ? Math.min(defaultWidth, 4) : defaultWidth;
  return {
    sourceKey: `${el.type}/${el.id}`,
    points, width: width > 0 ? Math.min(width, 50) : lanes > 0 ? Math.min(lanes * 3.2, 50) : estimate,
    estimatedWidth: !(width > 0 || lanes > 0) && localRoad,
    highway: tags.highway,
    sidewalk: tags.sidewalk || null,
    sidewalkLeft: tags['sidewalk:left'] || null,
    sidewalkRight: tags['sidewalk:right'] || null,
  };
}

// Converts raw Overpass JSON into projected world-space data.
export function parseOsm(json, frame, radius) {
  const buildings = [], trees = [], areas = [], roads = [], bridges = [], sidewalks = [], lamps = [], urbanAreas = [];
  const inRange = (x, z) => Math.abs(x) <= radius && Math.abs(z) <= radius;

  for (const el of json.elements || []) {
    const tags = el.tags || {};
    if (el.type === 'node') {
      if (tags.highway === 'street_lamp') {
        const p = frame.toLocal(el.lat, el.lon);
        if (inRange(p.x, p.z)) lamps.push(p);
        continue;
      }
      if (tags.natural !== 'tree') continue;
      const { x, z } = frame.toLocal(el.lat, el.lon);
      if (!inRange(x, z)) continue;
      const h = parseLength(tags.height);
      trees.push({ x, z, h: h > 0 ? h : null, needle: tags.leaf_type === 'needleleaved' });
      continue;
    }

    if (el.type === 'way' && tags.highway) {
      if (tags.highway === 'footway' && tags.footway === 'sidewalk') {
        const points = (el.geometry || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
          .map((p) => frame.toLocal(p.lat, p.lon));
        if (points.length >= 2) sidewalks.push({ points, width: Math.min(5, Math.max(0.8, parseLength(tags.width) || 1.8)) });
        continue;
      }
      const bridge = tags.bridge && tags.bridge !== 'no';
      const road = roadOf(el, frame, bridge);
      if (road) (bridge ? bridges : roads).push(road);
      continue;
    }

    if (['residential', 'commercial', 'retail'].includes(tags.landuse)) {
      for (const poly of polygonsOf(el, frame)) urbanAreas.push({ ...poly, bbox: ringBBox(poly.outer) });
      continue;
    }

    if (tags.building || tags['building:part']) {
      const isPart = !tags.building;
      const info = buildingHeights(tags, el.id);
      for (const poly of polygonsOf(el, frame)) {
        const area = Math.abs(signedArea(poly.outer));
        if (area < 4) continue;
        const bbox = ringBBox(poly.outer);
        const cx = (bbox[0] + bbox[2]) / 2, cz = (bbox[1] + bbox[3]) / 2;
        if (!inRange(cx, cz)) continue;
        buildings.push({
          id: el.id, sourceKey: `${el.type}/${el.id}`, isPart, ...poly, bbox, cx, cz, area, ...info,
          color: cssColor(tags['building:colour'] || tags['building:color'] || tags.colour) ||
            MATERIAL_COLORS[tags['building:material']] || null,
          roofColor: cssColor(tags['roof:colour'] || tags['roof:color']),
        });
      }
      continue;
    }

    const kind = areaKind(tags);
    if (kind) {
      for (const poly of polygonsOf(el, frame)) {
        areas.push({ ...poly, kind, leaf: tags.leaf_type || null, bbox: ringBBox(poly.outer) });
      }
    }
  }
  return { buildings, trees, areas, roads, bridges, sidewalks, lamps, urbanAreas };
}
