import * as THREE from 'three';
import { inPolygon, mulberry32, PolygonGrid } from '../geo.js';

const AREA_RULES = {
  wood: { spacing: 6.5, h: [8, 17] },
  scrub: { spacing: 8, h: [1.5, 3.5] },
  park: { spacing: 15, h: [6, 12] },
};

// Trees come from three sources: tagged OSM trees, scattering inside forests/parks, and
// (optionally) dark-green blobs in the satellite imagery that no OSM data explains.
export function buildVegetation({ trees, areas, buildingGrid, roadGrid, terrain, imagery, frame, radius, maxTrees, inferFromImagery, grassFromImagery = false }) {
  const rand = mulberry32(1337);
  const list = [];
  const R = radius - 4;
  const inside = (x, z) => Math.abs(x) < R && Math.abs(z) < R;

  for (const t of trees) {
    const h = t.h ?? 5 + rand() * 5;
    if (inside(t.x, t.z) && !roadGrid.intersectsDisc(t.x, t.z, h * 0.32))
      list.push({ x: t.x, z: t.z, h, needle: t.needle });
  }

  let est = 0;
  for (const a of areas) {
    if (!AREA_RULES[a.kind]) continue;
    const s = AREA_RULES[a.kind].spacing;
    est += ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])) / (s * s);
  }
  const thin = Math.max(1, Math.sqrt(est / (maxTrees * 0.7)));

  for (const a of areas) {
    if (!AREA_RULES[a.kind]) continue;
    const rule = AREA_RULES[a.kind], s = rule.spacing * thin;
    const needleChance = a.leaf === 'needleleaved' ? 1 : a.leaf === 'mixed' ? 0.4 : a.leaf === 'broadleaved' ? 0 : 0.2;
    for (let x = a.bbox[0]; x < a.bbox[2]; x += s) {
      for (let z = a.bbox[1]; z < a.bbox[3]; z += s) {
        const px = x + (rand() - 0.5) * s * 0.85, pz = z + (rand() - 0.5) * s * 0.85;
        if (!inside(px, pz) || !inPolygon(px, pz, a) || buildingGrid.contains(px, pz)) continue;
        const h = rule.h[0] + rand() * (rule.h[1] - rule.h[0]);
        if (!roadGrid.intersectsDisc(px, pz, h * 0.32))
          list.push({ x: px, z: pz, h, needle: rand() < needleChance });
      }
    }
  }

  if (inferFromImagery && imagery) inferTrees(list, { areas, buildingGrid, roadGrid, imagery, frame, R, rand });

  // Too many? keep a random subset.
  if (list.length > maxTrees) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    list.length = maxTrees;
  }

  const group = instantiate(list, terrain, rand);
  const grass = buildGrass({ areas, buildingGrid, roadGrid, terrain, imagery, frame, R, rand, grassFromImagery });
  group.add(grass.group);
  return { group, count: list.length, grassCount: grass.count };
}

function buildGrass({ areas, buildingGrid, roadGrid, terrain, imagery, frame, R, rand, grassFromImagery }) {
  const group = new THREE.Group();
  const vegetation = new PolygonGrid(32);
  for (const area of areas) {
    const b = area.bbox;
    if (b[2] < -R || b[0] > R || b[3] < -R || b[1] > R) continue;
    vegetation.add({ ...area, bbox: [Math.max(-R, b[0]), Math.max(-R, b[1]), Math.min(R, b[2]), Math.min(R, b[3])] });
  }
  let pixels, width, height, scale;
  if (grassFromImagery && imagery) {
    scale = Math.min(1, 1024 / Math.max(imagery.width, imagery.height));
    width = Math.round(imagery.width * scale);
    height = Math.round(imagery.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imagery.canvas, 0, 0, width, height);
    pixels = ctx.getImageData(0, 0, width, height).data;
  }
  const greenAt = (x, z) => {
    if (!pixels) return false;
    const geo = frame.toGeo(x, z), p = imagery.toPixel(geo.lat, geo.lon);
    const ix = Math.floor(p.x * scale), iy = Math.floor(p.y * scale);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return false;
    const i = (iy * width + ix) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    return g > 55 && g > r * 1.08 && g > b * 1.12;
  };
  const maxGrass = 45000;
  const step = Math.max(3, 2 * R / Math.sqrt(maxGrass));
  const positions = [];
  for (let x = -R; x < R; x += step) {
    for (let z = -R; z < R; z += step) {
      const px = x + rand() * step, pz = z + rand() * step;
      if (px >= R || pz >= R || (!vegetation.contains(px, pz) && !greenAt(px, pz))) continue;
      if (roadGrid.intersectsDisc(px, pz, 1.1) || touchesBuilding(buildingGrid, px, pz, 1.1)) continue;
      positions.push([px, pz]);
    }
  }
  if (!positions.length) return { group, count: 0 };
  const vertices = [];
  for (let i = 0; i < 9; i++) {
    const angle = i * 2.4, distance = i === 0 ? 0 : 0.25 + (i % 3) * 0.13;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    const dx = Math.cos(angle + 1) * 0.22, dz = Math.sin(angle + 1) * 0.22;
    vertices.push(x - dx, 0, z - dz, x + dx, 0, z + dz, x, 0.35 + (i % 4) * 0.08, z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({
    color: '#789552', roughness: 1, side: THREE.DoubleSide,
  }), positions.length);
  const dummy = new THREE.Object3D(), color = new THREE.Color();
  positions.forEach(([x, z], i) => {
    dummy.position.set(x, terrain.heightAt(x, z), z);
    dummy.rotation.y = rand() * Math.PI * 2;
    const size = 0.8 + rand() * 0.4;
    dummy.scale.set(size, 0.65 + rand() * 0.7, size);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, color.setHSL(0.24 + rand() * 0.06, 0.35 + rand() * 0.15, 0.6 + rand() * 0.25));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return { group, count: positions.length };
}

function touchesBuilding(grid, x, z, radius) {
  const candidates = new Set();
  for (let cx = Math.floor((x - radius) / grid.cell); cx <= Math.floor((x + radius) / grid.cell); cx++) {
    for (let cz = Math.floor((z - radius) / grid.cell); cz <= Math.floor((z + radius) / grid.cell); cz++) {
      for (const poly of grid.cells.get(`${cx},${cz}`) || []) candidates.add(poly);
    }
  }
  for (const poly of candidates) {
    if (inPolygon(x, z, poly)) return true;
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
        const dx = bx - ax, dz = bz - az, length2 = dx * dx + dz * dz;
        const t = length2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
        if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= radius) return true;
      }
    }
  }
  return false;
}

// Dark, green-dominant pixels in the satellite image => canopy. Lawns are brighter, roofs/roads aren't green.
function inferTrees(list, { areas, buildingGrid, roadGrid, imagery, frame, R, rand }) {
  const scale = Math.min(1, 1024 / Math.max(imagery.width, imagery.height));
  const w = Math.round(imagery.width * scale), h = Math.round(imagery.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imagery.canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const step = 7;
  for (let x = -R; x < R; x += step) {
    for (let z = -R; z < R; z += step) {
      const sx = x + (rand() - 0.5) * step, sz = z + (rand() - 0.5) * step;
      const g = frame.toGeo(sx, sz);
      const p = imagery.toPixel(g.lat, g.lon);
      const ix = Math.floor(p.x * scale), iy = Math.floor(p.y * scale);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const o = (iy * w + ix) * 4, r = px[o], gr = px[o + 1], b = px[o + 2];
      if (!(gr > r * 1.08 && gr > b * 1.12 && gr < 135 && r + gr + b < 340)) continue;
      if (rand() > 0.75 || buildingGrid.contains(sx, sz)) continue;
      if (areas.some((a) => inPolygon(sx, sz, a))) continue;
      const height = 5 + rand() * 8;
      if (!roadGrid.intersectsDisc(sx, sz, height * 0.32))
        list.push({ x: sx, z: sz, h: height, needle: false });
    }
  }
}

function foliageTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d'), rand = mulberry32(714);
  ctx.fillStyle = '#b7b7b7';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 7000; i++) {
    const shade = Math.floor(100 + rand() * 150);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    ctx.beginPath();
    ctx.ellipse(rand() * 256, rand() * 256, 1 + rand() * 2.5, 0.7 + rand(), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function broadCrown(variant) {
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const wave = Math.sin(x * 5 + variant) * Math.cos(z * 5 - variant * 0.8) +
      Math.sin(y * 7 + z * 3 + variant * 1.7);
    const scale = 0.72 + 0.14 * wave;
    const taper = 0.85 + 0.15 * Math.sin(y * 2.5 + variant * 1.4);
    p.setXYZ(i, x * scale * taper, y * scale, z * scale * taper);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function coniferCrown(variant) {
  const points = [new THREE.Vector2(0, 0)];
  const tiers = 4 + variant % 2;
  for (let i = 0; i < tiers; i++) {
    const y = i / tiers, radius = (1 - y) * (0.9 - variant * 0.06);
    points.push(new THREE.Vector2(radius, y + 0.02));
    points.push(new THREE.Vector2(radius * 0.58, (i + 1) / tiers));
  }
  points.push(new THREE.Vector2(0, 1));
  return new THREE.LatheGeometry(points, 12);
}

function instantiate(list, terrain, rand) {
  const group = new THREE.Group(), dummy = new THREE.Object3D(), color = new THREE.Color();
  if (!list.length) return group;
  const buckets = Array.from({ length: 8 }, () => []);
  for (const tree of list) buckets[(tree.needle ? 4 : 0) + Math.floor(rand() * 4)].push(tree);
  const trunkGeo = new THREE.CylinderGeometry(0.75, 1.2, 1, 8).translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 1 }), list.length);
  const leafMaterial = new THREE.MeshStandardMaterial({ map: foliageTexture(), roughness: 1 });
  let ti = 0;
  buckets.forEach((items, variant) => {
    if (!items.length) return;
    const needle = variant >= 4;
    const mesh = new THREE.InstancedMesh(needle ? coniferCrown(variant - 4) : broadCrown(variant), leafMaterial, items.length);
    items.forEach((t, i) => {
      const y = terrain.heightAt(t.x, t.z) - 0.15;
      const th = t.h * (needle ? 0.3 : 0.42), tr = Math.min(0.35, Math.max(0.08, t.h * 0.02));
      const angle = rand() * Math.PI * 2;
      dummy.position.set(t.x, y, t.z);
      dummy.rotation.set(0, angle, 0);
      dummy.scale.set(tr, th, tr);
      dummy.updateMatrix();
      trunks.setMatrixAt(ti++, dummy.matrix);
      const radius = t.h * (needle ? 0.24 : 0.32) * (0.82 + rand() * 0.18);
      if (needle) {
        dummy.position.y = y + t.h * 0.2;
        dummy.scale.set(radius, t.h * 0.8, radius * (0.8 + rand() * 0.2));
      } else {
        const crownHeight = t.h * (0.27 + rand() * 0.17);
        dummy.position.y = y + t.h - crownHeight * 0.8;
        dummy.scale.set(radius, crownHeight, radius * (0.65 + rand() * 0.35));
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, needle
        ? color.setHSL(0.29 + rand() * 0.06, 0.4 + rand() * 0.14, 0.25 + rand() * 0.1)
        : color.setHSL(0.22 + rand() * 0.1, 0.4 + rand() * 0.2, 0.3 + rand() * 0.14));
    });
    mesh.castShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  });
  trunks.castShadow = true;
  trunks.instanceMatrix.needsUpdate = true;
  group.add(trunks);
  return group;
}
