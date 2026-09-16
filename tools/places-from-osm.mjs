// Writes the station list tools/ride-chart.mjs names places from: every Dutch train, metro and
// light-rail station in OpenStreetMap, as [name, lat, lon] tuples.
//
//   node tools/places-from-osm.mjs [--out <file>]
//
// Needs network access; the chart reads the written file offline. Data © OpenStreetMap
// contributors, available under the Open Database License, which the file carries with it.
import {writeFileSync} from 'node:fs';
import {metresBetween} from '../js/position.js';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
// Overpass refuses a request without a User-Agent of its own with HTTP 406.
const USER_AGENT = 'nulog-places/1 (network usability log station list)';
const QUERY = `[out:json][timeout:180];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
(
  nwr["railway"~"^(station|halt)$"](area.nl);
  nwr["public_transport"="station"]["train"="yes"](area.nl);
  nwr["public_transport"="station"]["subway"="yes"](area.nl);
  nwr["public_transport"="station"]["light_rail"="yes"](area.nl);
);
out tags center;`;

// One station is often mapped twice, once for the train platforms and once for the metro.
const SAME_STATION_M = 300;
const round5 = n => Math.round(n * 1e5) / 1e5;

export function toPlaces(elements) {
  const places = [];
  for (const e of elements) {
    const name = e.tags?.name;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!name || lat == null || lon == null) continue;
    const point = {lat: round5(lat), lon: round5(lon)};
    const seen = places.some(([n, la, lo]) =>
      n === name && metresBetween({lat: la, lon: lo}, point) <= SAME_STATION_M);
    if (!seen) places.push([name, point.lat, point.lon]);
  }
  return places.sort((a, b) => a[0].localeCompare(b[0], 'nl') || a[1] - b[1]);
}

// One tuple per line, so a regenerated list diffs by station.
export const placesFile = (places, osmBase) =>
  `{\n"source": "© OpenStreetMap contributors, Open Database License (ODbL) 1.0",\n` +
  `"osm_base": ${JSON.stringify(osmBase ?? null)},\n"places": [\n` +
  `${places.map(p => JSON.stringify(p)).join(',\n')}\n]\n}\n`;

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i === -1 ? new URL('./places-nl.json', import.meta.url) : args[i + 1];
  if (i !== -1 && !out) {
    console.error('usage: node tools/places-from-osm.mjs [--out <file>]');
    process.exit(2);
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {'User-Agent': USER_AGENT, 'Accept': 'application/json'},
      body: new URLSearchParams({data: QUERY})
    });
    if (!res.ok) throw new Error(`Overpass answered HTTP ${res.status}`);
    const doc = await res.json();
    const places = toPlaces(doc.elements || []);
    writeFileSync(out, placesFile(places, doc.osm3s?.timestamp_osm_base));
    console.log(`${out instanceof URL ? out.pathname : out}: ${places.length} places, ` +
      `OpenStreetMap data as of ${doc.osm3s?.timestamp_osm_base ?? 'unknown'}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('places-from-osm.mjs')) await main();
