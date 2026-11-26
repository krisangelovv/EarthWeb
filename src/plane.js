import * as THREE from 'three';
import { CONFIG } from './config.js';
import { findOpenSpawn } from './player.js';

const SEAT_HEIGHT = 0.3;

export class Plane {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    const paint = new THREE.MeshStandardMaterial({ color: '#e9e9dc', roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: '#d34c37', roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: '#303a45', roughness: 0.8 });
    const part = (size, position, material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      this.group.add(mesh);
      return mesh;
    };
    part([1.8, 0.65, 5.2], [0, 0.95, 0], paint);
    part([10, 0.18, 1.5], [0, 1.15, 0], paint);
    part([3.5, 0.14, 1.05], [0, 1.15, 2.25], accent);
    part([0.14, 1.2, 1.05], [0, 1.65, 2.25], accent);
    part([1.5, 0.45, 0.12], [0, 1.55, -1.2], dark);
    part([0.6, 0.55, 0.45], [-0.45, 1.5, 0.25], dark);
    part([0.6, 0.55, 0.45], [0.45, 1.5, 0.25], dark);
    part([0.22, 0.55, 0.4], [-0.7, 0.3, -1.2], dark);
    part([0.22, 0.55, 0.4], [0.7, 0.3, -1.2], dark);
    part([0.22, 0.5, 0.4], [0, 0.3, 2], dark);
    this.propeller = part([0.12, 1.9, 0.1], [0, 1.05, -2.72], dark);
    this.owner = false;
    this.seat = null;
    this.passenger = false;
    this.speed = 0;
  }

  spawn(world, player) {
    if (this.group.visible) return 'A plane is already present.';
    const x = player.pos.x - Math.sin(player.yaw) * 7;
    const z = player.pos.z - Math.cos(player.yaw) * 7;
    const location = findOpenSpawn(world, x, z, 5);
    if (!location) return 'No open space nearby for a plane.';
    this.group.position.set(location.x, world.heightAt(location.x, location.z), location.z);
    this.group.rotation.y = player.yaw;
    this.group.visible = true;
    this.owner = true;
    this.seat = null;
    this.passenger = false;
    this.speed = 0;
    return null;
  }

  distanceTo(player) {
    return this.group.position.distanceTo(player.pos);
  }

  boardPilot(player) {
    if (!this.owner || !this.group.visible || this.distanceTo(player) > 8) return false;
    this.seat = 'pilot';
    player.fly = false;
    this.placePlayer(player);
    return true;
  }

  placePlayer(player) {
    const offset = new THREE.Vector3(this.seat === 'pilot' ? -0.45 : 0.45, SEAT_HEIGHT, 0);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.group.rotation.y);
    player.pos.copy(this.group.position).add(offset);
    player.vy = 0;
    player.grounded = false;
    player.camera.position.set(player.pos.x, player.pos.y + CONFIG.player.eyeHeight, player.pos.z);
    player.camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  }

  exit(world, player) {
    if (this.speed > 2 || this.group.position.y - world.heightAt(this.group.position.x, this.group.position.z) > 1)
      return 'Land and stop before leaving the plane.';
    if (this.seat === 'pilot' && this.passenger) return 'Your passenger must exit first.';
    const offset = new THREE.Vector3(this.seat === 'pilot' ? -4 : 4, 0, 0)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.group.rotation.y);
    const spot = findOpenSpawn(world, this.group.position.x + offset.x, this.group.position.z + offset.z);
    if (!spot) return 'No safe place to exit nearby.';
    this.seat = null;
    player.pos.set(spot.x, world.heightAt(spot.x, spot.z), spot.z);
    player.vy = 0;
    player.grounded = true;
    return null;
  }

  update(dt, world, player) {
    if (!this.group.visible) return;
    if (this.owner && this.seat === 'pilot') {
      const keys = player.keys;
      const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      this.speed = THREE.MathUtils.clamp(this.speed + throttle * 12 * dt, 0, 22);
      const turn = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
      const yawChange = turn * Math.min(this.speed / 8, 1) * 0.65 * dt;
      this.group.rotation.y += yawChange;
      player.yaw += yawChange;
      this.group.position.x -= Math.sin(this.group.rotation.y) * this.speed * dt;
      this.group.position.z -= Math.cos(this.group.rotation.y) * this.speed * dt;
      const ground = world.heightAt(this.group.position.x, this.group.position.z);
      const climb = (keys.has('Space') ? 1 : 0) - (keys.has('KeyC') ? 1 : 0);
      if (this.speed >= 8) this.group.position.y += climb * 10 * dt;
      this.group.position.y = Math.max(ground, this.group.position.y);
      this.propeller.rotation.z += (5 + this.speed) * dt;
    }
    if (this.seat) this.placePlayer(player);
  }

  snapshot(world) {
    if (!this.owner || !this.group.visible) return null;
    return { ...world.frame.toGeo(this.group.position.x, this.group.position.z),
      altitude: this.group.position.y + world.terrain.baseElev, yaw: this.group.rotation.y,
      speed: this.speed, passenger: this.passenger };
  }

  applyRemote(data, world, player) {
    const point = world.frame.toLocal(data.lat, data.lon);
    if (this.seat === 'passenger') player.yaw += data.yaw - this.group.rotation.y;
    this.owner = false;
    this.group.visible = true;
    this.group.position.set(point.x, data.altitude - world.terrain.baseElev, point.z);
    this.group.rotation.y = data.yaw;
    this.speed = data.speed;
    this.passenger = data.passenger;
  }

  reframe(oldWorld, world) {
    if (!this.group.visible) return;
    const geo = oldWorld.frame.toGeo(this.group.position.x, this.group.position.z);
    const point = world.frame.toLocal(geo.lat, geo.lon);
    this.group.position.set(point.x, this.group.position.y + oldWorld.terrain.baseElev - world.terrain.baseElev, point.z);
  }

  remove() {
    this.group.visible = false;
    this.owner = false;
    this.seat = null;
    this.passenger = false;
    this.speed = 0;
  }
}
