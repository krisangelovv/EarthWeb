import * as THREE from 'three';
import { inPolygon } from '../geo.js';

function pointSegmentDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const on = (p, q, r) => Math.abs(cross(p, q, r)) < 1e-8 &&
    r.x >= Math.min(p.x, q.x) - 1e-8 && r.x <= Math.max(p.x, q.x) + 1e-8 &&
    r.z >= Math.min(p.z, q.z) - 1e-8 && r.z <= Math.max(p.z, q.z) + 1e-8;
  const a1 = cross(a, b, c), a2 = cross(a, b, d), b1 = cross(c, d, a), b2 = cross(c, d, b);
  return ((a1 > 0 && a2 < 0 || a1 < 0 && a2 > 0) && (b1 > 0 && b2 < 0 || b1 < 0 && b2 > 0)) ||
    on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a.x, a.z, c, d), pointSegmentDistance(b.x, b.z, c, d),
    pointSegmentDistance(c.x, c.z, a, b), pointSegmentDistance(d.x, d.z, a, b));
}

// Clip to the loaded square, keeping a margin for the road width.
function clip(a, b, limit) {
  let lo = 0, hi = 1;
  for (const [p, q] of [[a.x, b.x - a.x], [a.z, b.z - a.z]]) {
    if (q === 0) {
      if (Math.abs(p) > limit) return null;
    } else {
      const t1 = (-limit - p) / q, t2 = (limit - p) / q;
      lo = Math.max(lo, Math.min(t1, t2));
      hi = Math.min(hi, Math.max(t1, t2));
    }
  }
  if (lo >= hi) return null;
  return [
    { x: a.x + (b.x - a.x) * lo, z: a.z + (b.z - a.z) * lo },
    { x: a.x + (b.x - a.x) * hi, z: a.z + (b.z - a.z) * hi },
  ];
}

// Estimate the carriageway only where buildings consistently line both sides.
function measuredWidth(road, buildings) {
  const reach = 25, samples = [], clearances = [];
  let total = 0;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i];
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const nx = -dz / length, nz = dx / length;
    const count = Math.floor(length / 6);
    for (let j = 0; j < count; j++) {
      const t = (j + 0.5) / count;
      const x = a.x + dx * t, z = a.z + dz * t;
      total++;
      const candidates = new Set();
      // PolygonGrid exposes its buckets so ray tests can reuse the existing index.
      for (let bx = Math.floor((x - reach) / buildings.cell); bx <= Math.floor((x + reach) / buildings.cell); bx++) {
        for (let bz = Math.floor((z - reach) / buildings.cell); bz <= Math.floor((z + reach) / buildings.cell); bz++) {
          for (const p of buildings.cells.get(`${bx},${bz}`) || []) candidates.add(p);
        }
      }
      let left = reach + 1, right = reach + 1;
      for (const poly of candidates) {
        if (inPolygon(x, z, poly)) continue;
        for (const ring of [poly.outer, ...poly.holes]) {
          for (let k = 0; k < ring.length; k++) {
            const p = ring[k], q = ring[(k + 1) % ring.length];
            const ex = q[0] - p[0], ez = q[1] - p[1];
            const den = nx * ez - nz * ex;
            if (Math.abs(den) < 1e-8) continue;
            const px = p[0] - x, pz = p[1] - z;
            const dist = (px * ez - pz * ex) / den;
            const u = (px * nz - pz * nx) / den;
            if (u < 0 || u > 1) continue;
            if (dist > 0 && dist <= reach) left = Math.min(left, dist);
            if (dist < 0 && -dist <= reach) right = Math.min(right, -dist);
          }
        }
      }
      if (left <= reach && right <= reach) {
        samples.push(left + right);
        clearances.push(2 * Math.min(left, right) - 0.6);
      }
    }
  }
  if (samples.length < 4 || samples.length < total * 0.6) return null;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const spread = samples[Math.floor(samples.length * 0.75)] - samples[Math.floor(samples.length * 0.25)];
  if (spread > median * 0.3) return null;
  clearances.sort((a, b) => a - b);
  const clearance = clearances[Math.floor(clearances.length * 0.25)];
  if (clearance < 3) return null;
  // Wall-to-wall space includes sidewalks; it is not itself asphalt width.
  return Math.max(3, Math.min(50, road.width * 1.5, clearance,
    median - 2 * Math.max(1.8, Math.min(4.5, median * 0.2))));
}

function hull(points) {
  points.sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const half = (list) => {
    const result = [];
    for (const p of list) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], p) <= 1e-8) result.pop();
      result.push(p);
    }
    return result;
  };
  const lower = half(points), upper = half(points.slice().reverse());
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export class RoadGrid {
  constructor(roads, radius, cell = 32) {
    this.cell = cell;
    this.cells = new Map();
    this.junctions = new Map();
    this.segments = [];
    for (const road of roads) {
      for (let i = 1; i < road.points.length; i++) {
        const ends = clip(road.points[i - 1], road.points[i], radius + road.width);
        if (!ends || Math.hypot(ends[1].x - ends[0].x, ends[1].z - ends[0].z) < 0.01) continue;
        const [a, b] = ends, half = road.width / 2;
        const segment = { a, b, half };
        this.segments.push(segment);
        this.forCells([Math.min(a.x, b.x) - half, Math.min(a.z, b.z) - half,
          Math.max(a.x, b.x) + half, Math.max(a.z, b.z) + half], (key) => {
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(segment);
        });
      }
    }
  }

  forCells(bbox, visit) {
    for (let x = Math.floor(bbox[0] / this.cell); x <= Math.floor(bbox[2] / this.cell); x++) {
      for (let z = Math.floor(bbox[1] / this.cell); z <= Math.floor(bbox[3] / this.cell); z++) visit(`${x},${z}`);
    }
  }

  candidates(bbox) {
    const result = new Set();
    this.forCells(bbox, (key) => {
      for (const segment of this.cells.get(key) || []) result.add(segment);
    });
    return result;
  }

  intersectsDisc(x, z, radius = 0) {
    for (const s of this.candidates([x - radius, z - radius, x + radius, z + radius])) {
      if (pointSegmentDistance(x, z, s.a, s.b) <= s.half + radius) return true;
    }
    let hit = false;
    this.forCells([x - radius, z - radius, x + radius, z + radius], (key) => {
      for (const poly of this.junctions.get(key) || []) {
        if (inPolygon(x, z, poly)) { hit = true; break; }
        for (let i = 0; i < poly.outer.length; i++) {
          const a = poly.outer[i], b = poly.outer[(i + 1) % poly.outer.length];
          if (pointSegmentDistance(x, z, { x: a[0], z: a[1] }, { x: b[0], z: b[1] }) <= radius) hit = true;
        }
      }
    });
    if (hit) return true;
    return false;
  }

  addJunction(outline) {
    const outer = outline.map((p) => [p.x, p.z]);
    const bbox = [Math.min(...outline.map((p) => p.x)), Math.min(...outline.map((p) => p.z)),
      Math.max(...outline.map((p) => p.x)), Math.max(...outline.map((p) => p.z))];
    const poly = { outer, holes: [], bbox };
    this.forCells(bbox, (key) => {
      if (!this.junctions.has(key)) this.junctions.set(key, []);
      this.junctions.get(key).push(poly);
    });
  }

  intersectsPolygon(poly) {
    for (const s of this.candidates(poly.bbox)) {
      if (inPolygon(s.a.x, s.a.z, poly) || inPolygon(s.b.x, s.b.z, poly)) return true;
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          if (segmentDistance(s.a, s.b, { x: p[0], z: p[1] }, { x: q[0], z: q[1] }) <= s.half) return true;
        }
      }
    }
    return false;
  }
}

function triangleIntersectsBuildings(a, b, c, grid) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const insideTriangle = (p) => {
    const values = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
    return values.every((v) => v >= -1e-8) || values.every((v) => v <= 1e-8);
  };
  const bbox = [Math.min(a.x, b.x, c.x), Math.min(a.z, b.z, c.z),
    Math.max(a.x, b.x, c.x), Math.max(a.z, b.z, c.z)];
  const candidates = new Set();
  for (let x = Math.floor(bbox[0] / grid.cell); x <= Math.floor(bbox[2] / grid.cell); x++) {
    for (let z = Math.floor(bbox[1] / grid.cell); z <= Math.floor(bbox[3] / grid.cell); z++) {
      for (const poly of grid.cells.get(`${x},${z}`) || []) candidates.add(poly);
    }
  }
  for (const poly of candidates) {
    if (poly.bbox[0] > bbox[2] || poly.bbox[2] < bbox[0] || poly.bbox[1] > bbox[3] || poly.bbox[3] < bbox[1]) continue;
    if ([a, b, c].some((p) => inPolygon(p.x, p.z, poly))) return true;
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const p = { x: ring[i][0], z: ring[i][1] };
        const q = { x: ring[(i + 1) % ring.length][0], z: ring[(i + 1) % ring.length][1] };
        if (insideTriangle(p) || segmentsIntersect(a, b, p, q) ||
            segmentsIntersect(b, c, p, q) || segmentsIntersect(c, a, p, q)) return true;
      }
    }
  }
  return false;
}

function asphaltTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(256, 256);
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const shade = 91 + Math.floor(rand() * 38);
    pixels.data[i] = shade;
    pixels.data[i + 1] = shade + 2;
    pixels.data[i + 2] = shade + 3;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  for (let i = 0; i < 9000; i++) {
    const shade = Math.floor(65 + rand() * 100);
    ctx.fillStyle = `rgba(${shade},${shade},${shade},0.55)`;
    const size = 0.5 + rand() * 2;
    ctx.fillRect(rand() * 256, rand() * 256, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// Keep mapped buildings and omit only the road triangles that intersect their footprints.
export function buildRoads(roads, terrain, radius, buildingFootprints) {
  const adjusted = roads.map((road) => {
    const width = road.estimatedWidth ? measuredWidth(road, buildingFootprints) : null;
    return width == null ? road : { ...road, width };
  });
  const grid = new RoadGrid(adjusted, radius);
  const vertices = [], uvs = [];
  function vertex(x, z) {
    vertices.push(x, terrain.heightAt(x, z) + 0.15, z);
    uvs.push(x / 4, z / 4);
  }
  function triangle(a, b, c) {
    const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(area) < 1e-8 || triangleIntersectsBuildings(a, b, c, buildingFootprints)) return;
    vertex(a.x, a.z); vertex(b.x, b.z); vertex(c.x, c.z);
  }
  const nodes = new Map();
  for (const segment of grid.segments) {
    for (const end of ['a', 'b']) {
      const p = segment[end], key = `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`;
      if (!nodes.has(key)) nodes.set(key, []);
      nodes.get(key).push({ segment, end });
    }
  }
  const trims = new Map();
  for (const branches of nodes.values()) {
    if (branches.length < 2) continue;
    const radius = Math.max(...branches.map(({ segment }) => segment.half));
    const boundary = [];
    for (const { segment, end } of branches) {
      const p = segment[end], q = segment[end === 'a' ? 'b' : 'a'];
      const length = Math.hypot(q.x - p.x, q.z - p.z);
      const ux = (q.x - p.x) / length, uz = (q.z - p.z) / length;
      const distance = Math.min(radius, length * 0.4);
      if (!trims.has(segment)) trims.set(segment, {});
      trims.get(segment)[end] = distance / length;
      boundary.push({ x: p.x + ux * distance - uz * segment.half, z: p.z + uz * distance + ux * segment.half });
      boundary.push({ x: p.x + ux * distance + uz * segment.half, z: p.z + uz * distance - ux * segment.half });
    }
    const outline = hull(boundary);
    if (outline.length < 3) continue;
    grid.addJunction(outline);
    const center = outline.reduce((p, q) => ({ x: p.x + q.x / outline.length, z: p.z + q.z / outline.length }), { x: 0, z: 0 });
    // Tessellate junctions like road strips so terrain and footprint clipping stay accurate.
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      const steps = Math.max(1, Math.ceil(Math.max(Math.hypot(a.x - center.x, a.z - center.z),
        Math.hypot(b.x - center.x, b.z - center.z), Math.hypot(a.x - b.x, a.z - b.z)) / 2));
      const point = (u, v) => ({ x: center.x + (a.x - center.x) * u / steps + (b.x - center.x) * v / steps,
        z: center.z + (a.z - center.z) * u / steps + (b.z - center.z) * v / steps });
      for (let u = 0; u < steps; u++) {
        for (let v = 0; v < steps - u; v++) {
          triangle(point(u, v), point(u + 1, v), point(u, v + 1));
          if (u + v < steps - 1) triangle(point(u + 1, v), point(u + 1, v + 1), point(u, v + 1));
        }
      }
    }
  }
  for (const segment of grid.segments) {
    const { a, b, half } = segment;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    const nx = -dz / length, nz = dx / length;
    const start = trims.get(segment)?.a || 0, end = 1 - (trims.get(segment)?.b || 0);
    const along = Math.max(1, Math.ceil(length * (end - start) / 2)), across = Math.ceil(half * 2 / 2);
    const point = (t, offset) => ({ x: a.x + dx * t + nx * offset, z: a.z + dz * t + nz * offset });
    for (let i = 0; i < along; i++) {
      for (let j = 0; j < across; j++) {
        const p = point(start + (end - start) * i / along, -half + j * 2 * half / across);
        const q = point(start + (end - start) * (i + 1) / along, -half + j * 2 * half / across);
        const r = point(start + (end - start) * i / along, -half + (j + 1) * 2 * half / across);
        const s = point(start + (end - start) * (i + 1) / along, -half + (j + 1) * 2 * half / across);
        triangle(p, r, q); triangle(q, r, s);
      }
    }
    // Concentric rings keep wide junction caps close to uneven terrain.
    for (const [endName, center] of [['a', a], ['b', b]]) {
      if (trims.get(segment)?.[endName]) continue;
      const rings = Math.ceil(half / 2), slices = Math.max(12, Math.ceil(Math.PI * half));
      const pointOnRing = (r, angle) => ({ x: center.x + Math.cos(angle) * r, z: center.z + Math.sin(angle) * r });
      for (let j = 0; j < rings; j++) {
        for (let i = 0; i < slices; i++) {
          const angle = 2 * Math.PI * i / slices, next = 2 * Math.PI * (i + 1) / slices;
          const outward = endName === 'a' ? -1 : 1;
          if ((Math.cos((angle + next) / 2) * dx + Math.sin((angle + next) / 2) * dz) * outward < 0) continue;
          const p = pointOnRing(half * j / rings, angle), q = pointOnRing(half * j / rings, next);
          const r = pointOnRing(half * (j + 1) / rings, angle), s = pointOnRing(half * (j + 1) / rings, next);
          triangle(p, q, r); triangle(q, s, r);
        }
      }
    }
  }
  const group = new THREE.Group();
  if (vertices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, grid, count: grid.segments.length };
}
