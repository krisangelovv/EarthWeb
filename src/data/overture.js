import { inPolygon, PolygonGrid, signedArea } from '../geo.js';
import { parseOsm } from './osm.js';
import { RoadGrid } from '../world/roads.js';

const ZOOM = 14;
const ARCHIVE = 'https://tiles.overturemaps.org/{release}/{theme}.pmtiles';

function tileAt(lat, lon) {
  const n = 2 ** ZOOM, phi = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  return { x: Math.floor((lon + 180) / 360 * n),
    y: Math.floor((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n) };
}

function sourceKeys(properties) {
  const sources = properties.sources ? JSON.parse(properties.sources) : [];
  return sources.filter((s) => s.provider === 'osm' || s.dataset === 'OpenStreetMap')
    .map((s) => /^([wr])(\d+)(?:@|$)/.exec(s.record_id || ''))
    .filter(Boolean).map((m) => `${m[1] === 'w' ? 'way' : 'relation'}/${m[2]}`);
}

function stableId(id) {
  let value = 2166136261;
  for (const c of id) value = Math.imul(value ^ c.charCodeAt(0), 16777619);
  return value >>> 0;
}

function completeInTile(feature) {
  const extent = feature.extent;
  return feature.loadGeometry().every((line) => line.every((p) =>
    p.x > 0 && p.y > 0 && p.x < extent && p.y < extent));
}

// The published tiles are clipped and buffered; only whole geometries are safe to extrude.
export async function fetchOverture(bbox, signal) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  return Promise.race([
    loadOverture(bbox, requestSignal),
    new Promise((_, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true })),
  ]);
}

async function loadOverture(bbox, signal) {
  const [pmtiles, vectorTile, pbf, catalog] = await Promise.all([
    import('https://esm.sh/pmtiles@4.3.0'),
    import('https://esm.sh/@mapbox/vector-tile@2.0.4'),
    import('https://esm.sh/pbf@4.0.1'),
    fetch('https://stac.overturemaps.org/catalog.json', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })
      .then((r) => { if (!r.ok) throw new Error(`Overture catalog HTTP ${r.status}`); return r.json(); }),
  ]);
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(catalog.latest)) throw new Error('Invalid Overture release in catalog');
  const nw = tileAt(bbox.north, bbox.west), se = tileAt(bbox.south, bbox.east);
  const tiles = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) tiles.push({ x, y });
  if (!tiles.length || tiles.length > 36) throw new Error('Overture area exceeds the supported tile range');
  const result = { buildings: [], roads: [], release: catalog.latest };
  await Promise.all(['buildings', 'transportation'].map(async (theme) => {
    const archive = new pmtiles.PMTiles(ARCHIVE.replace('{release}', catalog.latest).replace('{theme}', theme));
    const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
    if (header.maxZoom < ZOOM) throw new Error(`Overture ${theme} tiles have insufficient detail`);
    const expected = theme === 'buildings' ? ['building', 'building_part'] : ['segment'];
    if (!expected.every((name) => metadata.vector_layers?.some((layer) => layer.id === name)))
      throw new Error(`Unsupported Overture ${theme} tile schema`);
    const chunks = await Promise.all(tiles.map(async ({ x, y }) => {
      const tile = await archive.getZxy(ZOOM, x, y, signal);
      if (!tile) return [];
      const decoded = new vectorTile.VectorTile(new pbf.default(tile.data));
      const features = [];
      for (const name of expected) {
        const layer = decoded.layers[name];
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          if (!completeInTile(feature)) continue;
          const geo = feature.toGeoJSON(x, y, ZOOM);
          features.push({ ...geo, layer: name });
        }
      }
      return features;
    }));
    result[theme === 'buildings' ? 'buildings' : 'roads'] = chunks.flat();
  }));
  return result;
}

function overlap(a, b) {
  const x0 = Math.max(a.bbox[0], b.bbox[0]), z0 = Math.max(a.bbox[1], b.bbox[1]);
  const x1 = Math.min(a.bbox[2], b.bbox[2]), z1 = Math.min(a.bbox[3], b.bbox[3]);
  if (x1 <= x0 || z1 <= z0) return false;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const x = x0 + (x1 - x0) * (i + 0.5) / 5, z = z0 + (z1 - z0) * (j + 0.5) / 5;
    if (inPolygon(x, z, a) && inPolygon(x, z, b)) return true;
  }
  return false;
}

function nearbyBuildings(grid, bbox) {
  const found = new Set();
  for (let x = Math.floor(bbox[0] / grid.cell); x <= Math.floor(bbox[2] / grid.cell); x++) {
    for (let z = Math.floor(bbox[1] / grid.cell); z <= Math.floor(bbox[3] / grid.cell); z++)
      for (const b of grid.cells.get(`${x},${z}`) || []) found.add(b);
  }
  return found;
}

function parseBuilding(feature, frame, radius) {
  const p = feature.properties;
  if (p.is_underground || Number(p.level) < 0 || !p.id || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) return [];
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const result = [];
  for (const rings of polygons) {
    if (!rings.length) continue;
    const geometry = rings[0].map(([lon, lat]) => ({ lat, lon }));
    const tags = { [feature.layer === 'building_part' ? 'building:part' : 'building']: p.class || p.subtype || 'yes',
      height: p.height, min_height: p.min_height, 'building:levels': p.num_floors, 'building:min_level': p.min_floor,
      'roof:shape': p.roof_shape, 'roof:height': p.roof_height, 'roof:orientation': p.roof_orientation,
      'roof:direction': p.roof_direction, 'roof:colour': p.roof_color, 'building:colour': p.facade_color };
    const item = parseOsm({ elements: [{ type: 'way', id: stableId(p.id), tags, geometry }] }, frame, radius).buildings[0];
    if (!item) continue;
    item.holes = rings.slice(1).map((ring) => ring.slice(0, -1).map(([lon, lat]) => {
      const point = frame.toLocal(lat, lon); return [point.x, point.z];
    })).filter((ring) => ring.length >= 3);
    item.area -= item.holes.reduce((sum, ring) => sum + Math.abs(signedArea(ring)), 0);
    result.push(item);
  }
  return result;
}

function rules(properties, key) {
  return properties[key] ? JSON.parse(properties[key]) : [];
}

function parseRoad(feature, frame, radius) {
  const p = feature.properties;
  if (!p.id || p.subtype !== 'road' || feature.geometry.type !== 'LineString') return null;
  const flags = rules(p, 'road_flags').flatMap((rule) => rule.values || []);
  if (flags.includes('is_bridge') || flags.includes('is_tunnel') ||
      rules(p, 'level_rules').some((rule) => rule.value !== 0)) return null;
  const surfaces = rules(p, 'road_surface');
  if (surfaces.some((rule) => ['unpaved', 'gravel', 'dirt', 'earth', 'ground', 'mud', 'grass', 'sand'].includes(rule.value))) return null;
  const widths = rules(p, 'width_rules').filter((rule) => !rule.between && !rule.when && Number(rule.value) > 0);
  const tags = { highway: p.class === 'unknown' ? 'road' : p.class + (p.subclass === 'link' ? '_link' : ''),
    width: widths.length === 1 ? widths[0].value : undefined, oneway: flags.includes('is_one_way') ? 'yes' : undefined };
  const geometry = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const road = parseOsm({ elements: [{ type: 'way', id: stableId(p.id), tags, geometry }] }, frame, radius).roads[0];
  if (!road) return null;
  const xs = road.points.map((p) => p.x), zs = road.points.map((p) => p.z), limit = radius + road.width;
  if (Math.min(...xs) > limit || Math.max(...xs) < -limit ||
      Math.min(...zs) > limit || Math.max(...zs) < -limit) return null;
  return road;
}

function roadIsDuplicate(road, grid) {
  let total = 0, matched = 0;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i], dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const n = Math.max(1, Math.ceil(len / 5));
    for (let j = 0; j < n; j++) {
      const x = a.x + dx * (j + 0.5) / n, z = a.z + dz * (j + 0.5) / n;
      total++;
      for (const s of grid.candidates([x - 3, z - 3, x + 3, z + 3])) {
        const sx = s.b.x - s.a.x, sz = s.b.z - s.a.z, sl = Math.hypot(sx, sz);
        if (Math.abs(dx * sx + dz * sz) < len * sl * 0.9) continue;
        const t = Math.max(0, Math.min(1, ((x - s.a.x) * sx + (z - s.a.z) * sz) / (sl * sl)));
        if (Math.hypot(x - s.a.x - t * sx, z - s.a.z - t * sz) < 3) { matched++; break; }
      }
    }
  }
  return total > 0 && matched / total >= 0.5;
}

// Keep OSM's detailed tags; use Overture heights only where OSM had to guess.
export function mergeOverture(osm, data, frame, radius) {
  const buildings = osm.buildings.map((b) => ({ ...b })), roads = osm.roads.slice();
  const osmBuildings = new Map(buildings.map((b) => [b.sourceKey, b]));
  const osmRoads = new Set(osm.roads.map((r) => r.sourceKey));
  const buildingGrid = new PolygonGrid();
  for (const b of buildings) buildingGrid.add(b);
  let addedBuildings = 0, enriched = 0, addedRoads = 0;
  for (const feature of data.buildings) {
    const keys = sourceKeys(feature.properties), matched = keys.map((k) => osmBuildings.get(k)).filter(Boolean);
    if (matched.length) {
      for (const b of matched) {
        const h = Number(feature.properties.height);
        if (b.guessed && h >= 2.5 && h < 900 && h > b.minHeight) {
          b.height = h; b.guessed = false; enriched++;
        }
      }
      continue;
    }
    for (const b of parseBuilding(feature, frame, radius)) {
      if ([...nearbyBuildings(buildingGrid, b.bbox)].some((existing) => overlap(b, existing))) continue;
      buildings.push(b); buildingGrid.add(b); addedBuildings++;
    }
  }
  const roadGrid = new RoadGrid(roads, radius);
  for (const feature of data.roads) {
    if (sourceKeys(feature.properties).some((k) => osmRoads.has(k))) continue;
    const road = parseRoad(feature, frame, radius);
    if (!road || roadIsDuplicate(road, roadGrid)) continue;
    roads.push(road); addedRoads++;
  }
  return { ...osm, buildings, roads, addedBuildings, enriched, addedRoads };
}
