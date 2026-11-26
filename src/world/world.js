import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LocalFrame, bboxAround } from '../geo.js';
import { loadMosaic } from '../data/tiles.js';
import { loadElevation } from '../data/elevation.js';
import { fetchOsm, parseOsm } from '../data/osm.js';
import { fetchOverture, mergeOverture } from '../data/overture.js';
import { buildTerrain } from './terrain.js';
import { buildBuildings } from './buildings.js';
import { buildVegetation } from './vegetation.js';
import { buildRoads } from './roads.js';

// Builds everything around (lat, lon): terrain from DEM, satellite texture, OSM buildings + vegetation.
// `status(key, text, state)` reports progress to the UI. Missing optional data never aborts the load.
export async function loadWorld(lat, lon, { renderer, options, signal, status }) {
  const radius = options.radius;
  const frame = new LocalFrame(lat, lon);

  // Data bbox is snapped to a ~200 m grid so repeated visits hit the OSM cache; the margin covers the snap.
  const snap = 0.002;
  const sLat = Math.round(lat / snap) * snap, sLon = Math.round(lon / snap) * snap;
  const dataBox = bboxAround(sLat, sLon, radius + 160);
  const tileBox = bboxAround(lat, lon, radius + 30);
  const maxTex = Math.min(8192, renderer.capabilities.maxTextureSize);
  const S = CONFIG.sources;

  const track = (key, label, promise, optional) => {
    status(key, label, 'loading');
    return promise.then(
      (v) => (status(key, label, 'ok'), v),
      (e) => {
        if (signal?.aborted) throw e;
        status(key, label, optional ? 'warn' : 'error', e.message);
        if (!optional) throw e;
        return null;
      },
    );
  };

  const imageryPromise = (async () => {
    for (let zoom = CONFIG.imageryZoom; zoom >= 16; zoom--) {
      try {
        const mosaic = await loadMosaic({ template: S.imagery, bbox: tileBox, zoom, maxSize: maxTex, signal,
          requireComplete: true, rejectEsriNoData: true });
        return { ...mosaic, satellite: true };
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`Satellite imagery at zoom ${zoom} unavailable; trying a lower resolution.`, error);
      }
    }
    console.warn('Satellite imagery unavailable; using map tiles.');
    const mosaic = await loadMosaic({ template: S.imageryFallback, bbox: tileBox, zoom: 16, maxSize: maxTex, signal, requireComplete: true });
    return { ...mosaic, satellite: false };
  })();

  const [elevation, imagery, osmJson, overture] = await Promise.all([
    track('terrain', 'Terrain elevation', loadElevation({ template: S.terrarium, bbox: tileBox, zoom: CONFIG.terrainZoom, signal }), false),
    track('imagery', 'Satellite imagery', imageryPromise, false),
    track('osm', 'Roads, buildings & vegetation (OpenStreetMap)', fetchOsm(dataBox, { endpoints: S.overpass, signal }), true),
    track('overture', 'Additional buildings & roads (Overture)', fetchOverture(dataBox, signal), true),
  ]);
  if (!imagery.satellite || imagery.zoom < CONFIG.imageryZoom) {
    status('imagery', 'Satellite imagery', 'warn', !imagery.satellite
      ? 'Satellite unavailable; showing map tiles' : `Showing satellite imagery at zoom ${imagery.zoom}`);
  }

  status('build', 'Building world', 'loading');
  const group = new THREE.Group();
  const terrain = buildTerrain({
    frame, elevation, imagery, radius, step: CONFIG.terrainStep, renderer, centerLat: lat, centerLon: lon,
  });
  group.add(terrain.mesh);

  let osm = osmJson ? parseOsm(osmJson, frame, radius) : { buildings: [], trees: [], areas: [], roads: [] };
  let overtureUsed = false;
  if (overture) {
    try {
      osm = mergeOverture(osm, overture, frame, radius);
      overtureUsed = true;
    } catch (error) {
      console.warn('Could not process Overture data; using OpenStreetMap only.', error);
      status('overture', 'Additional buildings & roads (Overture)', 'warn', 'Could not process Overture data');
    }
  }
  const buildings = buildBuildings(osm.buildings, terrain, imagery.satellite
    ? { imagery, frame } : null);
  const roads = buildRoads(osm.roads, terrain, radius, buildings.footprints);
  group.add(roads.group);
  group.add(buildings.group);
  const vegetation = buildVegetation({
    trees: osm.trees, areas: osm.areas, buildingGrid: buildings.footprints, roadGrid: roads.grid, terrain, imagery, frame, radius,
    maxTrees: CONFIG.maxTreeCount, inferFromImagery: options.inferTrees && !!osmJson && imagery.satellite,
    grassFromImagery: !!osmJson && imagery.satellite,
  });
  group.add(vegetation.group);
  status('build', `Built ${roads.count} road segments, ${buildings.count} buildings, ${vegetation.count} trees`, 'ok');

  return {
    group, frame, radius, terrain, imagery, lat, lon,
    wallMaterial: buildings.wallMaterial,
    heightAt: (x, z) => terrain.heightAt(x, z),
    blocked: (x, z, r) => buildings.grid.blocked(x, z, r),
    stats: { roads: roads.count, buildings: buildings.count, trees: vegetation.count, osm: !!osmJson, overture: overtureUsed,
      overtureBuildings: osm.addedBuildings || 0, overtureRoads: osm.addedRoads || 0, overtureHeights: osm.enriched || 0,
      satellite: imagery.satellite, missingTiles: imagery.tiles - imagery.loaded },
    dispose() {
      const textures = new Set();
      group.traverse((o) => {
        o.geometry?.dispose?.();
        for (const m of [].concat(o.material || [])) {
          for (const texture of [m.map, m.emissiveMap]) {
            if (texture && !textures.has(texture)) {
              textures.add(texture);
              texture.dispose();
            }
          }
          m.dispose();
        }
        if (o.isInstancedMesh) o.dispose();
      });
    },
  };
}
