// Facts per ride, for comparing rides and locating trouble without the raw rounds: counts, shares,
// percentiles and stretches named by place. Places appear as a name and a distance, never as
// coordinates.
// js/grade.js is imported before js/export.js: the two import each other, and loading export.js
// first leaves grade.js reading countsAsFailure before export.js has defined it.
import {ACTIVITIES, ACTIVITY_IDS, GRADES, SCALES, roundTripFailed} from '../js/grade.js';
import {quantile, summarise} from '../js/export.js';
import {PLACE_MAX_M, nearestPlace} from './places.mjs';
import {BAND_MHZ, FIX_MAX_ACCURACY_M, FIX_MAX_AGE_MS, fixAt, fixOf, is5g, isAnyRed, isRated, pairRounds,
        routeMs, routePoints, zonedClock, zonedDate} from './ride.mjs';

export const SUMMARY_FORMAT = 'nulog/ride-summary';
const MIN = 60000;
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));
const LETTER = {green: 'g', yellow: 'y', orange: 'o', red: 'r'};

const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const share = (n, of) => (of ? Math.round((n / of) * 1000) / 1000 : null);
const mbps = bps => (bps == null ? null : Math.round(bps / 1e4) / 100);
const pct = (values, q) => quantile(values.filter(v => v != null).sort((a, b) => a - b), q);
const ran = samples => samples.filter(s => !s.skipped && !s.round_error && !s.interrupted);
const worst = grades => grades.filter(Boolean).reduce((a, g) => (a == null || RANK[g] > RANK[a] ? g : a), null);
const mostCommon = values => {
  const counts = {};
  for (const v of values) if (v != null) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const sharesOf = (rows, keyOf) => {
  const counts = {};
  for (const r of rows) {
    const k = keyOf(r) ?? 'unknown';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, share(n, rows.length)]));
};

// Consecutive items meeting the predicate. A gap over 1.5 intervals ends a run: the ride went on
// with no round there.
function runsOf(items, pred, intervalMs, tOf = x => x.t) {
  const runs = [];
  let current = null;
  let prevT = null;
  for (const item of items) {
    const t = tOf(item);
    if (pred(item) && current && t - prevT <= 1.5 * intervalMs) current.push(item);
    else if (pred(item)) runs.push(current = [item]);
    else current = null;
    prevT = t;
  }
  return runs;
}

const minIntervalOf = ride => Math.min(...ride.tracks.map(k => k.interval_ms));
const placeNear = (ride, t, places) => nearestPlace(places, fixAt(ride.tracks, t, minIntervalOf(ride)));

function span(ride, firstT, lastT, intervalMs, places) {
  const end = lastT + intervalMs;
  return {
    from_clock: zonedClock(firstT, ride.timezone, true), to_clock: zonedClock(end, ride.timezone, true),
    from_min: round1((firstT - ride.t0) / MIN), to_min: round1((end - ride.t0) / MIN),
    from_place: placeNear(ride, firstT, places), to_place: placeNear(ride, lastT, places)
  };
}

const redByActivity = rounds =>
  Object.fromEntries(ACTIVITY_IDS.map(id => [id, rounds.filter(r => r.grades?.[id] === 'red').length]));

function stretchRadio(rounds) {
  if (!rounds.some(r => r.radio)) return null;
  const covered = rounds.filter(r => r.radio && r.radio.coverage !== 'none');
  return {
    rat: sharesOf(covered, r => r.radio.rat),
    bands: [...new Set(covered.map(r => r.radio.cell?.band).filter(b => b != null))].sort((a, b) => a - b),
    lte_rsrp_dbm_p50: pct(covered.map(r => r.radio.lte?.rsrp.med), 0.5),
    cell_changes: covered.reduce((n, r) => n + (r.radio.cell_changes || 0), 0),
    stall_rounds: covered.filter(r => r.radio.stalls?.some(s => s[1])).length,
    coverage_none: rounds.filter(r => r.radio?.coverage === 'none').length
  };
}

export function radioTotals(samples, recordedMin) {
  const withRadio = samples.filter(s => s.radio);
  if (!withRadio.length) return null;
  const covered = withRadio.filter(s => s.radio.coverage !== 'none');
  const coverage = {full: 0, partial: 0, none: 0};
  for (const s of withRadio) coverage[s.radio.coverage] = (coverage[s.radio.coverage] || 0) + 1;
  const inRounds = covered.reduce((n, s) => n + (s.radio.cell_changes || 0), 0);
  const between = covered.filter(s => s.radio.cell_changed_since_previous).length;
  return {
    rounds: withRadio.length, coverage,
    share_5g: share(covered.filter(s => is5g(s.radio)).length, covered.length),
    rat_share: sharesOf(covered, s => s.radio.rat),
    band_share: sharesOf(covered, s => s.radio.cell?.band),
    nr_cell_rounds: covered.filter(s => s.radio.nr_cell).length,
    lte_rsrp_dbm: {p10: pct(covered.map(s => s.radio.lte?.rsrp.med), 0.1),
                   p50: pct(covered.map(s => s.radio.lte?.rsrp.med), 0.5)},
    lte_snr_db: {p10: pct(covered.map(s => s.radio.lte?.snr.med), 0.1),
                 p50: pct(covered.map(s => s.radio.lte?.snr.med), 0.5)},
    nr_rsrp_dbm: {p50: pct(covered.map(s => s.radio.nr?.rsrp.med), 0.5)},
    cell_changes_in_rounds: inRounds, cell_changes_between_rounds: between,
    cell_changes_per_hour: recordedMin ? round1(((inRounds + between) * 60) / recordedMin) : null,
    stall_rounds: covered.filter(s => s.radio.stalls?.some(x => x[1])).length
  };
}

const rateTotals = (p, sumFails) => ({
  rated: p.rated, p10_mbps: mbps(p.bps_p10), p50_mbps: mbps(p.bps_p50),
  saturated: p.saturated, failed: sumFails(p.fails)
});

export function trackTotals(track, ride) {
  const s = summarise(track.samples, track.events);
  const interval = track.interval_ms;
  const rated = track.samples.filter(isRated);
  const recordedMin = round1((track.samples.at(-1).t - track.samples[0].t + interval) / MIN);
  const sumFails = fails => Object.values(fails || {}).reduce((a, n) => a + n, 0);

  const activities = {};
  for (const id of ACTIVITY_IDS) {
    const counts = Object.fromEntries(GRADES.map(g => [g, 0]));
    for (const r of rated) if (r.grades[id]) counts[r.grades[id]]++;
    const n = GRADES.reduce((a, g) => a + counts[g], 0);
    const longest = runsOf(track.samples, r => isRated(r) && r.grades[id] === 'red', interval)
      .sort((a, b) => b.length - a.length)[0];
    activities[id] = {
      label: ACTIVITIES[id].label, rated: n, unrated: rated.length - n, counts,
      shares: Object.fromEntries(GRADES.map(g => [g, share(counts[g], n)])),
      red_min: round1((counts.red * interval) / MIN),
      longest_red_run: longest
        ? {rounds: longest.length, minutes: round1((longest.length * interval) / MIN),
           from_clock: zonedClock(longest[0].t, ride.timezone, true)}
        : null
    };
  }
  const anyRed = rated.filter(isAnyRed).length;
  const measured = ran(track.samples);
  return {
    rounds: {
      recorded_min: recordedMin, rounds: s.rounds, ran: s.ran, slots: s.slots, skipped: s.skipped,
      interrupted: s.interrupted, round_errors: s.round_errors, paused_rounds: s.in_pause,
      wake_lock_lost: s.wake_lock_lost,
      gap_min: round1(track.gaps.reduce((n, g) => n + g.to_t - g.from_t, 0) / MIN)
    },
    activities,
    any_red: {rounds: anyRed, share: share(anyRed, rated.length), minutes: round1((anyRed * interval) / MIN)},
    download: rateTotals(s.probes.down, sumFails),
    upload: rateTotals(s.probes.up, sumFails),
    round_trip: {
      n: measured.filter(r => routeMs(r.probes) != null).length,
      p50_ms: pct(measured.map(r => routeMs(r.probes)), 0.5),
      p90_ms: pct(measured.map(r => routeMs(r.probes)), 0.9),
      failed: measured.filter(r => roundTripFailed(r.probes || {})).length
    },
    new_host: {p50_ms: s.probes.dns.ms_p50, p90_ms: s.probes.dns.ms_p90},
    failures: Object.fromEntries(Object.entries(s.probes)
      .filter(([, p]) => sumFails(p.fails) > 0).map(([id, p]) => [id, p.fails])),
    radio: radioTotals(track.samples, recordedMin)
  };
}

export const redStretches = (track, ride, places = []) =>
  runsOf(track.samples, isAnyRed, track.interval_ms).map(run => ({
    ...span(ride, run[0].t, run.at(-1).t, track.interval_ms, places),
    rounds: run.length, red_by_activity: redByActivity(run), radio: stretchRadio(run)
  }));

export function pairedTotals(ride, places = []) {
  if (ride.tracks.length !== 2) return null;
  const [a, b] = ride.tracks;
  const interval = Math.max(a.interval_ms, b.interval_ms);
  const pairs = pairRounds(a.samples.filter(isRated), b.samples.filter(isRated), interval / 2);
  const activities = {};
  for (const id of ACTIVITY_IDS) {
    const c = {both_rated: 0, same: 0, lower: {[a.label]: 0, [b.label]: 0}, both_red: 0,
               red_only: {[a.label]: 0, [b.label]: 0}};
    for (const [ra, rb] of pairs) {
      const ga = ra.grades[id];
      const gb = rb.grades[id];
      if (!ga || !gb) continue;
      c.both_rated++;
      if (RANK[ga] === RANK[gb]) c.same++;
      else c.lower[RANK[ga] > RANK[gb] ? a.label : b.label]++;
      if (ga === 'red' && gb === 'red') c.both_red++;
      else if (ga === 'red') c.red_only[a.label]++;
      else if (gb === 'red') c.red_only[b.label]++;
    }
    activities[id] = c;
  }
  const both = ([ra, rb]) => isAnyRed(ra) && isAnyRed(rb);
  return {
    tracks: [a.label, b.label], tolerance_ms: interval / 2, pairs: pairs.length,
    from_clock: pairs.length ? zonedClock(pairs[0][0].t, ride.timezone, true) : null,
    to_clock: pairs.length ? zonedClock(pairs.at(-1)[0].t, ride.timezone, true) : null,
    activities,
    any_red: {
      [a.label]: pairs.filter(([ra]) => isAnyRed(ra)).length,
      [b.label]: pairs.filter(([, rb]) => isAnyRed(rb)).length,
      both: pairs.filter(both).length, neither: pairs.filter(([ra, rb]) => !isAnyRed(ra) && !isAnyRed(rb)).length
    },
    both_red_stretches: runsOf(pairs, both, interval, p => p[0].t).map(run => ({
      ...span(ride, run[0][0].t, run.at(-1)[0].t, interval, places),
      pairs: run.length,
      red_by_activity: {[a.label]: redByActivity(run.map(p => p[0])), [b.label]: redByActivity(run.map(p => p[1]))},
      radio: {[a.label]: stretchRadio(run.map(p => p[0])), [b.label]: stretchRadio(run.map(p => p[1]))}
    }))
  };
}

export function minuteTable(ride, places = []) {
  const rows = [];
  for (let m = 0; ride.t0 + m * MIN < ride.t1; m++) {
    const from = ride.t0 + m * MIN;
    const row = {min: m, clock: zonedClock(from, ride.timezone),
                 place: nearestPlace(places, fixAt(ride.tracks, from + MIN / 2, MIN / 2))};
    for (const k of ride.tracks) {
      const rounds = k.samples.filter(s => s.t >= from && s.t < from + MIN);
      const measured = ran(rounds);
      row[k.label] = rounds.length ? {
        rounds: rounds.length, rated: rounds.filter(isRated).length, red: rounds.filter(isAnyRed).length,
        grades: ACTIVITY_IDS.map(id => LETTER[worst(rounds.filter(isRated).map(r => r.grades[id]))] ?? '-').join(''),
        dl_p50_mbps: mbps(pct(measured.map(r => (r.probes?.down?.ok ? r.probes.down.bps : null)), 0.5)),
        rtt_p50_ms: pct(measured.map(r => routeMs(r.probes)), 0.5),
        lte_rsrp_dbm: pct(rounds.map(r => r.radio?.lte?.rsrp.med), 0.5),
        rat: mostCommon(rounds.map(r => r.radio?.rat))
      } : null;
    }
    rows.push(row);
  }
  return rows;
}

export const DEFINITIONS = {
  rated_round: 'a round with grades that the page did not interrupt',
  red_round: 'a rated round with at least one activity graded red',
  stretch: 'consecutive red rounds of one track; a round that is not red, or more than 1.5 intervals ' +
           'without a round, ends it',
  pairing: 'each rated round of one track with the nearest rated round of the other within tolerance_ms, ' +
           'one to one, closest pairs first',
  lower: "per track, the pairs in which that track's grade lies further toward red than the other's",
  red_only: 'per track, the pairs in which only that track is red',
  connection_5g: 'a round whose RAT reads kENDC, or that measured NR signal',
  lte_band_mhz: BAND_MHZ,
  fix: {max_accuracy_m: FIX_MAX_ACCURACY_M, max_age_ms: FIX_MAX_AGE_MS,
        choice: 'the sharpest fresh fix of any track near the moment'},
  place_max_m: PLACE_MAX_M,
  percentile: 'nearest rank',
  rates: 'Mbit/s; each rate is a lower bound, and a saturated round reached the byte cap',
  round_trip: 'the IPv6 literal, else the IPv4 literal: the round trip the voice grade reads',
  new_host: 'the dns probe: lookup, connect and TLS to an uncontacted host, graded on the ttfb scale',
  radio_values: "each round's median over its baseband samples",
  minutes: 'grades holds the worst grade per activity in that minute, g y o r, or - when unrated',
  grade_scales: SCALES,
  activities: Object.fromEntries(ACTIVITY_IDS.map(id => [id, ACTIVITIES[id].label]))
};

export function rideTitle(ride, from, to) {
  const named = [...new Set(ride.tracks.flatMap(k => k.sessions.filter(s => s.renamed).map(s => s.name)))];
  const route = from && to ? `${from.name} → ${to.name}` : 'route unknown';
  return [...named, route].join(' · ');
}

export function rideSummary(ride, {places = [], placesSource = null, inputs = [], generated = null} = {}) {
  const tz = ride.timezone;
  const points = routePoints(ride.tracks);
  const from = nearestPlace(places, points[0]);
  const to = nearestPlace(places, points.at(-1));
  return {
    format: SUMMARY_FORMAT, version: 1, generated, generated_by: 'tools/ride-chart.mjs',
    ride: {
      id: ride.id, title: rideTitle(ride, from, to), timezone: tz, date: zonedDate(ride.t0, tz),
      start_clock: zonedClock(ride.t0, tz, true), end_clock: zonedClock(ride.t1, tz, true),
      start_iso: new Date(ride.t0).toISOString(), end_iso: new Date(ride.t1).toISOString(),
      duration_min: round1((ride.t1 - ride.t0) / MIN),
      from_place: from, to_place: to, places_source: placesSource,
      usable_fix_share: Object.fromEntries(ride.tracks.map(k =>
        [k.label, share(k.samples.filter(fixOf).length, k.samples.length)]))
    },
    definitions: DEFINITIONS,
    inputs,
    tracks: ride.tracks.map(k => ({
      label: k.label, operator: k.operator, connection: k.connection, screen: k.screen, device: k.device,
      ios_version: k.ios_version, ios_build: k.ios_build, plmn: k.plmn, interval_ms: k.interval_ms,
      sessions: k.sessions.map(s => ({
        id: s.id, name: s.name, renamed: s.renamed, file: s.file, rounds: s.rounds,
        start_clock: zonedClock(s.first_t, tz, true), end_clock: zonedClock(s.last_t, tz, true)
      })),
      joins: k.joins.map(j => ({at_clock: zonedClock(j.t, tz, true), gap_s: j.gap_s})),
      gaps: k.gaps.map(g => ({
        from_clock: zonedClock(g.from_t, tz, true), to_clock: zonedClock(g.to_t, tz, true),
        from_min: round1((g.from_t - ride.t0) / MIN), minutes: round1((g.to_t - g.from_t) / MIN), kind: g.kind
      })),
      totals: trackTotals(k, ride),
      stretches: redStretches(k, ride, places)
    })),
    paired: pairedTotals(ride, places),
    minutes: minuteTable(ride, places)
  };
}
