// Names the nearest known place to a position, from a list of [name, lat, lon] tuples.
import {metresBetween} from '../js/position.js';

// A position further than this from every listed place stays unnamed.
export const PLACE_MAX_M = 3000;

export function validatePlaces(doc) {
  const list = Array.isArray(doc) ? doc : doc?.places;
  if (!Array.isArray(list)) throw new Error('places: expected an array or {places: [...]}');
  list.forEach((p, i) => {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || !Number.isFinite(p[1]) ||
        !Number.isFinite(p[2])) {
      throw new Error(`places[${i}]: expected [name, lat, lon]`);
    }
  });
  return list;
}

export function nearestPlace(places, point, maxM = PLACE_MAX_M) {
  if (!point) return null;
  let best = null;
  for (const [name, lat, lon] of places) {
    const d = metresBetween(point, {lat, lon});
    if (d <= maxM && (!best || d < best.d)) best = {name, d};
  }
  return best && {name: best.name, distance_m: Math.round(best.d)};
}

export const rideEnds = (points, places, maxM = PLACE_MAX_M) => ({
  from: nearestPlace(places, points[0], maxM),
  to: nearestPlace(places, points.at(-1), maxM)
});
