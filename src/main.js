import * as THREE from 'three';
import { CONFIG } from './config.js';
import { sunPosition, DEG } from './geo.js';
import { Environment } from './environment.js';
import { WeatherFX } from './weatherfx.js';
import { Player, findOpenSpawn } from './player.js';
import { Airsoft } from './airsoft.js';
import { ShotAudio } from './shot-audio.js';
import { Multiplayer } from './multiplayer.js';
import { Plane } from './plane.js';
import { loadWorld } from './world/world.js';
import { fetchWeather, WEATHER_PRESETS, describeWeather, weatherToEffects } from './data/weather.js';
import { searchPlaces, currentPosition, watchPosition } from './data/location.js';

const $ = (id) => document.getElementById(id);
const S = CONFIG.sources;

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.2, 9000);
const env = new Environment(scene, renderer);
const weatherFx = new WeatherFX(scene);
const player = new Player(camera, renderer.domElement);
const airsoft = new Airsoft(scene);
const plane = new Plane(scene);
let boardPending = 0;

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  airsoft.resize(camera.aspect);
}
addEventListener('resize', resize);
resize();

// ---------- state ----------
function initialPlace() {
  const q = new URLSearchParams(location.search);
  if (q.has('lat') && q.has('lon')) return { name: q.get('name') || 'Custom location', lat: +q.get('lat'), lon: +q.get('lon') };
  try {
    const saved = JSON.parse(localStorage.getItem('earthweb.place'));
    if (saved && Number.isFinite(saved.lat)) return saved;
  } catch { /* ignore corrupt storage */ }
  return CONFIG.defaultPlace;
}

const state = {
  world: null, loading: false, abort: null,
  place: initialPlace(),
  options: { radius: CONFIG.radius, inferTrees: true },
  simTime: Date.now(), live: true, speed: 1,
  weatherMode: 'live', liveWeather: null, weatherAt: 0,
  gps: { follow: false, last: null, stop: null },
  reloadAfter: 0,
};
state.liveWeather = { ...WEATHER_PRESETS.clear, utcOffset: Math.round(state.place.lon / 15) * 3600, source: 'default' };

const currentWeather = () =>
  state.weatherMode === 'live' ? state.liveWeather : { ...WEATHER_PRESETS[state.weatherMode], utcOffset: state.liveWeather.utcOffset };

// ---------- UI helpers ----------
let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const shotAudio = new ShotAudio((message) => {
  console.warn(message);
  toast(message);
});
window.addEventListener('pointerdown', () => shotAudio.unlock(), true);
window.addEventListener('keydown', () => shotAudio.unlock(), true);

const statusItems = new Map();
function setStatus(key, label, st, msg) {
  statusItems.set(key, { label, st, msg });
  const icon = { loading: '…', ok: '✓', warn: '!', error: '✗' };
  $('status').innerHTML = [...statusItems.values()]
    .map((s) => `<li class="${s.st}"><i>${icon[s.st]}</i><span>${s.label}${s.msg ? ` — ${s.msg}` : ''}</span></li>`)
    .join('');
}

function syncOverlays() {
  $('menu').hidden = player.locked || state.loading;
  $('hud').hidden = $('minimap').hidden = !state.world;
}
player.onLockChange = syncOverlays;

function showError(e) {
  $('loading-title').textContent = 'Could not build the world';
  $('loading-retry').hidden = false;
  setStatus('fatal', e.message, 'error');
}
$('loading-retry').onclick = () => {
  state.loading = false;
  $('loading').hidden = true;
  $('walk').textContent = state.world ? 'Resume walking' : 'Retry';
  $('walk').disabled = false;
  syncOverlays();
};

// ---------- world loading ----------
async function loadArea(lat, lon, { blocking = true } = {}) {
  state.abort?.abort();
  const ctrl = (state.abort = new AbortController());
  state.loading = true;
  statusItems.clear();
  if (blocking) {
    $('loading-title').textContent = 'Building your world…';
    $('loading-retry').hidden = true;
    $('loading').hidden = false;
    $('walk').disabled = true;
  } else {
    toast('Loading the next area…', 15000);
  }
  syncOverlays();
  refreshWeather(lat, lon, blocking);
  try {
    const world = await loadWorld(lat, lon, {
      renderer, options: state.options, signal: ctrl.signal,
      status: blocking ? setStatus : () => {},
    });
    if (ctrl.signal.aborted) return world.dispose();

    const spawn = findOpenSpawn(world);
    if (!spawn) {
      world.dispose();
      throw new Error('No safe starting position found near this location.');
    }
    const old = state.world;
    if (old && !blocking && plane.group.visible) plane.reframe(old, world);
    if (old && blocking && plane.group.visible) {
      if (plane.seat === 'passenger') multiplayer.sendPlaneRequest('leave');
      plane.remove();
      player.inVehicle = false;
      boardPending = 0;
    }
    if (old) { scene.remove(old.group); old.dispose(); }
    airsoft.clear();
    scene.add(world.group);
    env.wallMaterial = world.wallMaterial;
    state.world = world;
    if (plane.seat) plane.placePlayer(player);
    else {
      player.pos.set(spawn.x, world.heightAt(spawn.x, spawn.z), spawn.z);
      player.vy = 0;
      player.grounded = true;
    }
    state.reloadAfter = 0;
    state.loading = false;
    $('loading').hidden = true;
    $('walk').textContent = 'Walk';
    $('walk').disabled = false;
    if (!world.stats.osm && !world.stats.overture) toast('Map data unavailable: roads, buildings and inferred trees are disabled. Use "Reload here" to retry.', 12000);
    else if (!world.stats.osm) toast('OpenStreetMap unavailable: using Overture where available; mapped vegetation and inferred trees are disabled.', 12000);
    else if (!world.stats.overture) toast('Overture unavailable: using OpenStreetMap only. Use "Reload here" to retry.', 9000);
    else if (!world.stats.satellite || world.stats.missingTiles) toast('Satellite imagery is unavailable or incomplete in this area.', 9000);
    else if (!blocking) toast('Area updated', 1500);
    else toast(`${world.stats.roads} road segments · ${world.stats.buildings} buildings · ${world.stats.trees} trees`);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    console.error(e);
    if (blocking) showError(e);
    else {
      state.loading = false;
      state.reloadAfter = performance.now() + 15000;
      toast('Could not load the next area: ' + e.message);
    }
  }
  syncOverlays();
}

async function refreshWeather(lat, lon, force) {
  if (!force && Date.now() - state.weatherAt < 5 * 60 * 1000) return;
  try {
    state.liveWeather = await fetchWeather(S.weather, lat, lon);
    state.weatherAt = Date.now();
  } catch (e) {
    console.warn('Weather unavailable', e);
    state.liveWeather.source = 'offline defaults';
  }
}
setInterval(() => state.world && refreshWeather(state.world.lat, state.world.lon, true), 10 * 60 * 1000);

function goTo(place, blocking = true) {
  state.place = place;
  try { localStorage.setItem('earthweb.place', JSON.stringify(place)); } catch { /* storage may be blocked */ }
  return loadArea(place.lat, place.lon, { blocking });
}

const playerGeo = () => state.world.frame.toGeo(player.pos.x, player.pos.z);

let moving = false;
const multiplayer = new Multiplayer({
  scene,
  getPosition: () => {
    if (!state.world || state.loading) return null;
    return { ...playerGeo(), height: Math.max(0, player.pos.y - state.world.heightAt(player.pos.x, player.pos.z)),
      altitude: player.pos.y + state.world.terrain.baseElev, yaw: player.yaw, pitch: player.pitch, moving,
      seat: plane.seat, plane: plane.snapshot(state.world) };
  },
  onPlaneRequest: (action) => {
    if (action === 'leave') {
      if (plane.owner) plane.passenger = false;
      return;
    }
    const world = state.world, remote = multiplayer.remote;
    let message = '';
    if (!world || state.loading || !plane.owner || plane.seat !== 'pilot') message = 'The pilot is not ready.';
    else if (plane.passenger) message = 'The passenger seat is occupied.';
    else if (!remote || performance.now() - remote.received > 3000 || remote.altitude === undefined)
      message = 'Your position is unavailable; try again.';
    else {
      const p = world.frame.toLocal(remote.lat, remote.lon);
      const distance = Math.hypot(p.x - plane.group.position.x, p.z - plane.group.position.z,
        remote.altitude - world.terrain.baseElev - plane.group.position.y);
      if (distance > 8) message = 'Move closer to the plane.';
      else if (plane.speed > 2 || plane.group.position.y - world.heightAt(p.x, p.z) > 1)
        message = 'The plane must be stopped on the ground.';
    }
    if (!message) plane.passenger = true;
    multiplayer.sendPlaneResponse(!message, message || 'Passenger aboard.');
    if (!message) toast('Passenger aboard.');
  },
  onPlaneResponse: (ok, message) => {
    if (!boardPending) {
      if (ok) multiplayer.sendPlaneRequest('leave');
      return;
    }
    boardPending = 0;
    if (ok && plane.group.visible && !plane.owner && state.world && !state.loading) {
      plane.seat = 'passenger';
      player.inVehicle = true;
      player.fly = false;
      plane.placePlayer(player);
    } else if (ok) {
      multiplayer.sendPlaneRequest('leave');
      message = 'Could not board the plane; try again.';
    }
    toast(message);
  },
  onDisconnect: () => {
    boardPending = 0;
    if (plane.owner) plane.passenger = false;
    else if (plane.group.visible) {
      if (plane.seat) {
        player.fly = true;
        player.vy = 0;
        toast('Plane disconnected; fly mode enabled.');
      }
      plane.remove();
      player.inVehicle = false;
    }
  },
  onShot: (shot) => {
    const world = state.world;
    if (!world || state.loading) return;
    const p = world.frame.toLocal(shot.lat, shot.lon);
    if (Math.abs(p.x) > world.radius || Math.abs(p.z) > world.radius) return;
    airsoft.spawnPellet(new THREE.Vector3(p.x, shot.altitude - world.terrain.baseElev, p.z),
      new THREE.Vector3(shot.vx, shot.vy, shot.vz));
    shotAudio.play();
  },
  onJoinLocation: (position) => {
    const lat = position.lat;
    const lon = ((position.lon + 3 / (111319.49 * Math.cos(lat * DEG)) + 180) % 360) - 180;
    goTo({ name: "Friend's location", lat, lon });
  },
  onStatus: (message, code) => {
    $('mp-status').textContent = message;
    if (code) $('mp-code').value = code;
    toast(message);
  },
});
airsoft.onShot = (start, velocity) => {
  const world = state.world;
  if (!world || state.loading) return;
  shotAudio.play();
  multiplayer.sendShot({ ...world.frame.toGeo(start.x, start.z), altitude: start.y + world.terrain.baseElev,
    vx: velocity.x, vy: velocity.y, vz: velocity.z });
};

// ---------- menu wiring ----------
$('mp-host').onclick = () => {
  if (!state.world || state.loading) return toast('Wait for the world to finish loading.');
  multiplayer.start('host');
};
$('mp-join').onclick = async () => {
  if (!state.world || state.loading) return toast('Wait for the world to finish loading.');
  try { await multiplayer.start('join', $('mp-code').value); }
  catch (error) { $('mp-status').textContent = error.message; }
};
$('mp-leave').onclick = () => {
  multiplayer.disconnect();
  $('mp-status').textContent = 'Not connected.';
};
$('walk').onclick = () => (state.world ? player.lock() : goTo(state.place));
$('view').addEventListener('click', () => state.world && !state.loading && !player.locked && player.lock());
let firing = false;

window.addEventListener('keydown', (event) => {
  if (!player.locked || !state.world || state.loading || event.repeat) return;
  if (event.code === 'KeyP') {
    const error = plane.spawn(state.world, player);
    if (error) toast(error);
    else toast('Plane spawned. Walk up and press E to enter.');
  } else if (event.code === 'KeyE') {
    if (plane.seat) {
      const wasPassenger = plane.seat === 'passenger';
      const error = plane.exit(state.world, player);
      if (error) return toast(error);
      player.inVehicle = false;
      if (wasPassenger) multiplayer.sendPlaneRequest('leave');
      toast('Left the plane.');
    } else if (!plane.group.visible || plane.distanceTo(player) > 8) {
      toast('Move closer to the plane.');
    } else if (plane.owner) {
      if (plane.boardPilot(player)) {
        player.inVehicle = true;
        toast('Pilot: W/S speed, A/D turn, Space/C climb or descend. E exits when stopped.');
      }
    } else if (!boardPending) {
      if (plane.passenger) return toast('The passenger seat is occupied.');
      if (!multiplayer.sendPlaneRequest('board')) return toast('Connect to the pilot first.');
      boardPending = performance.now() + 5000;
      toast('Requesting passenger seat...');
    }
  }
});

$('view').addEventListener('mousedown', (event) => {
  if (!player.locked || !state.world || state.loading) return;
  if (event.button === 0) firing = true;
  if (event.button === 2) airsoft.aiming = true;
});

window.addEventListener('mouseup', (event) => {
  if (event.button === 0) firing = false;
  if (event.button === 2) airsoft.aiming = false;
});

$('view').addEventListener('contextmenu', (event) => {
  if (player.locked) event.preventDefault();
});

function releaseMouseControls() {
  firing = false;
  airsoft.aiming = false;
}
window.addEventListener('blur', releaseMouseControls);
document.addEventListener('pointerlockchange', () => {
  if (!player.locked) releaseMouseControls();
});

$('q').value = state.place.name;
$('search-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const list = $('results');
  list.innerHTML = '<li>Searching…</li>';
  try {
    const found = await searchPlaces(S.geocode, q);
    list.innerHTML = '';
    if (!found.length) list.innerHTML = '<li>No results</li>';
    for (const p of found) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.name;
      b.onclick = () => { list.innerHTML = ''; $('q').value = p.name.split(',')[0]; goTo({ ...p, name: p.name.split(',').slice(0, 2).join(',') }); };
      li.append(b);
      list.append(li);
    }
  } catch (err) {
    list.innerHTML = `<li>Search failed: ${err.message}</li>`;
  }
};

$('gps').onclick = async () => {
  try {
    toast('Waiting for GPS…', 10000);
    const p = await currentPosition();
    goTo({ name: `My position (±${Math.round(p.accuracy)} m)`, lat: p.lat, lon: p.lon });
  } catch (e) {
    toast('GPS failed: ' + e.message);
  }
};

$('follow').onchange = (e) => {
  state.gps.follow = e.target.checked;
  state.gps.stop?.();
  state.gps.stop = null;
  state.gps.last = null;
  if (state.gps.follow) {
    state.gps.stop = watchPosition((fix) => (state.gps.last = fix), (err) => toast('GPS: ' + err.message));
    toast('Live GPS: walk outside and the avatar follows you');
  }
};

$('live').onchange = (e) => {
  state.live = e.target.checked;
  if (state.live) { state.simTime = Date.now(); state.speed = 1; $('speed').value = '1'; }
};
$('speed').onchange = (e) => {
  state.speed = +e.target.value;
  if (state.speed > 1) { state.live = false; $('live').checked = false; }
};
$('hour').oninput = (e) => {
  state.live = false;
  $('live').checked = false;
  const off = (currentWeather().utcOffset || 0) * 1000;
  const d = new Date(state.simTime + off);
  d.setUTCHours(0, 0, 0, 0);
  state.simTime = d.getTime() - off + +e.target.value * 3600e3;
};
$('wx').onchange = (e) => (state.weatherMode = e.target.value);
$('radius').onchange = (e) => (state.options.radius = +e.target.value);
$('infer').onchange = (e) => (state.options.inferTrees = e.target.checked);
$('shadows').onchange = (e) => (env.shadowsEnabled = e.target.checked);
$('reload').onclick = () => state.world && loadArea(...Object.values(playerGeo()));

// ---------- HUD ----------
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const pad = (n) => String(Math.floor(n)).padStart(2, '0');
function localHour() {
  const d = new Date(state.simTime + (currentWeather().utcOffset || 0) * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}
let hudAt = 0;
function updateHud(sun, w) {
  const hour = localHour();
  if (document.activeElement !== $('hour')) $('hour').value = hour;
  $('hour-label').textContent = `${pad(hour)}:${pad((hour % 1) * 60)}`;
  if (!state.world || performance.now() - hudAt < 250) return;
  hudAt = performance.now();
  const g = playerGeo(), b = player.bearing;
  $('hud-place').textContent = state.place.name;
  const vehicle = plane.seat ? ` · ${plane.seat.toUpperCase()} ${Math.round(plane.speed * 3.6)} km/h` : player.fly ? ' · FLY' : '';
  $('hud-pos').textContent = `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)} · ${Math.round(state.world.terrain.baseElev + player.pos.y)} m · ${COMPASS[Math.round(b / 45) % 8]} ${Math.round(b)}°${vehicle}`;
  $('hud-env').textContent = `${pad(hour)}:${pad((hour % 1) * 60)} · sun ${Math.round(sun.altitude / DEG)}° · ${describeWeather(w.code)} ${Math.round(w.temp)}°C · wind ${w.windSpeed.toFixed(1)} m/s`;
  const map = state.world.stats;
  $('hud-map').textContent = map.osm
    ? `${map.buildings} buildings · ${map.roads} road segments`
    : 'OpenStreetMap unavailable — reload to retry';
}

const mm = $('minimap');
const mmCtx = mm.getContext('2d');
function drawMinimap() {
  const w = state.world;
  const S2 = mm.width, span = 260;
  const g = playerGeo(), c = w.imagery.toPixel(g.lat, g.lon);
  const e = w.imagery.toPixel(...Object.values(w.frame.toGeo(player.pos.x + 100, player.pos.z)));
  const half = ((e.x - c.x) / 100) * (span / 2);
  mmCtx.fillStyle = '#10151f';
  mmCtx.fillRect(0, 0, S2, S2);
  mmCtx.drawImage(w.imagery.canvas, c.x - half, c.y - half, half * 2, half * 2, 0, 0, S2, S2);
  mmCtx.save();
  mmCtx.translate(S2 / 2, S2 / 2);
  mmCtx.rotate((player.bearing * Math.PI) / 180);
  mmCtx.fillStyle = '#ffdd44';
  mmCtx.strokeStyle = '#000';
  mmCtx.beginPath();
  mmCtx.moveTo(0, -10); mmCtx.lineTo(7, 8); mmCtx.lineTo(0, 4); mmCtx.lineTo(-7, 8); mmCtx.closePath();
  mmCtx.fill(); mmCtx.stroke();
  mmCtx.restore();
  mmCtx.fillStyle = '#fff';
  mmCtx.font = 'bold 13px sans-serif';
  mmCtx.fillText('N', S2 / 2 - 4, 14);
}

// ---------- main loop ----------
const clock = new THREE.Clock();
let mmAt = 0;
renderer.setAnimationLoop(() => {
  if (firing && player.locked && state.world && !state.loading) {
  airsoft.shoot(camera);
}
  const dt = Math.min(clock.getDelta(), 0.1);
  const world = state.world;
  state.simTime = state.live ? Date.now() : state.simTime + dt * 1000 * state.speed;

  const w = currentWeather();
  const lat = world ? world.lat : state.place.lat, lon = world ? world.lon : state.place.lon;
  const sun = sunPosition(new Date(state.simTime), lat, lon);
  const fx = weatherToEffects(w, world ? world.radius : CONFIG.radius);

  if (world) {
    const oldX = player.pos.x, oldZ = player.pos.z;
    if (!state.loading) {
      const remote = multiplayer.remote;
      if (remote?.plane) {
        if (plane.owner && multiplayer.role === 'join') {
          if (plane.seat) { player.fly = true; player.inVehicle = false; }
          plane.remove();
          toast("Using the host's plane.");
        }
        if (!plane.owner) plane.applyRemote(remote.plane, world, player);
      } else if (remote && !plane.owner && plane.group.visible) {
        if (plane.seat) { player.fly = true; player.inVehicle = false; toast('Plane unavailable; fly mode enabled.'); }
        plane.remove();
      }
      if (boardPending && performance.now() > boardPending) {
        boardPending = 0;
        toast('Passenger request timed out.');
      }
      if (plane.seat) plane.update(player.locked ? dt : 0, world, player);
      else {
        plane.update(dt, world, player);
        player.update(dt, world);
      }
    }
    if (!state.loading) airsoft.update(dt, world, player.locked &&
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].some((key) => player.keys.has(key)));
    if (!plane.seat) followGps(dt, world);
    moving = !state.loading && Math.hypot(player.pos.x - oldX, player.pos.z - oldZ) > 0.001;
    if (!state.loading && performance.now() >= state.reloadAfter &&
        Math.hypot(player.pos.x, player.pos.z) > world.radius * CONFIG.reloadFraction) {
      const g = playerGeo();
      loadArea(g.lat, g.lon, { blocking: false });
    }
    multiplayer.update(dt, state.loading ? null : world);
  }
  const focus = world ? player.pos : camera.position;
  env.update(sun, fx, focus, camera);
  weatherFx.update(dt, fx, camera, env.dayFactor);
  updateHud(sun, w);
  if (world && performance.now() - mmAt > 100) { mmAt = performance.now(); drawMinimap(); }
  renderer.render(scene, camera);
  if (world && player.locked && !state.loading) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(airsoft.viewScene, airsoft.viewCamera);
    renderer.autoClear = true;
  }
});

// Live GPS: glide the avatar to where the device really is; re-centre the world if it walks far away.
function followGps(dt, world) {
  const fix = state.gps.last;
  if (!state.gps.follow || !fix || state.loading) return;
  const t = world.frame.toLocal(fix.lat, fix.lon);
  if (Math.hypot(t.x, t.z) > world.radius * CONFIG.reloadFraction) {
    if (performance.now() >= state.reloadAfter) loadArea(fix.lat, fix.lon, { blocking: false });
    return;
  }
  const k = 1 - Math.exp(-dt * 2);
  player.pos.x += (t.x - player.pos.x) * k;
  player.pos.z += (t.z - player.pos.z) * k;
}

// Handy for tinkering in the browser console (e.g. earthweb.player.pos.set(...)).
window.earthweb = { state, player, airsoft, multiplayer, plane, env, scene, camera };

// Kick off the first load immediately; the menu offers "Walk" once it is ready.
goTo(state.place);
