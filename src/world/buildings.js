import * as THREE from 'three';
import { PolygonGrid, inPolygon, pointInRing, signedArea } from '../geo.js';

const FACADES = ['#d9d2c5', '#c9c2b4', '#e2d8c3', '#b9b2a6', '#d8c9b0', '#c7b8a3', '#e8e4da', '#bfc4c7', '#cdb9a0', '#aeb6b3'];
const ROOFS = ['#6b6f73', '#8a8d90', '#7a4a3a', '#5d5d5d', '#9b5a42', '#74777a'];
const FLAT_BUILDING_TYPES = new Set(['apartments', 'dormitory', 'industrial', 'warehouse', 'commercial', 'office',
  'retail', 'hospital', 'school', 'university', 'public', 'civic']);

// One tile = 4 floors x 4 window columns (12.8 m wide, 12 m tall); a second texture marks the windows lit at night.
const TILE_W = 12.8, TILE_H = 12;
function makeFacadeTextures() {
  const S = 256, C = 64;
  const wall = document.createElement('canvas'), lit = document.createElement('canvas');
  wall.width = wall.height = lit.width = lit.height = S;
  const w = wall.getContext('2d'), l = lit.getContext('2d');
  w.fillStyle = '#fff';
  w.fillRect(0, 0, S, S);
  l.fillStyle = '#000';
  l.fillRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * C + 14, y = r * C + 12;
      w.fillStyle = '#e6e6e6';
      w.fillRect(x - 3, y - 3, 42, 46);
      const g = w.createLinearGradient(x, y, x, y + 40);
      g.addColorStop(0, '#a9bccf');
      g.addColorStop(1, '#5c7288');
      w.fillStyle = g;
      w.fillRect(x, y, 36, 40);
      if (rnd() < 0.4) {
        l.fillStyle = rnd() < 0.5 ? '#ffd28a' : '#fff1c9';
        l.fillRect(x, y, 36, 40);
      }
    }
  }
  const make = (cv) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: make(wall), emissiveMap: make(lit) };
}

class MeshData {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; }
  vertex(x, y, z, nx, ny, nz, u, v, c) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// Orient a ring so that walls built with normal (-dz, 0, dx) face outwards (outer: area < 0, holes: area > 0).
const orient = (ring, wantNegative) => ((signedArea(ring) < 0) === wantNegative ? ring : ring.slice().reverse());

function paletteColor(list, id, fallback) {
  const c = new THREE.Color();
  if (fallback) {
    try { c.set(fallback); return c; } catch { /* fall through to palette */ }
  }
  return c.set(list[Math.abs(id) % list.length]);
}

function roofSampler({ imagery, frame }) {
  const scale = Math.min(1, 2048 / Math.max(imagery.width, imagery.height));
  const width = Math.max(1, Math.round(imagery.width * scale));
  const height = Math.max(1, Math.round(imagery.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imagery.canvas, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  return (building) => {
    const [x0, z0, x1, z1] = building.bbox;
    const channels = [[], [], []], seen = new Set();
    let vegetation = 0;
    const inset = Math.min(0.5, (x1 - x0) * 0.08, (z1 - z0) * 0.08);
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 9; j++) {
        const x = x0 + (x1 - x0) * (i + 0.5) / 9;
        const z = z0 + (z1 - z0) * (j + 0.5) / 9;
        if (!inPolygon(x, z, building)) continue;
        const nearEdge = [building.outer, ...building.holes].some((ring) => ring.some((a, k) => {
          const b = ring[(k + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1];
          const length2 = dx * dx + dz * dz;
          const t = length2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length2)) : 0;
          return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < inset;
        }));
        if (nearEdge) continue;
        const geo = frame.toGeo(x, z), p = imagery.toPixel(geo.lat, geo.lon);
        const px = Math.floor(p.x * width / imagery.width), py = Math.floor(p.y * height / imagery.height);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const index = py * width + px;
        if (seen.has(index) || pixels[index * 4 + 3] < 255) continue;
        seen.add(index);
        const [r, g, b] = [pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]];
        if (g >= 38 && g - r >= 6 && 2 * g - r - b >= 20) { vegetation++; continue; }
        if (r + g + b < 60) continue;
        for (let c = 0; c < 3; c++) channels[c].push(pixels[index * 4 + c]);
      }
    }
    if (channels[0].length < 4 || vegetation * 2 > seen.size) return null;
    const median = channels.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] / 255);
    return new THREE.Color().setRGB(...median, THREE.SRGBColorSpace);
  };
}

function roofPlan(b, outer) {
  const widths = [b.bbox[2] - b.bbox[0], b.bbox[3] - b.bbox[1]];
  let shape = b.roofShape || (b.height <= 11 && Math.max(...widths) <= 35 && b.area <= 550 &&
    !FLAT_BUILDING_TYPES.has(b.kind) ? 'pyramidal' : 'flat');
  if (shape === 'flat') return { shape };
  if (!['pyramidal', 'gabled', 'hipped', 'skillion', 'dome'].includes(shape) || b.holes.length || outer.length < 3)
    return { shape: 'flat', unsupported: true };
  let sign = 0, convex = true;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], c = outer[(i + 1) % outer.length], d = outer[(i + 2) % outer.length];
    const cross = (c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0]);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign && Math.sign(cross) !== sign) convex = false;
    sign = Math.sign(cross);
  }
  if (!sign) return { shape: 'flat', unsupported: true };
  if (!convex && shape === 'pyramidal' && !b.roofShape) shape = 'gabled';
  if (!convex && (shape === 'pyramidal' || shape === 'dome')) return { shape: 'flat', unsupported: true };
  let rectangular = outer.length === 4 && convex;
  if (rectangular && (shape === 'gabled' || shape === 'hipped' || shape === 'skillion')) {
    for (let i = 0; i < 4; i++) {
      const a = outer[i], c = outer[(i + 1) % 4], d = outer[(i + 2) % 4];
      const x = c[0] - a[0], z = c[1] - a[1], nx = d[0] - c[0], nz = d[1] - c[1];
      if (Math.abs(x * nx + z * nz) > 0.2 * Math.hypot(x, z) * Math.hypot(nx, nz))
        rectangular = false;
    }
  }
  const available = b.height - Math.max(0, b.minHeight) - 0.5;
  if (available <= 0) return { shape: 'flat', unsupported: true };
  const estimatedHeight = Math.max(0.8, Math.min(4, Math.min(...widths) * 0.27));
  return { shape, height: Math.min(available, b.roofHeight || estimatedHeight),
    complex: !rectangular && ['gabled', 'hipped', 'skillion'].includes(shape) };
}

function roofDirection(b) {
  const directions = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  const direction = b.roofDirection;
  const degrees = direction && Object.prototype.hasOwnProperty.call(directions, direction) ? directions[direction] :
    direction && /^\d+(\.\d+)?$/.test(direction) ? Number(direction) : null;
  return degrees != null && degrees <= 360 ? degrees : null;
}

function ridgeEdge(outer, b) {
  const lengths = outer.map((p, i) => {
    const q = outer[(i + 1) % 4];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  let edge = lengths.indexOf(Math.max(...lengths));
  if (b.roofOrientation === 'across') edge = (edge + 1) % 4;
  const degrees = roofDirection(b);
  if (degrees != null) {
    const angle = degrees * Math.PI / 180, dx = Math.sin(angle), dz = -Math.cos(angle);
    const dot = (i) => {
      const p = outer[i], q = outer[(i + 1) % 4];
      return Math.abs(((q[0] - p[0]) * dx + (q[1] - p[1]) * dz) / lengths[i]);
    };
    edge = dot(0) <= dot(1) ? 0 : 1;
  }
  return edge;
}

// A piecewise planar heightfield clips each footprint triangle at roof-plane boundaries.
function complexRoof(outer, b, plan, top) {
  let edge = 0, longest = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], q = outer[(i + 1) % outer.length], length = Math.hypot(q[0] - a[0], q[1] - a[1]);
    if (length > longest) { longest = length; edge = i; }
  }
  if (!longest) return null;
  const a = outer[edge], q = outer[(edge + 1) % outer.length];
  let ux = (q[0] - a[0]) / longest, uz = (q[1] - a[1]) / longest;
  if (b.roofOrientation === 'across') [ux, uz] = [-uz, ux];
  const direction = roofDirection(b);
  if (direction != null) {
    const angle = direction * Math.PI / 180;
    ux = -Math.cos(angle); uz = -Math.sin(angle);
  }
  const vx = -uz, vz = ux;
  const u = outer.map((p) => p[0] * ux + p[1] * uz);
  const v = outer.map((p) => p[0] * vx + p[1] * vz);
  const u0 = Math.min(...u), u1 = Math.max(...u), v0 = Math.min(...v), v1 = Math.max(...v);
  if (u1 - u0 < 1e-6 || v1 - v0 < 1e-6) return null;
  const plane = (axisX, axisZ, intercept, slope) => (p) => intercept + slope * (p[0] * axisX + p[1] * axisZ);
  const dv = plan.height * 2 / (v1 - v0);
  let planes;
  if (plan.shape === 'skillion') {
    const slope = plan.height / (v1 - v0);
    // Positive roof:direction points towards the low side.
    planes = [plane(vx, vz, top + slope * v0, -slope)];
  } else {
    planes = [plane(vx, vz, top + dv * (v0 + v1) / 2, -dv),
      plane(vx, vz, top - dv * (v0 + v1) / 2, dv)];
    if (plan.shape === 'hipped') {
      const du = plan.height * 2 / (u1 - u0);
      planes.push(plane(ux, uz, top + du * (u0 + u1) / 2, -du),
        plane(ux, uz, top - du * (u0 + u1) / 2, du));
    }
  }
  const height = (p) => Math.min(...planes.map((f) => f(p)));
  const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!faces.length) return null;
  const triangles = [];
  for (const face of faces) {
    const points = face.map((i) => [contour[i].x, contour[i].y]);
    for (let i = 0; i < planes.length; i++) {
      let poly = points;
      for (let j = 0; j < planes.length && poly.length; j++) {
        if (i === j) continue;
        const clipped = [];
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k], n = poly[(k + 1) % poly.length];
          const d = planes[i](p) - planes[j](p), e = planes[i](n) - planes[j](n);
          if (d <= 1e-8) clipped.push(p);
          if ((d < -1e-8 && e > 1e-8) || (d > 1e-8 && e < -1e-8)) {
            const t = d / (d - e);
            clipped.push([p[0] + (n[0] - p[0]) * t, p[1] + (n[1] - p[1]) * t]);
          }
        }
        poly = clipped;
      }
      for (let k = 1; k + 1 < poly.length; k++) triangles.push([poly[0], poly[k], poly[k + 1]]);
    }
  }
  if (!triangles.length || !triangles.some((face) => face.some((p) => height(p) >= top - 1e-6))) return null;
  const wall = [];
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i], n = outer[(i + 1) % outer.length], cuts = [0];
    for (let j = 0; j < planes.length; j++) for (let k = j + 1; k < planes.length; k++) {
      const d = planes[j](p) - planes[k](p), e = planes[j](n) - planes[k](n);
      if (d * e < -1e-12) cuts.push(d / (d - e));
    }
    cuts.sort((x, y) => x - y);
    for (let j = 0; j < cuts.length; j++) {
      const t = cuts[j];
      if (j && Math.abs(t - cuts[j - 1]) < 1e-7) continue;
      wall.push([p[0] + (n[0] - p[0]) * t, p[1] + (n[1] - p[1]) * t]);
    }
  }
  return { wall, height, triangles };
}

// Extrudes footprints into merged walls and roofs and returns collision grids.
export function buildBuildings(list, terrain, roofImagery = null) {
  const parts = list.filter((b) => b.isPart);
  const covered = new Map(); // outline -> area covered by building:parts
  if (parts.length) {
    const outlines = list.filter((b) => !b.isPart);
    for (const p of parts) {
      for (const o of outlines) {
        if (p.cx < o.bbox[0] || p.cx > o.bbox[2] || p.cz < o.bbox[1] || p.cz > o.bbox[3]) continue;
        if (pointInRing(p.cx, p.cz, o.outer)) covered.set(o, (covered.get(o) || 0) + p.area);
      }
    }
  }
  const items = list.filter((b) => b.isPart || (covered.get(b) || 0) < b.area * 0.4);

  const walls = new MeshData(), roofs = new MeshData();
  const grid = new PolygonGrid(32);
  const footprints = new PolygonGrid(32);
  const sampleRoof = roofImagery && items.some((b) => !b.roofColor) ? roofSampler(roofImagery) : null;

  let unsupportedRoofs = 0;
  for (const b of items) {
    let outer = orient(b.outer, true);
    const holes = b.holes.map((h) => orient(h, false));

    let ground = Infinity;
    for (const [x, z] of outer) ground = Math.min(ground, terrain.heightAt(x, z));
    const top = ground + b.height;
    const bottom = b.minHeight > 0 ? ground + b.minHeight : ground - 2;
    if (top - bottom < 0.5) continue;
    let plan = roofPlan(b, outer);
    let complex = plan.complex ? complexRoof(outer, b, plan, top) : null;
    if (plan.complex && !complex) plan = { shape: 'flat', unsupported: true };
    if (plan.unsupported && b.roofShape) unsupportedRoofs++;
    const eave = top - (plan.height || 0);
    let wallTops = outer.map(() => eave);
    if (complex) {
      outer = complex.wall;
      wallTops = outer.map(complex.height);
    }
    if (plan.shape === 'skillion' && !complex) {
      const direction = roofDirection(b);
      const edge = ridgeEdge(outer, b);
      const p = outer[edge], q = outer[(edge + 1) % 4];
      const dx = direction == null ? -(q[1] - p[1]) : Math.sin(direction * Math.PI / 180);
      const dz = direction == null ? q[0] - p[0] : -Math.cos(direction * Math.PI / 180);
      const distances = outer.map(([x, z]) => x * dx + z * dz);
      const min = Math.min(...distances), range = Math.max(...distances) - min;
      wallTops = distances.map((d) => top - plan.height * (d - min) / range);
    }

    const wallColor = paletteColor(FACADES, b.id, b.color);
    const roofColor = b.roofColor ? paletteColor(ROOFS, b.id, b.roofColor) :
      (sampleRoof?.(b) || paletteColor(ROOFS, b.id, null));
    const v0 = (bottom - ground) / TILE_H, v1 = (eave - ground) / TILE_H;

    for (const ring of [outer, ...holes]) {
      let run = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
        const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        const nx = -dz / len, nz = dx / len;
        const u0 = run / TILE_W, u1 = (run + len) / TILE_W;
        run += len;
        walls.vertex(x0, bottom, z0, nx, 0, nz, u0, v0, wallColor);
        walls.vertex(x1, bottom, z1, nx, 0, nz, u1, v0, wallColor);
        const top0 = ring === outer ? wallTops[i] : eave;
        const top1 = ring === outer ? wallTops[(i + 1) % ring.length] : eave;
        const vt0 = (top0 - ground) / TILE_H, vt1 = (top1 - ground) / TILE_H;
        walls.vertex(x1, top1, z1, nx, 0, nz, u1, vt1, wallColor);
        walls.vertex(x0, bottom, z0, nx, 0, nz, u0, v0, wallColor);
        walls.vertex(x1, top1, z1, nx, 0, nz, u1, vt1, wallColor);
        walls.vertex(x0, top0, z0, nx, 0, nz, u0, vt0, wallColor);
      }
    }

    try {
      const triangle = (a, b2, c) => {
        let normal = new THREE.Vector3().subVectors(b2, a).cross(new THREE.Vector3().subVectors(c, a));
        if (normal.lengthSq() < 1e-10) return;
        if (normal.y < 0) {
          [b2, c] = [c, b2];
          normal.negate();
        }
        normal.normalize();
        for (const P of [a, b2, c])
          roofs.vertex(P.x, P.y, P.z, normal.x, normal.y, normal.z, 0, 0, roofColor);
      };
      const at = (p, y) => new THREE.Vector3(p[0], y, p[1]);
      if (plan.shape === 'flat') {
        const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
        const holeV = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
        const faces = THREE.ShapeUtils.triangulateShape(contour, holeV);
        const pts = contour.concat(...holeV);
        for (const [a, b2, c] of faces)
          triangle(at([pts[a].x, pts[a].y], top), at([pts[b2].x, pts[b2].y], top), at([pts[c].x, pts[c].y], top));
      } else if (complex) {
        for (const face of complex.triangles)
          triangle(...face.map((p) => at(p, complex.height(p))));
      } else if (plan.shape === 'pyramidal' || plan.shape === 'dome') {
        const center = outer.reduce((sum, p) => [sum[0] + p[0] / outer.length, sum[1] + p[1] / outer.length], [0, 0]);
        const apex = at(center, top);
        if (plan.shape === 'pyramidal') {
          for (let i = 0; i < outer.length; i++)
            triangle(at(outer[i], eave), at(outer[(i + 1) % outer.length], eave), apex);
        } else {
          let previous = outer.map((p) => at(p, eave));
          for (let ring = 1; ring <= 4; ring++) {
            const radius = Math.cos(ring * Math.PI / 10);
            const height = eave + plan.height * Math.sin(ring * Math.PI / 10);
            const next = outer.map((p) => at([center[0] + (p[0] - center[0]) * radius,
              center[1] + (p[1] - center[1]) * radius], height));
            for (let i = 0; i < outer.length; i++) {
              const j = (i + 1) % outer.length;
              triangle(previous[i], previous[j], next[j]); triangle(previous[i], next[j], next[i]);
            }
            previous = next;
          }
          for (let i = 0; i < outer.length; i++) triangle(previous[i], previous[(i + 1) % outer.length], apex);
        }
      } else if (plan.shape === 'skillion') {
        const p = outer.map((point, i) => at(point, wallTops[i]));
        triangle(p[0], p[1], p[2]); triangle(p[0], p[2], p[3]);
      } else {
        const edge = ridgeEdge(outer, b);
        const p = Array.from({ length: 4 }, (_, i) => outer[(edge + i) % 4]);
        const mid = (a, c) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        const m0 = mid(p[0], p[3]), m1 = mid(p[1], p[2]);
        let r0 = at(m0, top), r1 = at(m1, top);
        if (plan.shape === 'hipped') {
          const length = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]);
          const width = Math.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1]);
          const t = Math.min(0.5, width / (2 * length));
          r0 = at([m0[0] + (m1[0] - m0[0]) * t, m0[1] + (m1[1] - m0[1]) * t], top);
          r1 = at([m1[0] + (m0[0] - m1[0]) * t, m1[1] + (m0[1] - m1[1]) * t], top);
        }
        const v = p.map((point) => at(point, eave));
        triangle(v[0], v[1], r1); triangle(v[0], r1, r0);
        triangle(v[2], v[3], r0); triangle(v[2], r0, r1);
        if (plan.shape === 'hipped') {
          triangle(v[1], v[2], r1); triangle(v[3], v[0], r0);
        } else {
          for (const [i, j, apex] of [[1, 2, r1], [3, 0, r0]]) {
            const dx = p[j][0] - p[i][0], dz = p[j][1] - p[i][1], len = Math.hypot(dx, dz);
            const nx = -dz / len, nz = dx / len;
            walls.vertex(p[i][0], eave, p[i][1], nx, 0, nz, 0, v1, wallColor);
            walls.vertex(p[j][0], eave, p[j][1], nx, 0, nz, len / TILE_W, v1, wallColor);
            walls.vertex(apex.x, top, apex.z, nx, 0, nz, len / (2 * TILE_W), (top - ground) / TILE_H, wallColor);
          }
        }
      }
    } catch (error) {
      console.warn(`Could not render roof for building ${b.id}.`, error);
    }

    const footprint = { outer: b.outer, holes: b.holes, bbox: b.bbox };
    footprints.add(footprint);
    if (b.minHeight < 2) grid.add(footprint);
  }
  if (unsupportedRoofs) console.warn(`${unsupportedRoofs} mapped roof shapes could not be rendered and were kept flat.`);

  const tex = makeFacadeTextures();
  const wallMat = new THREE.MeshStandardMaterial({
    map: tex.map, emissiveMap: tex.emissiveMap, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0,
    vertexColors: true, roughness: 0.92, metalness: 0,
  });
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });

  const group = new THREE.Group();
  for (const [data, mat] of [[walls, wallMat], [roofs, roofMat]]) {
    if (!data.pos.length) continue;
    const mesh = new THREE.Mesh(data.toGeometry(), mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, grid, footprints, wallMaterial: wallMat, count: items.length };
}
