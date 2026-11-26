import * as THREE from 'three';

// Heightfield mesh textured with the satellite mosaic. Heights are metres relative to the centre's elevation.
export function buildTerrain({ frame, elevation, imagery, radius, step, renderer, centerLat, centerLon }) {
  const N = Math.ceil((2 * radius) / step);
  const cell = (2 * radius) / N;
  const V = N + 1;
  const baseElev = elevation.sample(centerLat, centerLon);

  const heights = new Float32Array(V * V);
  const pos = new Float32Array(V * V * 3);
  const uv = new Float32Array(V * V * 2);
  const zoom = imagery.zoom;

  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const x = -radius + i * cell, z = -radius + j * cell;
      const g = frame.toGeo(x, z);
      const h = elevation.sample(g.lat, g.lon) - baseElev;
      const k = j * V + i;
      heights[k] = h;
      pos[k * 3] = x;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = z;
      const p = imagery.toPixel(g.lat, g.lon);
      uv[k * 2] = p.x / imagery.width;
      uv[k * 2 + 1] = 1 - p.y / imagery.height;
    }
  }

  const index = new Uint32Array(N * N * 6);
  let t = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      index.set([a, c, b, b, c, d], t);
      t += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const texture = new THREE.CanvasTexture(imagery.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: texture, color: new THREE.Color(1.25, 1.25, 1.25) }));
  mesh.receiveShadow = true;

  return {
    mesh, baseElev, zoom,
    // Ground height in metres (relative to baseElev) at local x, z — matches the rendered mesh.
    heightAt(x, z) {
      const gx = Math.min(N - 1e-6, Math.max(0, (x + radius) / cell));
      const gz = Math.min(N - 1e-6, Math.max(0, (z + radius) / cell));
      const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
      const a = heights[j * V + i], b = heights[j * V + i + 1], c = heights[(j + 1) * V + i], d = heights[(j + 1) * V + i + 1];
      return fx + fz <= 1
        ? a + (b - a) * fx + (c - a) * fz
        : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
    },
  };
}
