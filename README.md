# EarthWeb — walk your hometown in the browser

A zero-build, browser-based first-person walker over **real-world data**:

| Layer | Source (all free, no API key) |
|---|---|
| Ground texture (satellite) | Esri World Imagery tiles (falls back to OpenStreetMap tiles) |
| Roads | OpenStreetMap road centre lines, widths and lane counts; additional Overture Maps roads |
| Terrain height | Mapzen/AWS Terrain Tiles (Terrarium, global DEM) |
| Buildings (footprints, `height`, `building:levels`, `min_height`, `building:part`, roof shape, colours) | OpenStreetMap via Overpass API, supplemented by Overture Maps; satellite imagery for untagged roof colours |
| Vegetation | OSM trees / forests / parks / grassland, plus grass and optional tree detection from satellite imagery |
| Weather (cloud, rain, snow, fog, wind, temperature) | Open-Meteo |
| Sun position, day/night, stars | Computed from real date/time and your coordinates |
| Place search / GPS | Nominatim geocoder, browser Geolocation API |

## Run

No Node or Python needed. From this folder:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1      # then open http://localhost:8080
```

Any static server works too (VS Code Live Server, `python -m http.server`, …). ES modules need `http://`, not `file://`.
Open `http://localhost:8080/?lat=42.6977&lon=23.3219&name=MyTown` to start somewhere specific. Or use the search box / "Use my GPS position" in the menu.
With the server running, open `http://localhost:8080/tests/roads.html` for map checks, `http://localhost:8080/tests/player.html` for player checks, or `http://localhost:8080/tests/multiplayer.html` for multiplayer checks.

## Controls

`W A S D` walk · `Shift` run · `Space` jump · `F` fly (`Space`/`C` up/down) · `Left click` fire · hold `Right click` aim · `Esc` menu.
"Follow my GPS live" makes the avatar move as you walk outside with your phone/laptop.

The first-person arms and orange-tipped airsoft toy are procedural. Pellets are visual only: they fall and disappear on the ground or after a short time, with no damage or building impacts.

Press `P` to spawn a plane nearby, then approach and press `E` to pilot. A connected friend can approach and press `E` to request the passenger seat. The pilot uses `W`/`S` to accelerate/slow, `A`/`D` to turn, and `Space`/`C` to climb/descend once moving. Flight is arcade-style, not realistic; land and stop before pressing `E` to exit. The passenger exits before the pilot. Mouse look is relative to the plane. The plane pauses when the pilot's area loads or the pilot opens the menu. It follows terrain but has no building or tree collision.

## Multiplayer

Both players need their own copy of the game running in a browser. Once the world loads, the host selects **Create room** in the menu and shares the room code privately. The other player enters it and selects **Join room**; their world loads near the host. Press Esc to return to the menu and disconnect. Only two players can connect at once.

Positions, facing, walking/aiming animation and visual airsoft shots are shared directly over WebRTC; pellets still have no damage or impacts on players. Each player hears a synthesized airsoft click for their own shots and received shots within their loaded area; the sound is not spatialized. Browsers require a click or keypress to enable audio. Both players should use the updated version. The PeerJS public signalling service and Cloudflare STUN server assist with establishing the connection. The other player receives your in-game location and can see your IP address; signalling and STUN services also see connection metadata. Only share the room code with someone you trust. No public TURN relay is configured, so restrictive networks may prevent connection. Both players need internet access to the signalling service and game data sources. Weather and time are not synchronised.

The plane is controlled by its spawning player; the other player can ride as passenger. Only one shared plane is supported. If the pilot disconnects, a passenger is released into fly mode. Each player loads areas independently; a passenger may see the plane catch up after loading, and network delay can cause visible jumps. GPS follow is ignored while seated.

## How it works

- The world is a square of `radius` metres (default 700) around you, in a local metric frame (`x` east, `-z` north). When you walk ~55 % of the way to its edge, a new area is built around you and swapped in.
- `src/data/*` fetch and parse data; `src/world/*` turn it into meshes (one merged mesh for walls, one for roofs, instanced trees); `src/environment.js` and `src/weatherfx.js` do sky, light, fog, rain, snow.
- Buildings without a tagged height get a typical one for their `building=*` type (`DEFAULT_HEIGHT` in `src/data/osm.js`).
- OSM buildings and road tags take priority. Overture supplies additional non-overlapping buildings and non-duplicate roads, and a height for a matched OSM building only when OSM has neither a height nor levels. Overture itself includes OSM and other sources; its machine-estimated footprints and heights can be inaccurate. Deduplication is conservative and may omit or duplicate features where the datasets disagree.
- Overture's current release is discovered through its catalog. The game reads its publicly hosted experimental PMTiles directly, with browser modules from esm.sh; no account or API key is needed. If either is unavailable, the game reports the problem and uses OSM alone. If OSM is unavailable, available Overture buildings and roads are used, but mapped vegetation is unavailable.
- Each roof has a single colour estimated from satellite pixels inside its footprint; an explicit OSM `roof:colour` takes precedence. The sampler avoids footprint edges, likely vegetation and deep shadows. Without enough usable pixels, or when vegetation dominates, roofs use a generic colour.
- OSM `roof:shape` supports flat, pyramidal, gabled, hipped, skillion and dome roofs; `roof:height`, `roof:levels`, `roof:orientation` and cardinal or numeric `roof:direction` inform supported pitched roofs. The mapped building height remains the roof's highest point. If no shape is tagged, small low-rise buildings get an estimated pyramid, or an approximate gable for a concave outline; larger buildings and mapped apartment or commercial blocks stay flat.
- Trees use several procedurally shaped, textured broadleaf and conifer crowns, with varied sizes and colours. They are approximations, not identified species.
- Ground-level paved roads are rendered with procedural asphalt over the satellite terrain. Connected segments get terrain-following junctions. Widths come from `width`, `width:carriageway`, or `lanes` tags; otherwise they are estimates by road type. For local roads with consistently paired building walls, a conservative estimate accounts for sidewalk space and clearance. Mapped buildings are retained and road triangles that touch their footprints are omitted; tree canopies and grass patches are kept clear of roads and junctions.
- Sidewalks use the underlying imagery on slightly raised strips. Mapped sidewalk tags and sidewalk footways are used anywhere; additional strips are estimated along untagged urban streets using mapped land use or nearby building density. Mapped street lamps are shown, with additional lamps estimated along sidewalk strips. These are visual approximations, not reliable surveys; lamps do not illuminate the world.
- OSM bridge roads use a smoothly interpolated, estimated deck above the terrain. Decks can be walked onto at their ends and crossed, while the ground below remains accessible. The DEM and ordinary OSM bridge tags do not establish actual deck heights or clearances.
- Area loading tries each Overpass mirror once with a bounded wait, and retries satellite zoom levels only once each. If re-centering lands inside a building, a nearby unobstructed spawn is chosen; failed automatic loads wait before retrying.
- Grass patches are scattered in mapped vegetation areas and, when satellite and OSM data are available, green-looking imagery. This is an approximation, not an exact vegetation survey; buildings and roads missing from OSM cannot be excluded.
- Satellite tiles are requested up to zoom 19, subject to the GPU texture limit and provider coverage. Esri's no-data placeholder is rejected, and the app retries lower-resolution satellite tiles before falling back to map tiles. Actual image detail varies by location.
- Buildings are solid (footprint collision); the ground is followed exactly.
- Menu radius goes up to 6000 m. Above 2000 m the terrain grid coarsens (radius/400 m cells), the tree cap triples, and the far plane is 9000 m. This uses much more GPU, memory and data, loads slowly, and the single satellite texture is lower resolution per metre.
- Tunables: `src/config.js` (radius, texture/DEM zoom, tree cap, data endpoints).

## Known limits / next steps

- Public Overpass servers are shared and can be slow or busy; the game retries other mirrors and falls back to Overture for available buildings and roads (press **Reload here** to retry). Point `CONFIG.sources.overpass` at your own instance for reliability.
- Overture's inspection tiles are not a production service and can change or disappear without notice. Features crossing tile edges are omitted rather than generating clipped, incomplete buildings or roads. Bridge, tunnel and unpaved Overture roads remain excluded. For reliable production use, generate and host your own data from an Overture release.
- Sidewalk inference can miss or invent sidewalks and lamps; imagery may be shadowed, offset, or contain traffic. OSM is required for mapped sidewalks, lamps and bridges. Overture-only bridge data, tunnels, unpaved ways and road areas are not rendered. Bridge heights are guesses, not surveyed clearances; steep terrain, intersections and overlapping decks may be inaccurate. Junctions are approximations, not surveyed intersection polygons. Building-wall widths can be wrong when buildings are set back or mapping is incomplete. Imagery and map data can differ in age or alignment, and unmapped roads cannot be protected from vegetation.
- Roof shapes are approximate: pyramids and domes require convex footprints without holes. Gabled, hipped and skillion roofs also support some concave footprints using planar approximations. Roofs with courtyards, unsupported mapped shapes, or unsuitable complex geometry fall back to flat; the browser console reports unsupported mapped roofs. Untagged buildings can be misclassified. Estimated roof colours can be wrong if imagery is offset, shadowed or obscured; green roofs may be mistaken for vegetation. Terrain elevation does not provide roof heights.
- Not yet included: water meshes, clouds as geometry, building interiors, mobile touch controls, tile-streaming instead of re-centring.
- Respect each provider's terms and attribution (shown at the bottom of the screen). For production use, get your own keys/hosting for imagery and geocoding.

## Third-party notice

The roof colour vegetation test was adapted from [BeamNG.Earth](https://github.com/TecnaGamer/BeamNG.Earth), which is licensed as follows:

MIT License

Copyright (c) 2026 TecnaGamer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
