import * as THREE from 'three';

const SHOT_INTERVAL = 0.02;
const PELLET_SPEED = 40;
const PELLET_LIFETIME = 2.5;

function capsuleBetween(a, b, radius, material) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, direction.length(), 4, 10), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function box(group, size, position, material, rotation = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.rotation.x = rotation;
  group.add(mesh);
  return mesh;
}

// A camera-space toy model and short-lived visual pellets; pellets do not affect the world.
export class Airsoft {
  constructor(scene) {
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
    this.viewScene.add(new THREE.HemisphereLight(0xffffff, 0x62677a, 2));
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(-1, 3, 2);
    this.viewScene.add(light);

    this.model = new THREE.Group();
    this.model.rotation.y = 0.0;
    this.model.position.x = 0.0;
    this.viewScene.add(this.model);
    const sleeve = new THREE.MeshStandardMaterial({ color: '#476579', roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: '#c99473', roughness: 0.9 });
    const body = new THREE.MeshStandardMaterial({ color: '#356c8b', roughness: 0.7 });
    const trim = new THREE.MeshStandardMaterial({ color: '#91b8be', roughness: 0.7 });
    const orange = new THREE.MeshStandardMaterial({ color: '#ff7b28', roughness: 0.6 });

    this.model.add(capsuleBetween([0.52, -0.5, -0.37], [0.30, -0.32, -0.58], 0.09, sleeve));
    this.model.add(capsuleBetween([0.30, -0.32, -0.58], [0.24, -0.24, -0.66], 0.07, skin));
    this.model.add(capsuleBetween([-0.48, -0.47, -0.55], [0.04, -0.29, -0.88], 0.085, sleeve));
    this.model.add(capsuleBetween([0.04, -0.29, -0.88], [0.18, -0.24, -0.89], 0.065, skin));

    box(this.model, [0.16, 0.14, 0.42], [0.22, -0.16, -0.76], body);
    box(this.model, [0.12, 0.11, 0.24], [0.22, -0.15, -1.05], trim);
    box(this.model, [0.07, 0.19, 0.09], [0.22, -0.30, -0.66], body, -0.22);
    box(this.model, [0.09, 0.16, 0.13], [0.22, -0.30, -0.81], trim, 0.1);
    box(this.model, [0.10, 0.035, 0.25], [0.22, -0.073, -0.78], trim);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.09, 12), orange);
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0.00, -0.1, 0.00);
    this.model.add(tip);
    this.muzzle = new THREE.Vector3(0.00, -0.1, 0.00);

    this.pelletGroup = new THREE.Group();
    scene.add(this.pelletGroup);
    this.pelletGeometry = new THREE.SphereGeometry(0.055, 8, 6);
    this.pelletMaterial = new THREE.MeshBasicMaterial({ color: '#ffdc6b' });
    this.pellets = [];
    this.cooldown = 0;
    this.recoil = 0;
    this.bob = 0;
  }

  resize(aspect) {
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();
  }

  shoot(camera) {
    if (this.cooldown > 0) return false;
    camera.updateMatrixWorld();
    this.model.updateMatrixWorld();
    const start = this.model.localToWorld(this.muzzle.clone()).applyQuaternion(camera.quaternion).add(camera.position);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const target = camera.position.clone().addScaledVector(direction, 30);
    const velocity = target.sub(start).normalize().multiplyScalar(PELLET_SPEED);
    const mesh = new THREE.Mesh(this.pelletGeometry, this.pelletMaterial);
    mesh.position.copy(start);
    this.pelletGroup.add(mesh);
    this.pellets.push({ mesh, velocity, age: 0 });
    this.cooldown = SHOT_INTERVAL;
    this.recoil = 1;
    return true;
  }

  update(dt, world, moving) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.bob += dt * (moving ? 9 : 2);
    this.model.position.set(0.28 + (moving ? Math.sin(this.bob) * 0.01 : 0),
      (moving ? Math.abs(Math.cos(this.bob)) * 0.008 : 0) - this.recoil * 0.018, this.recoil * 0.06);
    this.model.rotation.x = this.recoil * 0.08;
    for (let i = this.pellets.length - 1; i >= 0; i--) {
      const pellet = this.pellets[i];
      pellet.age += dt;
      pellet.velocity.y -= 9.8 * dt;
      pellet.mesh.position.addScaledVector(pellet.velocity, dt);
      const p = pellet.mesh.position;
      if (pellet.age >= PELLET_LIFETIME || Math.abs(p.x) > world.radius || Math.abs(p.z) > world.radius ||
          p.y <= world.heightAt(p.x, p.z)) {
        this.pelletGroup.remove(pellet.mesh);
        this.pellets.splice(i, 1);
      }
    }
  }

  clear() {
    for (const pellet of this.pellets) this.pelletGroup.remove(pellet.mesh);
    this.pellets.length = 0;
    this.cooldown = 0;
    this.recoil = 0;
  }
}
