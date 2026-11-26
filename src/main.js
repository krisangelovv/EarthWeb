import * as THREE from 'three';
import { CONFIG } from './config.js';
import { sunPosition, DEG } from './geo.js';
import { Environment } from './environment.js';
import { WeatherFX } from './weatherfx.js';
import { Player } from './player.js';
import { Airsoft } from './airsoft.js';
import { Multiplayer } from './multiplayer.js';
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
const camera = new THREE.PerspectiveCamera(70, 1, 0.2, 5000);
const env = new Environment(scene, renderer);
const weatherFx = new WeatherFX(scene);
const player = new Player(camera, renderer.domElement);
const airsoft = new Airsoft(scene);

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
  const weatherReq = refreshWeather(lat, lon, blocking);
  try {
    const world = await loadWorld(lat, lon, {
      renderer, options: state.options, signal: ctrl.signal,
      status: blocking ? setStatus : () => {},
    });
    if (ctrl.signal.aborted) return world.dispose();

    const old = state.world;
    if (old) { scene.remove(old.group); old.dispose(); }
    airsoft.clear();
    scene.add(world.group);
    env.wallMaterial = world.wallMaterial;
    state.world = world;
    player.pos.set(0, world.heightAt(0, 0), 0); // the new world is centred on the player
    player.vy = 0;
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
    await weatherReq;
  } catch (e) {
    if (ctrl.signal.aborted) return;
    console.error(e);
    if (blocking) showError(e);
    else { state.loading = false; toast('Could not load the next area: ' + e.message); }
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

const multiplayer = new Multiplayer({
  scene,
  getPosition: () => {
    if (!state.world || state.loading) return null;
    return { ...playerGeo(), height: Math.max(0, player.pos.y - state.world.heightAt(player.pos.x, player.pos.z)), yaw: player.yaw };
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

$('view').addEventListener('pointerdown', (event) => {
  if (event.button === 0 && player.locked && state.world && !state.loading) {
    firing = true;
  }
});

window.addEventListener('pointerup', (event) => {
  if (event.button === 0) firing = false;
});

window.addEventListener('blur', () => { firing = false; });
document.addEventListener('pointerlockchange', () => {
  if (!player.locked) firing = false;
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
  $('hud-pos').textContent = `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)} · ${Math.round(state.world.terrain.baseElev + player.pos.y)} m · ${COMPASS[Math.round(b / 45) % 8]} ${Math.round(b)}°${player.fly ? ' · FLY' : ''}`;
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
    if (!state.loading) player.update(dt, world);
    if (!state.loading) airsoft.update(dt, world, player.locked &&
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].some((key) => player.keys.has(key)));
    followGps(dt, world);
    if (!state.loading && Math.hypot(player.pos.x, player.pos.z) > world.radius * CONFIG.reloadFraction) {
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
    loadArea(fix.lat, fix.lon, { blocking: false });
    return;
  }
  const k = 1 - Math.exp(-dt * 2);
  player.pos.x += (t.x - player.pos.x) * k;
  player.pos.z += (t.z - player.pos.z) * k;
}

// Handy for tinkering in the browser console (e.g. earthweb.player.pos.set(...)).
window.earthweb = { state, player, airsoft, multiplayer, env, scene, camera };

// Kick off the first load immediately; the menu offers "Walk" once it is ready.
goTo(state.place);
