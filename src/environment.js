import * as THREE from 'three';
import { Sky } from 'three/addons/Sky.js';
import { clamp, lerp, smoothstep, mulberry32 } from './geo.js';

const C = (r, g, b) => new THREE.Color(r, g, b);
const FOG_DAY = C(0.62, 0.74, 0.9), FOG_GREY = C(0.58, 0.6, 0.64), FOG_DUSK = C(0.95, 0.58, 0.4), FOG_NIGHT = C(0.015, 0.02, 0.04);

// Sky, sun/moon light, fog, stars and window lighting, driven by the real sun position and the weather.
export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;

    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight('#fff4e0', 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -130;
    sc.right = sc.top = 130;
    sc.near = 1;
    sc.far = 700;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight('#bcd6ff', '#5a4d3f', 0.5);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(FOG_DAY.clone(), 50, 600);

    const rand = mulberry32(42), n = 1800, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      p.set([Math.cos(a) * s * 1800, Math.abs(u) * 1800, Math.sin(a) * s * 1800], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, fog: false, transparent: true, depthWrite: false, opacity: 0 }));
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    this.dayFactor = 1;
    this.shadowsEnabled = true;
    this.wallMaterial = null;
  }

  // sun: {altitude, azimuth(from south, westwards)}; fx: output of weatherToEffects.
  update(sun, fx, focus, camera) {
    const sinAlt = Math.sin(sun.altitude);
    const A = sun.azimuth + Math.PI; // bearing from north, clockwise
    const dir = new THREE.Vector3(Math.cos(sun.altitude) * Math.sin(A), sinAlt, -Math.cos(sun.altitude) * Math.cos(A));

    const day = smoothstep(-0.08, 0.12, sinAlt);
    const dusk = (1 - clamp(Math.abs(sinAlt) / 0.28, 0, 1)) * (1 - fx.cloud * 0.7);
    this.dayFactor = day;
    const night = 1 - day;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = 2 + fx.cloud * 14 * day;
    u.rayleigh.value = 1.6 - fx.cloud * 1.1 * day;
    u.mieCoefficient.value = 0.005 + fx.cloud * 0.03;
    u.mieDirectionalG.value = 0.8;
    this.sky.position.copy(camera.position);

    const fog = this.scene.fog;
    fog.color.copy(FOG_DAY).lerp(FOG_GREY, fx.cloud * 0.85).lerp(FOG_DUSK, dusk * 0.6).lerp(FOG_NIGHT, night);
    fog.far = fx.fogFar;
    fog.near = Math.min(40, fx.fogFar * 0.15);

    this.sun.visible = day > 0.01;
    this.sun.intensity = 4 * day * (1 - 0.8 * fx.cloud);
    this.sun.color.set('#fff4e0').lerp(new THREE.Color('#ff9a55'), dusk * 0.8);
    this.sun.castShadow = this.shadowsEnabled && this.sun.visible;
    this.sun.position.copy(focus).addScaledVector(dir, 300);
    this.sun.target.position.copy(focus);

    this.hemi.intensity = 0.3 + (1.2 + fx.cloud * 1.3) * day;
    this.hemi.color.set('#bcd6ff').lerp(new THREE.Color('#7b8cff'), night * 0.6);

    this.stars.material.opacity = night * night * (1 - fx.cloud);
    this.stars.position.copy(camera.position);

    if (this.wallMaterial) this.wallMaterial.emissiveIntensity = lerp(0, 0.8, smoothstep(0.35, 0.9, night + fx.cloud * 0.25 * night));
    return dir;
  }
}
