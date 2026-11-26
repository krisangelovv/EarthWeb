import * as THREE from 'three';

const PREFIX = 'earthweb-';
const CODE = /^[a-f0-9]{24}$/;
const ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

function validPosition(p) {
  return p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 &&
    Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
    Number.isFinite(p.height) && p.height >= 0 && p.height < 10000 &&
    Number.isFinite(p.yaw) && Math.abs(p.yaw) < 100000;
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
  };
  part(new THREE.BoxGeometry(0.52, 0.65, 0.28), clothes, 0, 1.15, 0);
  part(new THREE.SphereGeometry(0.18, 12, 8), skin, 0, 1.67, 0);
  part(new THREE.BoxGeometry(0.16, 0.62, 0.17), clothes, -0.34, 1.12, 0);
  part(new THREE.BoxGeometry(0.16, 0.62, 0.17), clothes, 0.34, 1.12, 0);
  part(new THREE.BoxGeometry(0.2, 0.8, 0.2), dark, -0.13, 0.4, 0);
  part(new THREE.BoxGeometry(0.2, 0.8, 0.2), dark, 0.13, 0.4, 0);
  part(new THREE.BoxGeometry(0.08, 0.08, 0.05), dark, 0, 1.67, -0.17);
  group.visible = false;
  return group;
}

export class Multiplayer {
  constructor({ scene, getPosition, onJoinLocation, onStatus, loadPeer }) {
    this.getPosition = getPosition;
    this.onJoinLocation = onJoinLocation;
    this.onStatus = onStatus;
    this.loadPeer = loadPeer || (() => import('https://esm.sh/peerjs@1.5.5?bundle').then((m) => m.default));
    this.avatar = makeAvatar();
    scene.add(this.avatar);
    this.peer = null;
    this.connection = null;
    this.generation = 0;
    this.remote = null;
    this.lastSend = 0;
    this.timer = null;
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
      if (generation !== this.generation || !data || !validPosition(data.position)) return;
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
    const target = new THREE.Vector3(p.x, world.heightAt(p.x, p.z) + this.remote.height, p.z);
    if (!this.avatar.visible) this.avatar.position.copy(target);
    else this.avatar.position.lerp(target, 1 - Math.exp(-dt * 12));
    this.avatar.rotation.y = this.remote.yaw;
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
    this.avatar.visible = false;
    if (connection) connection.close();
    if (peer) peer.destroy();
  }
}
