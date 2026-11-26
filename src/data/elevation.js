import { loadMosaic } from './tiles.js';

// Elevation from Terrarium tiles: metres = (R * 256 + G + B / 256) - 32768.
export async function loadElevation({ template, bbox, zoom, signal }) {
  const m = await loadMosaic({ template, bbox, zoom, signal, maxSize: 2048, fill: '#808000' });
  const { width: w, height: h } = m;
  const px = m.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const grid = new Float32Array(w * h);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  }
  return {
    width: w, height: h, zoom: m.zoom,
    // Bilinear sample of the DEM, in metres above sea level.
    sample(lat, lon) {
      const p = m.toPixel(lat, lon);
      const x = Math.min(w - 1.001, Math.max(0, p.x - 0.5));
      const y = Math.min(h - 1.001, Math.max(0, p.y - 0.5));
      const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
      const a = grid[j * w + i], b = grid[j * w + i + 1], c = grid[(j + 1) * w + i], d = grid[(j + 1) * w + i + 1];
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    },
  };
}
