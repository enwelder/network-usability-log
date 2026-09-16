// Battery temperature and charge from a sysdiagnose powerlog, for rounds to carry beside their
// measurements. iOS ships no per-component thermal reading: the sensor and thermal-level tables
// exist in the database and stay empty, so the battery is the only temperature available, and a
// thermal state is visible only as its absence.
import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

// The database stamps rows on a clock of its own; this table carries the offset to wall time.
const OFFSET_QUERY = 'SELECT system FROM PLStorageOperator_EventForward_TimeOffset ' +
                     'ORDER BY timestamp DESC LIMIT 1;';
const BATTERY_QUERY = 'SELECT timestamp, Temperature, Level FROM ' +
                      'PLBatteryAgent_EventBackward_Battery ORDER BY timestamp;';

// Samples land roughly every 30 s; beyond this a round is left without a reading rather than
// carrying one measured somewhere else.
export const MAX_AGE_MS = 120000;

// Some builds write centidegrees where others write degrees. No phone battery runs at 100 °C, so
// the larger scale is unambiguous.
const degrees = raw => (raw > 100 ? raw / 100 : raw);

// `sqlite3 -separator` output, one row per line. A row without a temperature is dropped: the
// column is null while the gauge is still reading.
export function parseBattery(text, offsetS) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [ts, temp, level] = line.split('|');
    const t = Number(ts), c = Number(temp);
    if (!Number.isFinite(t) || !Number.isFinite(c) || temp === '') continue;
    out.push({t: Math.round((t + offsetS) * 1000), temp_c: Math.round(degrees(c) * 10) / 10,
              level: level === '' ? null : Number(level)});
  }
  return out;
}

// The reading closest in time, or null when the nearest one is further off than `maxAgeMs`.
// Samples are sorted, so the walk stops as soon as it passes the round.
export function nearestReading(samples, t, maxAgeMs = MAX_AGE_MS) {
  let best = null, closest = Infinity;
  for (const s of samples) {
    const away = Math.abs(s.t - t);
    if (away < closest) { closest = away; best = s; }
    else if (s.t > t) break;
  }
  return best && closest <= maxAgeMs ? {...best, age_ms: closest} : null;
}

const sqlite = (db, query) =>
  execFileSync('sqlite3', ['-readonly', '-separator', '|', db, query],
               {encoding: 'utf8', maxBuffer: 1 << 28});

// The newest powerlog in an unpacked sysdiagnose. A bundle unpacked without it, or an archive that
// held none, yields null and the rounds carry no battery reading.
export function powerlogIn(root) {
  const dir = join(root, 'logs', 'powerlogs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /^powerlog_.*\.PLSQL$/.test(f)).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}

// Every battery reading the powerlog holds, in wall-clock milliseconds. Returns null when the
// archive carries no powerlog, and throws only when one is there and unreadable.
export function readBattery(root) {
  const db = powerlogIn(root);
  if (!db) return null;
  const offset = Number(sqlite(db, OFFSET_QUERY).trim());
  if (!Number.isFinite(offset)) throw new Error(`${db}: no time offset`);
  const samples = parseBattery(sqlite(db, BATTERY_QUERY), offset);
  return {samples, source: db, offset_s: offset};
}
