// Live weather from Open-Meteo (free, no key) + helpers that turn it into rendering parameters.

export async function fetchWeather(url, lat, lon, signal) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', wind_speed_unit: 'ms',
    current: 'temperature_2m,is_day,precipitation,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility',
  });
  const res = await fetch(`${url}?${q}`, { signal });
  if (!res.ok) throw new Error('Weather HTTP ' + res.status);
  const j = await res.json();
  const c = j.current;
  return {
    code: c.weather_code, temp: c.temperature_2m, cloud: c.cloud_cover, precip: c.precipitation,
    snowfall: c.snowfall, windSpeed: c.wind_speed_10m, windDir: c.wind_direction_10m,
    visibility: c.visibility, utcOffset: j.utc_offset_seconds ?? 0, source: 'Open-Meteo',
  };
}

// Manual overrides from the menu (wind/cloud are tuned per preset).
export const WEATHER_PRESETS = {
  clear: { code: 0, cloud: 5, precip: 0, snowfall: 0, windSpeed: 2, windDir: 270, visibility: 40000, temp: 20 },
  cloudy: { code: 3, cloud: 100, precip: 0, snowfall: 0, windSpeed: 4, windDir: 270, visibility: 20000, temp: 14 },
  fog: { code: 45, cloud: 100, precip: 0, snowfall: 0, windSpeed: 1, windDir: 270, visibility: 120, temp: 6 },
  rain: { code: 63, cloud: 95, precip: 3, snowfall: 0, windSpeed: 5, windDir: 250, visibility: 6000, temp: 11 },
  snow: { code: 73, cloud: 95, precip: 0, snowfall: 1, windSpeed: 2, windDir: 300, visibility: 2000, temp: -3 },
  storm: { code: 95, cloud: 100, precip: 9, snowfall: 0, windSpeed: 12, windDir: 230, visibility: 3000, temp: 17 },
};

export function describeWeather(code) {
  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Unknown';
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// -> { cloud 0..1, rain 0..1, snow 0..1, fogFar metres, wind: {x, z} m/s (direction it blows towards) }
export function weatherToEffects(w, maxView) {
  const code = w.code;
  const isSnow = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const isRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const rain = isRain ? clamp01(0.25 + w.precip / 5 + (code === 65 || code === 82 || code >= 95 ? 0.3 : 0)) : 0;
  const snow = isSnow ? clamp01(0.3 + w.snowfall / 1.5) : 0;

  let view = maxView * 0.95;
  if (w.visibility > 0) view = Math.min(view, Math.max(60, w.visibility * 0.9));
  if (code === 45 || code === 48) view = Math.min(view, 140);
  view *= 1 - 0.45 * Math.max(rain, snow);

  const toward = ((w.windDir + 180) * Math.PI) / 180; // wind direction is where it comes FROM
  return {
    cloud: clamp01(w.cloud / 100), rain, snow, fogFar: view,
    thunder: code >= 95,
    wind: { x: Math.sin(toward) * w.windSpeed, z: -Math.cos(toward) * w.windSpeed },
  };
}
