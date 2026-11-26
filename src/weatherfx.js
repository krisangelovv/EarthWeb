import * as THREE from 'three';

const BOX = 40; // particles live in a BOX x BOX x BOX cube that follows the camera

// Rain streaks and snowflakes driven by weather intensity and wind.
export class WeatherFX {
  constructor(scene) {
    this.rainN = 9000;
    this.snowN = 6000;
    this.rain = this._makeRain();
    this.snow = this._makeSnow();
    scene.add(this.rain.mesh, this.snow.mesh);
    this.t = 0;
  }

  _spawn(n) {
    const p = new Float32Array(n * 3);
    for (let i = 0; i < p.length; i++) p[i] = Math.random() * BOX - BOX / 2;
    return p;
  }

  _makeRain() {
    const pos = this._spawn(this.rainN);
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(this.rainN * 6), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#b8c6dd', transparent: true, opacity: 0.4, fog: false, depthWrite: false }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    return { mesh, pos, attr };
  }

  _makeSnow() {
    const pos = this._spawn(this.snowN);
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(this.snowN * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const mesh = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.16, map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false, opacity: 0.9 }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    return { mesh, pos, attr };
  }

  // brightness: 0 (night) .. 1 (day) so precipitation does not glow in the dark.
  update(dt, fx, camera, brightness) {
    this.t += dt;
    const cam = camera.position;
    const wrap = (v, c) => c + ((((v - c) % BOX) + BOX * 1.5) % BOX) - BOX / 2;
    const shade = 0.15 + 0.85 * brightness;

    const r = this.rain;
    r.mesh.visible = fx.rain > 0.01;
    if (r.mesh.visible) {
      const n = Math.round(this.rainN * fx.rain), vy = -16, vx = fx.wind.x * 0.6, vz = fx.wind.z * 0.6;
      r.mesh.geometry.setDrawRange(0, n * 2);
      r.mesh.material.color.setScalar(shade * 0.8);
      const a = r.attr.array;
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        r.pos[k] = wrap(r.pos[k] + vx * dt, cam.x);
        r.pos[k + 1] = wrap(r.pos[k + 1] + vy * dt, cam.y);
        r.pos[k + 2] = wrap(r.pos[k + 2] + vz * dt, cam.z);
        const o = i * 6;
        a[o] = r.pos[k]; a[o + 1] = r.pos[k + 1]; a[o + 2] = r.pos[k + 2];
        a[o + 3] = r.pos[k] - vx * 0.03; a[o + 4] = r.pos[k + 1] - vy * 0.03; a[o + 5] = r.pos[k + 2] - vz * 0.03;
      }
      r.attr.needsUpdate = true;
    }

    const s = this.snow;
    s.mesh.visible = fx.snow > 0.01;
    if (s.mesh.visible) {
      const n = Math.round(this.snowN * fx.snow);
      s.mesh.geometry.setDrawRange(0, n);
      s.mesh.material.color.setScalar(shade);
      const a = s.attr.array;
      for (let i = 0; i < n; i++) {
        const k = i * 3, sway = Math.sin(this.t * 1.3 + i) * 0.5;
        s.pos[k] = wrap(s.pos[k] + (fx.wind.x * 0.4 + sway) * dt, cam.x);
        s.pos[k + 1] = wrap(s.pos[k + 1] - 1.3 * dt, cam.y);
        s.pos[k + 2] = wrap(s.pos[k + 2] + (fx.wind.z * 0.4 + Math.cos(this.t + i) * 0.4) * dt, cam.z);
        a[k] = s.pos[k]; a[k + 1] = s.pos[k + 1]; a[k + 2] = s.pos[k + 2];
      }
      s.attr.needsUpdate = true;
    }
  }
}
