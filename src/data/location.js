export async function searchPlaces(url, query, signal) {
  const q = new URLSearchParams({ format: 'jsonv2', limit: '6', q: query, 'accept-language': navigator.language || 'en' });
  const res = await fetch(`${url}?${q}`, { signal });
  if (!res.ok) throw new Error('Geocoder HTTP ' + res.status);
  return (await res.json()).map((r) => ({ name: r.display_name, lat: +r.lat, lon: +r.lon }));
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.message || 'Location denied')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
  });
}

// Continuous GPS (for "walk in real life" mode). Returns a stop function.
export function watchPosition(onFix, onError) {
  if (!navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
    (e) => onError?.(new Error(e.message)),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
