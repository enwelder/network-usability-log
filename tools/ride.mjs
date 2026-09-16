// Rides gathered from session exports, bundles and radio-joined files: sessions recorded together
// become one ride, and each phone within it one track. Pure; tools/ride-chart.mjs does the I/O.
import {basename} from 'node:path';
import {MAX_PLAUSIBLE_MS, metresBetween} from '../js/position.js';

const KINDS = {'nulog/session+radio': 'radio', 'nulog/session': 'session', 'nulog/bundle': 'bundle'};
// A radio-joined file carries everything a plain export of the same session does.
const PREFERENCE = {radio: 0, session: 1, bundle: 2};
const DEFAULT_INTERVAL_MS = 20000;

// Fewer rounds than this cover no stretch of a ride.
export const MIN_ROUNDS = 3;
export const FIX_MAX_ACCURACY_M = 500;
// Inside a tunnel the last fix is repeated with a growing age; past this it no longer places a round.
export const FIX_MAX_AGE_MS = 30000;
// Past this, two fixes would be joined by a line across ground the ride may not have covered.
export const ROUTE_MAX_GAP_MS = 120000;

export const intervalOf = e => e.session.intervalMs ?? DEFAULT_INTERVAL_MS;

export function readInput(doc, file) {
  const kind = KINDS[doc?.format];
  if (!kind) return [];
  const parts = kind === 'bundle' ? doc.sessions || [] : [doc];
  return parts.filter(p => p?.session && Array.isArray(p.samples) && p.samples.length).map(p => ({
    kind, file, format: doc.format, joined: doc.joined ?? null,
    session: p.session,
    samples: [...p.samples].sort((a, b) => a.t - b.t),
    events: [...(p.events || [])].sort((a, b) => a.t - b.t)
  }));
}

export function dedupeSessions(entries) {
  const byId = new Map();
  for (const e of entries) byId.set(e.session.id, [...(byId.get(e.session.id) || []), e]);
  const kept = [];
  const dropped = [];
  for (const [id, list] of byId) {
    list.sort((a, b) => PREFERENCE[a.kind] - PREFERENCE[b.kind] ||
                        String(b.joined ?? '').localeCompare(String(a.joined ?? '')));
    kept.push(list[0]);
    for (const d of list.slice(1)) {
      dropped.push({file: basename(d.file), format: d.format, session_id: id, used: false,
                    reason: `same session as ${basename(list[0].file)}`});
    }
  }
  return {kept, dropped};
}

const windowOf = e => [e.samples[0].t, e.samples.at(-1).t + intervalOf(e)];

// Sessions whose windows overlap, or follow within the larger interval, were recorded together.
export function groupRides(entries) {
  const rides = [];
  for (const e of [...entries].sort((a, b) => windowOf(a)[0] - windowOf(b)[0])) {
    const [start, end] = windowOf(e);
    const ride = rides.at(-1);
    if (ride && start <= ride.end + Math.max(ride.interval, intervalOf(e))) {
      ride.entries.push(e);
      ride.end = Math.max(ride.end, end);
      ride.interval = Math.max(ride.interval, intervalOf(e));
    } else {
      rides.push({entries: [e], end, interval: intervalOf(e)});
    }
  }
  return rides.map(r => r.entries);
}

const gapEvent = (events, type, from, to) => events.some(e => e.type === type && e.t > from && e.t <= to);

// A gap is time between two rounds beyond the interval. A pause event is logged on resume, so it
// may land up to half an interval after the next round starts.
function gapsOf(samples, events, interval, sessionOf) {
  const gaps = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.t - a.t - interval <= interval / 2) continue;
    const to = b.t + interval / 2;
    const kind = sessionOf.get(a) !== sessionOf.get(b) ? 'join'
      : gapEvent(events, 'pause', a.t, to) ? 'pause'
      : gapEvent(events, 'skip', a.t, to) ? 'skip' : 'unknown';
    gaps.push({from_t: a.t + interval, to_t: b.t, kind});
  }
  return gaps;
}

function trackOf(group) {
  const first = group[0].session;
  const interval = Math.max(...group.map(intervalOf));
  const samples = group.flatMap(e => e.samples).sort((a, b) => a.t - b.t);
  const events = group.flatMap(e => e.events).sort((a, b) => a.t - b.t);
  const sessionOf = new Map(group.flatMap((e, i) => e.samples.map(s => [s, i])));
  const radio = group.find(e => e.kind === 'radio')?.session.radio ?? null;
  return {
    operator: first.operator ?? '', connection: first.connection ?? null,
    screen: first.environment?.screen ?? '', timezone: first.environment?.timezone ?? 'UTC',
    interval_ms: interval,
    ios_version: radio?.ios_version ?? null, ios_build: radio?.ios_build ?? null,
    device: radio?.device ?? null,
    plmn: radio?.plmn ?? null,
    has_radio: group.some(e => e.kind === 'radio'),
    sessions: group.map(e => ({
      id: e.session.id, name: e.session.name ?? null, renamed: !!e.session.renamed,
      file: basename(e.file), format: e.format, rounds: e.samples.length,
      first_t: e.samples[0].t, last_t: e.samples.at(-1).t
    })),
    joins: group.slice(1).map((e, i) => ({
      t: e.samples[0].t,
      gap_s: Math.max(0, Math.round((windowOf(e)[0] - windowOf(group[i])[1]) / 1000))
    })),
    gaps: gapsOf(samples, events, interval, sessionOf),
    samples, events
  };
}

// One track per operator and screen. A later session of the same phone continues its track when it
// starts after the earlier one's last round and within one interval of that round's end. A track is
// labelled by its operator, numbered when two tracks share one.
export function buildTracks(entries) {
  const groups = new Map();
  for (const e of [...entries].sort((a, b) => a.samples[0].t - b.samples[0].t)) {
    const key = `${e.session.operator ?? ''}|${e.session.environment?.screen ?? ''}`;
    const list = groups.get(key) || [];
    const prev = list.at(-1)?.at(-1);
    const continues = prev && e.samples[0].t >= prev.samples.at(-1).t &&
                      e.samples[0].t - windowOf(prev)[1] <= intervalOf(e);
    if (continues) list.at(-1).push(e);
    else list.push([e]);
    groups.set(key, list);
  }
  return [...groups.values()].flat().map(trackOf)
    .sort((a, b) => a.operator.localeCompare(b.operator) || a.screen.localeCompare(b.screen) ||
                    a.samples[0].t - b.samples[0].t)
    .map((t, _i, all) => {
      const name = t.operator || 'phone';
      const same = all.filter(o => (o.operator || 'phone') === name);
      return {...t, label: same.length > 1 ? `${name} ${same.indexOf(t) + 1}` : name};
    });
}

const partsOf = (t, timeZone) => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(t).map(p => [p.type, p.value]));

// Clock times follow the session's timezone, so a ride reads the same on any host.
export const zonedClock = (t, timeZone, seconds = false) => {
  const p = partsOf(t, timeZone);
  return seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
};
export const zonedDate = (t, timeZone) => {
  const p = partsOf(t, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
};
export const rideId = (t, timeZone) => {
  const p = partsOf(t, timeZone);
  return `nulog-ride-${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
};

export function buildRide(entries) {
  const tracks = buildTracks(entries);
  const t0 = Math.min(...tracks.map(k => k.samples[0].t));
  const t1 = Math.max(...tracks.map(k => {
    const last = k.samples.at(-1);
    return last.t + (last.round_ms ?? k.interval_ms);
  }));
  const timezone = tracks[0].timezone;
  return {id: rideId(t0, timezone), t0, t1, timezone, tracks, entries};
}

export function ridesFrom(inputs) {
  const ignored = [];
  const entries = [];
  for (const {file, doc} of inputs) {
    const found = readInput(doc, file);
    if (!found.length) {
      ignored.push({file: basename(file), format: doc?.format ?? null, session_id: null, used: false,
                    reason: 'holds no session with rounds'});
    }
    entries.push(...found);
  }
  const {kept, dropped} = dedupeSessions(entries);
  const usable = [];
  for (const e of kept) {
    if (e.samples.length >= MIN_ROUNDS) usable.push(e);
    else dropped.push({file: basename(e.file), format: e.format, session_id: e.session.id,
                       used: false, reason: `fewer than ${MIN_ROUNDS} rounds`});
  }
  return {rides: groupRides(usable).map(buildRide), ignored, dropped};
}

// The round trip the voice grade reads in js/grade.js: the IPv6 literal, else the IPv4 literal.
export const routeMs = p => (p?.ip6?.ok ? p.ip6.ms : p?.ip4?.ok ? p.ip4.ms : null);
// Downlink frequency of the LTE bands deployed in Europe, 3GPP TS 36.101 table 5.5-1.
export const BAND_MHZ = {1: 2100, 3: 1800, 7: 2600, 8: 900, 20: 800, 28: 700, 32: 1500, 38: 2600, 40: 2300,
                         42: 3500, 43: 3700};
// The RAT field lags the NR leg, so a round that measured NR signal counts as 5G as well.
export const is5g = radio => !!radio && (/^kENDC/.test(radio.rat || '') || !!radio.nr);
export const isRated = s => !!s?.grades && !s.interrupted;
export const isAnyRed = s => isRated(s) && Object.values(s.grades).includes('red');

// Nearest rounds within the tolerance, one to one, closest pairs first; rounds carry no shared grid,
// since each phone's phase moves after a pause.
export function pairRounds(a, b, toleranceMs) {
  const candidates = [];
  let from = 0;
  for (const ra of a) {
    while (from < b.length && b[from].t < ra.t - toleranceMs) from++;
    for (let j = from; j < b.length && b[j].t <= ra.t + toleranceMs; j++) {
      candidates.push([Math.abs(b[j].t - ra.t), ra, b[j]]);
    }
  }
  candidates.sort((x, y) => x[0] - y[0] || x[1].t - y[1].t);
  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  for (const [, ra, rb] of candidates) {
    if (usedA.has(ra) || usedB.has(rb)) continue;
    usedA.add(ra);
    usedB.add(rb);
    pairs.push([ra, rb]);
  }
  return pairs.sort((x, y) => x[0].t - y[0].t);
}

export function fixOf(r) {
  if (r?.lat == null || r.lon == null || r.accuracy == null || r.pos_t == null) return null;
  if (r.accuracy > FIX_MAX_ACCURACY_M || Math.abs(r.t - r.pos_t) > FIX_MAX_AGE_MS) return null;
  return {t: r.t, lat: r.lat, lon: r.lon, accuracy: r.accuracy, age_ms: r.t - r.pos_t};
}

export const bestFix = rounds => rounds.map(fixOf).filter(Boolean)
  .sort((a, b) => a.accuracy - b.accuracy || Math.abs(a.age_ms) - Math.abs(b.age_ms))[0] ?? null;

// The sharpest fresh fix any track holds near a moment: positions come from whichever phone
// placed itself best, which changes from ride to ride.
export const fixAt = (tracks, t, windowMs) =>
  bestFix(tracks.flatMap(k => k.samples.filter(s => Math.abs(s.t - t) <= windowMs)));

export function routePoints(tracks) {
  const bucketMs = Math.min(...tracks.map(k => k.interval_ms));
  const all = tracks.flatMap(k => k.samples.map(fixOf).filter(Boolean)).sort((a, b) => a.t - b.t);
  if (!all.length) return [];
  const best = new Map();
  for (const f of all) {
    const bucket = Math.floor((f.t - all[0].t) / bucketMs);
    if (!best.has(bucket) || f.accuracy < best.get(bucket).accuracy) best.set(bucket, f);
  }
  return [...best.values()].sort((a, b) => a.t - b.t);
}

export function routeSegments(points, maxGapMs = ROUTE_MAX_GAP_MS) {
  const segments = [];
  for (const p of points) {
    const prev = segments.at(-1)?.at(-1);
    const seconds = prev ? (p.t - prev.t) / 1000 : 0;
    const broken = !prev || p.t - prev.t > maxGapMs ||
                   (seconds > 0 && metresBetween(prev, p) / seconds > MAX_PLAUSIBLE_MS);
    if (broken) segments.push([p]);
    else segments.at(-1).push(p);
  }
  return segments;
}
