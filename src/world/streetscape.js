import * as THREE from 'three';
import { PolygonGrid } from '../geo.js';
import { RoadGrid, triangleIntersectsBuildings } from './roads.js';

const URBAN_ROADS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'road']);

function mappedSides(road) {
  const no = (value) => ['no', 'none', 'separate'].includes(value);
  const yes = (value) => value && !no(value);
  const common = road.sidewalk;
  return {
    left: road.sidewalkLeft ? yes(road.sidewalkLeft) : ['both', 'left', 'yes'].includes(common),
    right: road.sidewalkRight ? yes(road.sidewalkRight) : ['both', 'right', 'yes'].includes(common),
    tagged: !!(common || road.sidewalkLeft || road.sidewalkRight),
  };
}

export function buildStreetscape({ roads, sidewalks, lamps, urbanAreas, buildings, terrain, imagery, frame, radius }) {
  const urban = new PolygonGrid();
  for (const poly of urbanAreas) urban.add(poly);
  const surface = [], uvs = [], clearance = [], lightPositions = [];
  const lightCells = new Map(), cellSize = 30;
  const addLamp = (p, mapped = false) => {
    if (Math.abs(p.x) > radius || Math.abs(p.z) > radius || buildings.blocked(p.x, p.z, 0.3)) return;
    const cx = Math.floor(p.x / cellSize), cz = Math.floor(p.z / cellSize);
    if (!mapped) {
      for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++)
        for (const q of lightCells.get(`${x},${z}`) || [])
          if (Math.hypot(p.x - q.x, p.z - q.z) < 30) return;
    }
    const key = `${cx},${cz}`;
    if (!lightCells.has(key)) lightCells.set(key, []);
    lightCells.get(key).push(p);
    lightPositions.push(p);
  };
  for (const lamp of lamps) addLamp(lamp, true);
  const urbanAt = (x, z) => {
    if (urban.contains(x, z)) return true;
    const found = new Set(), reach = 40;
    for (let i = Math.floor((x - reach) / buildings.cell); i <= Math.floor((x + reach) / buildings.cell); i++)
      for (let j = Math.floor((z - reach) / buildings.cell); j <= Math.floor((z + reach) / buildings.cell); j++)
        for (const b of buildings.cells.get(`${i},${j}`) || []) {
          const cx = (b.bbox[0] + b.bbox[2]) / 2, cz = (b.bbox[1] + b.bbox[3]) / 2;
          if (Math.hypot(x - cx, z - cz) <= reach) found.add(b);
        }
    return found.size >= 3;
  };
  const vertex = (p) => {
    surface.push(p.x, terrain.heightAt(p.x, p.z) + 0.18, p.z);
    const geo = frame.toGeo(p.x, p.z), pixel = imagery.toPixel(geo.lat, geo.lon);
    uvs.push(pixel.x / imagery.width, 1 - pixel.y / imagery.height);
  };
  const strip = (a, b, inner, outer, checkRoad, infer) => {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 0.1) return;
    const nx = dz / len, nz = -dx / len, steps = Math.ceil(len / 4);
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps, mid = (t0 + t1) / 2;
      const center = { x: a.x + dx * mid + nx * (inner + outer) / 2,
        z: a.z + dz * mid + nz * (inner + outer) / 2 };
      if (Math.abs(center.x) > radius || Math.abs(center.z) > radius ||
          infer && !urbanAt(center.x, center.z) ||
          checkRoad && roads.intersectsDisc(center.x, center.z, Math.abs(outer - inner) * 0.35)) continue;
      const point = (t, off) => ({ x: a.x + dx * t + nx * off, z: a.z + dz * t + nz * off });
      const p = point(t0, inner), q = point(t1, inner), r = point(t0, outer), s = point(t1, outer);
      if (!triangleIntersectsBuildings(p, r, q, buildings) && !triangleIntersectsBuildings(q, r, s, buildings)) {
        vertex(p); vertex(r); vertex(q); vertex(q); vertex(r); vertex(s);
        clearance.push({ a: point(t0, (inner + outer) / 2), b: point(t1, (inner + outer) / 2), half: Math.abs(outer - inner) / 2 });
        if (checkRoad) addLamp({ x: a.x + dx * mid + nx * (outer - Math.sign(outer - inner) * 0.2),
          z: a.z + dz * mid + nz * (outer - Math.sign(outer - inner) * 0.2) });
      }
    }
  };
  for (const { a, b, half, road } of roads.segments) {
    const sides = mappedSides(road);
    const infer = !sides.tagged && URBAN_ROADS.has(road.highway);
    if (sides.left || infer) strip(a, b, half + 0.2, half + 2, true, infer);
    if (sides.right || infer) strip(a, b, -half - 0.2, -half - 2, true, infer);
  }
  const footways = new RoadGrid(sidewalks, radius);
  for (const { a, b, half } of footways.segments) strip(a, b, -half, half, false, false);
  for (const segment of clearance) {
    const { a, b, half } = segment;
    roads.forCells([Math.min(a.x, b.x) - half, Math.min(a.z, b.z) - half,
      Math.max(a.x, b.x) + half, Math.max(a.z, b.z) + half], (key) => {
      if (!roads.cells.has(key)) roads.cells.set(key, []);
      roads.cells.get(key).push(segment);
    });
  }
  const group = new THREE.Group();
  if (surface.length) {
    const texture = terrain.mesh?.material.map || new THREE.CanvasTexture(imagery.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(surface, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide })));
  }
  if (lightPositions.length) {
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.055, 0.09, 4.5, 6),
      new THREE.MeshStandardMaterial({ color: '#555b60', roughness: 0.8 }), lightPositions.length);
    const bulb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshStandardMaterial({ color: '#ffe8ad', emissive: '#ad823a', emissiveIntensity: 0.4 }), lightPositions.length);
    const matrix = new THREE.Matrix4();
    lightPositions.forEach((p, i) => {
      const ground = terrain.heightAt(p.x, p.z);
      pole.setMatrixAt(i, matrix.makeTranslation(p.x, ground + 2.25, p.z));
      bulb.setMatrixAt(i, matrix.makeTranslation(p.x, ground + 4.55, p.z));
    });
    pole.computeBoundingSphere(); bulb.computeBoundingSphere();
    group.add(pole, bulb);
  }
  return { group, sidewalkSegments: clearance.length, lamps: lightPositions.length };
}
