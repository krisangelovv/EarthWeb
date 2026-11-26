import { latLonToPixel } from '../geo.js';

function isEsriNoData(bitmap) {
  if (bitmap.width !== 256 || bitmap.height !== 256) return false;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, 256, 256).data;
  const matches = (x, y, min, max) => {
    const i = (y * 256 + x) * 4;
    return [data[i], data[i + 1], data[i + 2]].every((v) => v >= min && v <= max);
  };
  return [[0, 0], [255, 0], [0, 255], [255, 255], [128, 20], [90, 123]]
    .every(([x, y]) => matches(x, y, 201, 207)) &&
    [[70, 111], [80, 110], [128, 128]].every(([x, y]) => matches(x, y, 225, 255));
}

async function fetchBitmap(url, signal, rejectEsriNoData) {
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // 'none' keeps raw pixel values (required to decode elevation from colours).
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  if (rejectEsriNoData && isEsriNoData(bitmap)) {
    bitmap.close();
    throw new Error('Satellite tile contains Esri no-data placeholder');
  }
  return bitmap;
}

export const tileUrl = (template, z, x, y) =>
  template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// Downloads every slippy-map tile covering `bbox` and stitches them into one canvas.
// Lowers the zoom until the mosaic fits in maxSize pixels.
export async function loadMosaic({ template, bbox, zoom, maxSize = 4096, signal, fill = '#5b6b4a', concurrency = 8, requireComplete = false, rejectEsriNoData = false }) {
  let z = zoom, r;
  for (;; z--) {
    const a = latLonToPixel(bbox.north, bbox.west, z);
    const b = latLonToPixel(bbox.south, bbox.east, z);
    const max = 2 ** z - 1;
    r = {
      x0: Math.max(0, Math.floor(a.x / 256)), y0: Math.max(0, Math.floor(a.y / 256)),
      x1: Math.min(max, Math.floor(b.x / 256)), y1: Math.min(max, Math.floor(b.y / 256)),
    };
    if (((r.x1 - r.x0 + 1) * 256 <= maxSize && (r.y1 - r.y0 + 1) * 256 <= maxSize) || z <= 8) break;
  }

  const width = (r.x1 - r.x0 + 1) * 256, height = (r.y1 - r.y0 + 1) * 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, width, height);

  const jobs = [];
  for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) jobs.push([tx, ty]);
  let next = 0, ok = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      try {
        const bmp = await fetchBitmap(tileUrl(template, z, tx, ty), signal, rejectEsriNoData);
        ctx.drawImage(bmp, (tx - r.x0) * 256, (ty - r.y0) * 256, 256, 256);
        bmp.close?.();
        ok++;
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (!ok) throw new Error('No tiles could be loaded from ' + template);
  if (requireComplete && ok !== jobs.length) throw new Error(`${jobs.length - ok} of ${jobs.length} tiles failed from ${template}`);

  const ox = r.x0 * 256, oy = r.y0 * 256;
  return {
    canvas, width, height, zoom: z, tiles: jobs.length, loaded: ok,
    toPixel(lat, lon) {
      const p = latLonToPixel(lat, lon, z);
      return { x: p.x - ox, y: p.y - oy };
    },
  };
}
