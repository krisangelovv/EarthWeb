import * as THREE from 'three';

// OSM provides bridge outlines but normally no deck elevations. Interpolate between
// the ends and estimate a smooth crown above the terrain; this is not surveyed height.
export function buildBridges(bridges, terrain, radius) {
  const profiles = [], vertices = [];
  for (const bridge of bridges) {
    const points = bridge.points.filter((p, i, all) =>
      !i || Math.hypot(p.x - all[i - 1].x, p.z - all[i - 1].z) > 0.01);
    if (points.length < 2) continue;
    const distances = [0];
    for (let i = 1; i < points.length; i++)
      distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const length = distances[distances.length - 1];
    if (length < 2) continue;
    const xs = points.map((p) => p.x), zs = points.map((p) => p.z), limit = radius + bridge.width;
    if (Math.min(...xs) > limit || Math.max(...xs) < -limit ||
        Math.min(...zs) > limit || Math.max(...zs) < -limit) continue;
    const start = terrain.heightAt(points[0].x, points[0].z);
    const end = terrain.heightAt(points[points.length - 1].x, points[points.length - 1].z);
    const crown = Math.min(4.5, length * 0.06);
    const height = (d) => {
      const t = d / length;
      const ramp = Math.min(1, d / Math.min(30, length / 2), (length - d) / Math.min(30, length / 2));
      const smooth = ramp * ramp * (3 - 2 * ramp);
      return start + (end - start) * t + crown * smooth + 0.15;
    };
    const sample = (d) => {
      let i = 1;
      while (i < distances.length - 1 && distances[i] < d) i++;
      const a = points[i - 1], b = points[i], t = (d - distances[i - 1]) / (distances[i] - distances[i - 1]);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: height(d) };
    };
    const n = Math.max(1, Math.ceil(length / 2)), samples = [];
    for (let i = 0; i <= n; i++) samples.push(sample(length * i / n));
    const edges = samples.map((p, i) => {
      const a = samples[Math.max(0, i - 1)], b = samples[Math.min(n, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len * bridge.width / 2, nz = dx / len * bridge.width / 2;
      return [{ x: p.x - nx, y: p.y, z: p.z - nz }, { x: p.x + nx, y: p.y, z: p.z + nz }];
    });
    const vertex = (p) => vertices.push(p.x, p.y, p.z);
    for (let i = 1; i < edges.length; i++) {
      const [a, b] = edges[i - 1], [c, d] = edges[i];
      vertex(a); vertex(b); vertex(c); vertex(c); vertex(b); vertex(d);
      profiles.push({ a: samples[i - 1], b: samples[i], half: bridge.width / 2 });
    }
  }
  const group = new THREE.Group();
  if (vertices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: '#66696c', roughness: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return {
    group,
    heightAt(x, z, y, ground) {
      let result = ground;
      for (const { a, b, half } of profiles) {
        const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
        if (!length2) continue;
        const raw = ((x - a.x) * dx + (z - a.z) * dz) / length2;
        if (raw < 0 || raw > 1) continue;
        if (Math.hypot(x - a.x - raw * dx, z - a.z - raw * dz) > half) continue;
        const deck = a.y + (b.y - a.y) * raw;
        if (deck <= y + 0.6 && deck > result) result = deck;
      }
      return result;
    },
    count: bridges.length,
  };
}
