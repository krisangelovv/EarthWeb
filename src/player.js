import * as THREE from 'three';
import { CONFIG } from './config.js';

// First-person walker: pointer-lock mouse look, WASD, sprint, jump, fly mode, terrain following, building collision.
export class Player {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.pos = new THREE.Vector3(); // feet position in world space
    this.yaw = 0;
    this.pitch = 0;
    this.vy = 0;
    this.grounded = true;
    this.fly = false;
    this.keys = new Set();
    this.enabled = false;
    this.onLockChange = () => {};

    addEventListener('keydown', (e) => {
      if (!this.locked) return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.fly = !this.fly;
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.0022));
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.keys.clear();
      this.onLockChange(this.locked);
    });
  }

  get locked() { return document.pointerLockElement === this.dom; }
  lock() { this.dom.requestPointerLock?.(); }

  // Compass bearing in degrees (0 = north, clockwise).
  get bearing() { return (((-this.yaw * 180) / Math.PI) % 360 + 360) % 360; }

  update(dt, world) {
    const P = CONFIG.player, k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = this.fly ? P.fly * (sprint ? 3 : 1) : sprint ? P.sprint : P.walk;

    if (f || r) {
      const len = Math.hypot(f, r);
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const dx = ((-sin * f + cos * r) / len) * speed * dt, dz = ((-cos * f - sin * r) / len) * speed * dt;
      const nx = this.pos.x + dx, nz = this.pos.z + dz;
      if (this.fly || !world.blocked(nx, this.pos.z, P.radius)) this.pos.x = nx;
      if (this.fly || !world.blocked(this.pos.x, nz, P.radius)) this.pos.z = nz;
    }
    const lim = world.radius - 6;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));

    const ground = world.heightAt(this.pos.x, this.pos.z);
    if (this.fly) {
      this.pos.y += ((k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0)) * speed * dt;
      this.pos.y = Math.max(ground, this.pos.y);
      this.vy = 0;
    } else {
      if (this.grounded && k.has('Space')) { this.vy = P.jump; this.grounded = false; }
      this.vy -= P.gravity * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= ground) {
        this.pos.y = ground;
        this.vy = 0;
        this.grounded = true;
      } else if (this.grounded && this.pos.y - ground < 0.6 && this.vy <= 0) {
        this.pos.y = ground; // stay glued to the slope when walking downhill
      } else {
        this.grounded = false;
      }
    }

    this.camera.position.set(this.pos.x, this.pos.y + P.eyeHeight, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
