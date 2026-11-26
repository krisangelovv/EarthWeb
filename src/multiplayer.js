import * as THREE from 'three';
import { PELLET_SPEED } from './airsoft.js';

const PREFIX = 'earthweb-';
const CODE = /^[a-f0-9]{24}$/;
const ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

function validPosition(p) {
  return p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 &&
    Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
    Number.isFinite(p.height) && p.height >= 0 && p.height < 10000 &&
    Number.isFinite(p.yaw) && Math.abs(p.yaw) < 100000 &&
    (p.pitch === undefined || Number.isFinite(p.pitch) && Math.abs(p.pitch) <= 1.5) &&
    (p.moving === undefined || typeof p.moving === 'boolean') &&
    (p.altitude === undefined || Number.isFinite(p.altitude) && Math.abs(p.altitude) <= 20000) &&
    (p.seat === undefined || p.seat === null || p.seat === 'pilot' || p.seat === 'passenger') &&
    (p.plane === undefined || p.plane === null || validPlane(p.plane));
}

function validPlane(p) {
  return p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 &&
    Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
    Number.isFinite(p.altitude) && Math.abs(p.altitude) <= 20000 &&
    Number.isFinite(p.yaw) && Math.abs(p.yaw) < 100000 &&
    Number.isFinite(p.speed) && p.speed >= 0 && p.speed <= 22 &&
    typeof p.passenger === 'boolean';
}

function validShot(p) {
  if (!(p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 &&
    Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
    Number.isFinite(p.altitude) && Math.abs(p.altitude) <= 20000 &&
    Number.isFinite(p.vx) && Number.isFinite(p.vy) && Number.isFinite(p.vz))) return false;
  const speed = Math.hypot(p.vx, p.vy, p.vz);
  return Math.abs(speed - PELLET_SPEED) <= 1 || Math.abs(speed - 40) <= 1; // 40 m/s in older clients
}

function makeAvatar() {
  const group = new THREE.Group();
  const clothes = new THREE.MeshStandardMaterial({ color: '#356c8b', roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: '#c99473', roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: '#303a45', roughness: 0.9 });
  const part = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  part(new THREE.BoxGeometry(0.52, 0.65, 0.28), clothes, 0, 1.15, 0);
  part(new THREE.SphereGeometry(0.18, 12, 8), skin, 0, 1.67, 0);
  const upper = new THREE.Group();
  upper.position.y = 1.4;
  group.add(upper);
  const arm = (x) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.45, 0.16), clothes);
    mesh.position.set(x, -0.13, -0.16);
    mesh.rotation.x = -0.65;
    upper.add(mesh);
  };
  arm(-0.25); arm(0.25);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.5), dark);
  gun.position.set(0.06, -0.14, -0.43);
  upper.add(gun);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.06), new THREE.MeshStandardMaterial({ color: '#ff7b28' }));
  tip.position.set(0.06, -0.14, -0.71);
  upper.add(tip);
  const leftLeg = part(new THREE.BoxGeometry(0.2, 0.8, 0.2), dark, -0.13, 0.4, 0);
  const rightLeg = part(new THREE.BoxGeometry(0.2, 0.8, 0.2), dark, 0.13, 0.4, 0);
  part(new THREE.BoxGeometry(0.08, 0.08, 0.05), dark, 0, 1.67, -0.17);
  group.visible = false;
  group.userData = { upper, leftLeg, rightLeg };
  return group;
}

export class Multiplayer {
  constructor({ scene, getPosition, onJoinLocation, onStatus, onShot = () => {}, onPlaneRequest = () => {},
    onPlaneResponse = () => {}, onDisconnect = () => {}, loadPeer }) {
    this.getPosition = getPosition;
    this.onJoinLocation = onJoinLocation;
    this.onStatus = onStatus;
    this.onShot = onShot;
    this.onPlaneRequest = onPlaneRequest;
    this.onPlaneResponse = onPlaneResponse;
    this.onDisconnect = onDisconnect;
    this.loadPeer = loadPeer || (() => import('https://esm.sh/peerjs@1.5.5?bundle').then((m) => m.default));
    this.avatar = makeAvatar();
    scene.add(this.avatar);
    this.peer = null;
    this.connection = null;
    this.generation = 0;
    this.remote = null;
    this.lastSend = 0;
    this.timer = null;
    this.walkTime = 0;
    this.shotRecoil = 0;
    this.lastRemoteShot = 0;
  }

  async start(role, code = '') {
    if (role !== 'host' && role !== 'join') throw new Error('Invalid multiplayer role');
    code = code.trim().toLowerCase();
    if (role === 'join' && !CODE.test(code)) throw new Error('Enter the complete room code.');
    this.disconnect();
    const generation = this.generation;
    this.role = role;
    this.onStatus('Connecting to the signalling service...');
    let Peer;
    try {
      Peer = await this.loadPeer();
    } catch (error) {
      if (generation === this.generation) this.fail('Could not load multiplayer: ' + error.message);
      return;
    }
    if (generation !== this.generation) return;
    if (role === 'host') {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      code = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    this.code = code;
    try {
      const peer = this.peer = new Peer(role === 'host' ? PREFIX + code : undefined, { config: ICE });
      this.timer = setTimeout(() => this.fail('Connection timed out. Check your network or try again.'), 30000);
      peer.on('open', () => {
        if (generation !== this.generation) return;
        if (role === 'host') {
          clearTimeout(this.timer);
          this.timer = null;
          this.onStatus('Room ready. Share the code with your friend.', code);
        } else {
          this.attach(peer.connect(PREFIX + code, { reliable: true, serialization: 'json' }), generation);
          this.onStatus('Connecting to the host...');
        }
      });
      peer.on('connection', (connection) => {
        if (generation !== this.generation || role !== 'host' || this.connection) {
          connection.close();
          return;
        }
        this.attach(connection, generation);
        this.timer = setTimeout(() => this.fail('Player connection timed out. Try again.'), 30000);
      });
      peer.on('error', (error) => {
        if (generation === this.generation) this.fail('Multiplayer error: ' + error.message);
      });
      peer.on('disconnected', () => {
        if (generation === this.generation) this.fail('Signalling connection lost. Please reconnect.');
      });
    } catch (error) {
      if (generation === this.generation) this.fail('Could not start multiplayer: ' + error.message);
    }
  }

  attach(connection, generation) {
    this.connection = connection;
    connection.on('open', () => {
      if (generation !== this.generation) return;
      clearTimeout(this.timer);
      this.timer = null;
      this.onStatus('Player connected.', this.role === 'host' ? this.code : '');
    });
    connection.on('data', (data) => {
      if (generation !== this.generation || !data) return;
      if (data.type === 'shot') {
        const now = performance.now();
        if (validShot(data.shot) && now - this.lastRemoteShot >= 15) {
          this.lastRemoteShot = now;
          this.shotRecoil = 1;
          this.onShot(data.shot);
        }
        return;
      }
      if (data.type === 'plane-request' && (data.action === 'board' || data.action === 'leave')) {
        this.onPlaneRequest(data.action);
        return;
      }
      if (data.type === 'plane-response' && typeof data.ok === 'boolean' &&
          typeof data.message === 'string' && data.message.length <= 120) {
        this.onPlaneResponse(data.ok, data.message);
        return;
      }
      if (!validPosition(data.position)) return;
      if (data.type === 'welcome' && this.role === 'join' && !this.receivedWelcome) {
        this.receivedWelcome = true;
        this.onJoinLocation(data.position);
      } else if (data.type !== 'position') return;
      this.remote = { ...data.position, received: performance.now() };
    });
    connection.on('close', () => {
      if (generation === this.generation) this.fail('Player disconnected.');
    });
    connection.on('error', (error) => {
      if (generation === this.generation) this.fail('Connection error: ' + error.message);
    });
  }

  sendShot(shot) {
    if (!this.connection?.open) return;
    if (!validShot(shot)) {
      console.warn('Cannot send an invalid airsoft shot.');
      return;
    }
    try { this.connection.send({ type: 'shot', shot }); }
    catch (error) { this.fail('Could not send shot: ' + error.message); }
  }

  sendPlaneRequest(action) {
    if (!this.connection?.open || (action !== 'board' && action !== 'leave')) return false;
    try { this.connection.send({ type: 'plane-request', action }); return true; }
    catch (error) { this.fail('Could not send plane request: ' + error.message); return false; }
  }

  sendPlaneResponse(ok, message) {
    if (!this.connection?.open) return;
    try { this.connection.send({ type: 'plane-response', ok, message }); }
    catch (error) { this.fail('Could not send plane response: ' + error.message); }
  }

  update(dt, world, now = performance.now()) {
    if (this.connection?.open && now - this.lastSend >= 100) {
      const position = this.getPosition();
      if (validPosition(position)) {
        const type = this.role === 'host' && !this.sentWelcome ? 'welcome' : 'position';
        try {
          this.connection.send({ type, position });
        } catch (error) {
          this.fail('Could not send player position: ' + error.message);
          return;
        }
        if (type === 'welcome') this.sentWelcome = true;
      }
      this.lastSend = now;
    }
    if (world !== this.lastWorld) {
      this.avatar.visible = false;
      this.lastWorld = world;
    }
    if (!world || !this.remote || now - this.remote.received > 3000) {
      this.avatar.visible = false;
      return;
    }
    const p = world.frame.toLocal(this.remote.lat, this.remote.lon);
    if (Math.abs(p.x) > world.radius || Math.abs(p.z) > world.radius) {
      this.avatar.visible = false;
      return;
    }
    const target = new THREE.Vector3(p.x, this.remote.altitude === undefined
      ? world.heightAt(p.x, p.z) + this.remote.height : this.remote.altitude - world.terrain.baseElev, p.z);
    if (!this.avatar.visible) this.avatar.position.copy(target);
    else this.avatar.position.lerp(target, 1 - Math.exp(-dt * 12));
    this.avatar.rotation.y = this.remote.yaw;
    this.walkTime += dt * 9;
    const swing = this.remote.seat ? -1 : this.remote.moving ? Math.sin(this.walkTime) * 0.45 : 0;
    this.avatar.userData.leftLeg.rotation.x = swing;
    this.avatar.userData.rightLeg.rotation.x = this.remote.seat ? swing : -swing;
    this.shotRecoil = Math.max(0, this.shotRecoil - dt * 7);
    this.avatar.userData.upper.rotation.x = (this.remote.pitch || 0) + this.shotRecoil * 0.12;
    this.avatar.visible = true;
  }

  fail(message) {
    this.disconnect();
    this.onStatus(message);
  }

  disconnect() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = null;
    const connection = this.connection, peer = this.peer;
    this.connection = this.peer = null;
    this.remote = null;
    this.receivedWelcome = false;
    this.sentWelcome = false;
    this.lastWorld = null;
    this.lastRemoteShot = 0;
    this.shotRecoil = 0;
    this.avatar.visible = false;
    if (connection) this.onDisconnect();
    if (connection) connection.close();
    if (peer) peer.destroy();
  }
}
