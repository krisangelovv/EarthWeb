// Central configuration. Everything here can be changed without touching the rest of the code.
export const CONFIG = {
  // Fallback spawn point (used when there is no ?lat=&lon= in the URL and nothing saved).
  defaultPlace: { name: 'Sofia, Bulgaria', lat: 42.6977, lon: 23.3219 },

  radius: 2000,            // metres of world generated around the player
  reloadFraction: 0.55,   // re-centre the world when the player gets this far (fraction of radius) from its centre
  terrainStep: 5,         // metres per terrain grid cell
  terrainZoom: 14,        // Terrarium DEM zoom (14 ≈ 9.5 m/px at the equator)
  imageryZoom: 19,        // preferred satellite zoom; lowered to fit the GPU texture limit
  maxTreeCount: 50000,

  player: { eyeHeight: 1.7, walk: 3.2, sprint: 7.5, fly: 40, jump: 5.5, gravity: 18, radius: 0.4 },

  sources: {
    // Satellite imagery. {z}/{y}/{x} are slippy-map tile coordinates.
    imagery: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Fallback if the satellite tiles cannot be fetched.
    imageryFallback: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    // Elevation: Mapzen/AWS Terrain Tiles (Terrarium encoding), global, no key.
    terrarium: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    // OpenStreetMap data (buildings, heights, trees, forests, parks). Tried in order.
    overpass: [
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ],
    weather: 'https://api.open-meteo.com/v1/forecast',
    geocode: 'https://nominatim.openstreetmap.org/search',
  },
};
