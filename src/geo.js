// Geo helpers. World axes: +x = east, +y = up, -z = north.
export const DEG = Math.PI / 180;
const EARTH_R = 6378137;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Small deterministic PRNG so the same place always gets the same trees.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Flat-earth projection around an origin: accurate to centimetres over a few km.
export class LocalFrame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.mPerLat = EARTH_R * DEG;
    this.mPerLon = EARTH_R * DEG * Math.cos(lat0 * DEG);
  }
  toLocal(lat, lon) {
    return { x: (lon - this.lon0) * this.mPerLon, z: -(lat - this.lat0) * this.mPerLat };
  }
  toGeo(x, z) {
    return { lat: this.lat0 - z / this.mPerLat, lon: this.lon0 + x / this.mPerLon };
  }
}

export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / (EARTH_R * DEG);
  const dLon = dLat / Math.cos(lat * DEG);
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

// Web-mercator pixel coordinates (256px tiles) at a zoom level.
export function latLonToPixel(lat, lon, zoom) {
  const scale = 256 * 2 ** zoom;
  const s = Math.sin(clamp(lat, -85.05, 85.05) * DEG);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

// Rings are arrays of [x, z].
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBBox(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

export function inPolygon(x, z, poly) {
  const b = poly.bbox;
  if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) return false;
  if (!pointInRing(x, z, poly.outer)) return false;
  for (const h of poly.holes) if (pointInRing(x, z, h)) return false;
  return true;
}

// Uniform-grid spatial index of polygons: fast "is this point inside any polygon" queries.
export class PolygonGrid {
  constructor(cell = 32) {
    this.cell = cell;
    this.cells = new Map();
  }
  add(poly) {
    const c = this.cell, b = poly.bbox;
    for (let i = Math.floor(b[0] / c); i <= Math.floor(b[2] / c); i++) {
      for (let j = Math.floor(b[1] / c); j <= Math.floor(b[3] / c); j++) {
        const key = i + ',' + j;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(poly);
      }
    }
  }
  contains(x, z) {
    const list = this.cells.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell));
    if (!list) return false;
    for (const p of list) if (inPolygon(x, z, p)) return true;
    return false;
  }
  // True if a disc of radius r around (x, z) touches any polygon (approximated by 9 probe points).
  blocked(x, z, r) {
    if (this.contains(x, z)) return true;
    const d = r * 0.7071;
    return (
      this.contains(x + r, z) || this.contains(x - r, z) || this.contains(x, z + r) || this.contains(x, z - r) ||
      this.contains(x + d, z + d) || this.contains(x - d, z + d) || this.contains(x + d, z - d) || this.contains(x - d, z - d)
    );
  }
}

// Sun position from date + location (standard low-precision astronomical formulae).
// altitude: radians above horizon; azimuth: radians measured from south, positive towards west.
export function sunPosition(date, lat, lon) {
  const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
  const M = DEG * (357.5291 + 0.98560028 * d);
  const C = DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + DEG * 102.9372 + Math.PI;
  const e = DEG * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const phi = DEG * lat;
  const H = DEG * (280.16 + 360.9856235 * d) + DEG * lon - ra;
  return {
    azimuth: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
  };
}
