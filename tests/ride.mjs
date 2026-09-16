// The ride chart and summary: how sessions become rides and tracks, how two phones' rounds pair, the
// totals and stretches a reader compares rides by, and the chart layout. Rounds are written by hand.
import assert from 'node:assert';
import {suite} from './helpers.mjs';
import {bestFix, buildTracks, dedupeSessions, fixOf, groupRides, is5g, pairRounds, readInput, ridesFrom,
        routeSegments, zonedClock} from '../tools/ride.mjs';
import {pairedTotals, redStretches, rideSummary, thermalTotals, trackTotals} from '../tools/ride-summary.mjs';
import {nearestPlace, validatePlaces} from '../tools/places.mjs';
import {toPlaces} from '../tools/places-from-osm.mjs';
import {commonBreaks, esc, layout, renderSvg, timeTicks} from '../tools/ride-svg.mjs';
import {rideFileName} from '../tools/ride-chart.mjs';

const r = suite('ride');

// 18:13 in Amsterdam.
const AT = Date.parse('2026-09-15T16:13:00Z');
const GREEN = {voice: 'green', news: 'green', streaming: 'green'};
const RED = {voice: 'red', news: 'green', streaming: 'green'};
const probes = () => ({ip6: {ok: true, ms: 40}, dns: {ok: true, ms: 200}, down: {ok: true, bps: 20e6},
                       up: {ok: true, bps: 1e6}});
const round = (sessionId, seconds, over = {}) =>
  ({sessionId, seq: 0, t: AT + seconds * 1000, grades: GREEN, probes: probes(), ...over});
const rounds = (sessionId, fromS, count, over = () => ({})) =>
  Array.from({length: count}, (_, i) => round(sessionId, fromS + i * 20, {seq: i, ...over(i)}));
const doc = (id, operator, screen, samples, over = {}) => ({
  format: 'nulog/session',
  session: {id, name: `${operator} · 15 Sep 18:13`, operator, intervalMs: 20000,
            environment: {timezone: 'Europe/Amsterdam', screen}, ...over},
  samples, events: []
});
const ridesOf = (...docs) => ridesFrom(docs.map((d, i) => ({file: `in${i}.json`, doc: d})));
const entriesOf = (...docs) => docs.flatMap((d, i) => readInput(d, `in${i}.json`));
const oneRide = (...docs) => ridesOf(...docs).rides[0];

r.test('readInput MUST return every session of a bundle WHEN given a bundle document', () => {
  const bundle = {format: 'nulog/bundle', sessions: [doc('a', 'KPN', 's', rounds('a', 0, 3)),
                                                     doc('b', 'KPN', 's', rounds('b', 900, 3))]};
  assert.deepEqual(readInput(bundle, 'all.json').map(e => e.session.id), ['a', 'b']);
});

r.test('readInput MUST return no entries WHEN given a ride summary document', () => {
  assert.deepEqual(readInput({format: 'nulog/ride-summary', tracks: []}, 'x.json'), []);
});

r.test('dedupeSessions MUST keep the radio-joined copy WHEN a plain export carries the same session', () => {
  const plain = doc('a', 'KPN', 's', rounds('a', 0, 3));
  const {kept, dropped} = dedupeSessions(entriesOf(plain, {...plain, format: 'nulog/session+radio'}));
  assert.deepEqual([kept.length, kept[0].kind, dropped[0].reason], [1, 'radio', 'same session as in1.json']);
});

r.test('ridesFrom MUST drop a session WHEN it holds fewer than three rounds', () => {
  const {rides, dropped} = ridesOf(doc('a', 'KPN', 's', rounds('a', 0, 2)), doc('b', 'KPN', 's', rounds('b', 0, 3)));
  assert.deepEqual([rides.length, dropped[0].session_id, dropped[0].reason], [1, 'a', 'fewer than 3 rounds']);
});

r.test('groupRides MUST place sessions in one ride WHEN their rounds overlap in time', () => {
  const entries = entriesOf(doc('a', 'KPN', 's1', rounds('a', 0, 3)), doc('b', 'Odido', 's2', rounds('b', 10, 3)));
  assert.equal(groupRides(entries).length, 1);
});

r.test('groupRides MUST place sessions in separate rides WHEN one starts more than an interval after the other ends', () => {
  const entries = entriesOf(doc('a', 'KPN', 's1', rounds('a', 0, 3)), doc('b', 'Odido', 's2', rounds('b', 200, 3)));
  assert.equal(groupRides(entries).length, 2);
});

r.test('buildTracks MUST join two sessions into one track WHEN the same phone restarts within one interval', () => {
  const [track] = buildTracks(entriesOf(doc('a', 'KPN', 's', rounds('a', 0, 3)), doc('b', 'KPN', 's', rounds('b', 62, 3))));
  assert.deepEqual([track.sessions.length, track.joins[0].gap_s], [2, 2]);
});

r.test('buildTracks MUST keep two numbered tracks WHEN two phones on one operator record at the same time', () => {
  const tracks = buildTracks(entriesOf(doc('a', 'KPN', 's', rounds('a', 0, 3)), doc('b', 'KPN', 's', rounds('b', 5, 3))));
  assert.deepEqual(tracks.map(t => t.label), ['KPN 1', 'KPN 2']);
});

r.test('buildTracks MUST label a track by its operator WHEN no other track shares the operator', () => {
  const tracks = buildTracks(entriesOf(doc('a', 'Odido', 's1', rounds('a', 0, 3)), doc('b', 'KPN', 's2', rounds('b', 5, 3))));
  assert.deepEqual(tracks.map(t => t.label), ['KPN', 'Odido']);
});

r.test('buildTracks MUST mark a gap as pause WHEN a pause event falls between two rounds', () => {
  const d = doc('a', 'KPN', 's', [round('a', 0), round('a', 20), round('a', 240)]);
  d.events = [{type: 'pause', t: AT + 238000, text: '198.0s bridged'}];
  const [track] = buildTracks(entriesOf(d));
  assert.deepEqual(track.gaps.map(g => g.kind), ['pause']);
});

r.test('zonedClock MUST format in the session timezone WHEN the host runs in another zone', () => {
  assert.equal(zonedClock(AT, 'Europe/Amsterdam'), '18:13');
});

r.test('buildRide MUST name the ride by its local start minute WHEN built from a session', () => {
  assert.equal(oneRide(doc('a', 'KPN', 's', rounds('a', 0, 3))).id, 'nulog-ride-20260915-1813');
});

r.test('pairRounds MUST pair every round WHEN the two phases differ by 9 s', () => {
  assert.equal(pairRounds([{t: 0}, {t: 20000}], [{t: 9000}, {t: 29000}], 10000).length, 2);
});

r.test('pairRounds MUST leave a round unpaired WHEN the nearest counterpart is 11 s away', () => {
  assert.equal(pairRounds([{t: 0}], [{t: 11000}], 10000).length, 0);
});

r.test('pairRounds MUST match one to one WHEN two rounds fall near the same counterpart', () => {
  const pairs = pairRounds([{t: 0}, {t: 4000}], [{t: 2000}], 10000);
  assert.deepEqual(pairs.map(([a, b]) => [a.t, b.t]), [[0, 2000]]);
});

r.test('fixOf MUST return null WHEN the fix is more than 30 s older than the round', () => {
  assert.equal(fixOf({t: 60000, pos_t: 29000, lat: 52, lon: 4, accuracy: 10}), null);
});

r.test('bestFix MUST choose the sharper fix WHEN two fresh fixes differ in accuracy', () => {
  const fix = bestFix([{t: 0, pos_t: 0, lat: 52, lon: 4, accuracy: 400}, {t: 0, pos_t: 0, lat: 52.1, lon: 4, accuracy: 13}]);
  assert.equal(fix.accuracy, 13);
});

r.test('routeSegments MUST split the route WHEN two fixes imply a speed above the plausible maximum', () => {
  const segments = routeSegments([{t: 0, lat: 52, lon: 4}, {t: 10000, lat: 52.045, lon: 4}]);
  assert.equal(segments.length, 2);
});

r.test('nearestPlace MUST return null WHEN every place lies beyond the maximum distance', () => {
  assert.equal(nearestPlace([['X', 52, 4]], {lat: 53, lon: 4}), null);
});

r.test('nearestPlace MUST return the name and rounded distance WHEN a place lies within range', () => {
  assert.deepEqual(nearestPlace([['X', 52, 4]], {lat: 52.001, lon: 4}), {name: 'X', distance_m: 111});
});

r.test('validatePlaces MUST name the index WHEN an entry lacks a coordinate', () => {
  assert.throws(() => validatePlaces([['X', 52, 4], ['Y', 52]]), /places\[1\]/);
});

r.test('toPlaces MUST keep one entry WHEN a station is mapped twice within 300 m', () => {
  const places = toPlaces([{tags: {name: 'Delft'}, lat: 52.0067, lon: 4.3563},
                           {tags: {name: 'Delft'}, center: {lat: 52.0070, lon: 4.3565}},
                           {tags: {name: 'Delft Campus'}, lat: 51.9906, lon: 4.3692}]);
  assert.deepEqual(places.map(p => p[0]), ['Delft', 'Delft Campus']);
});

r.test('trackTotals MUST count red minutes as red rounds times the interval WHEN rounds are red', () => {
  const ride = oneRide(doc('a', 'KPN', 's', rounds('a', 0, 6, i => (i >= 1 && i <= 3 ? {grades: RED} : {}))));
  const totals = trackTotals(ride.tracks[0], ride);
  assert.deepEqual([totals.activities.voice.counts.red, totals.activities.voice.red_min], [3, 1]);
});

r.test('trackTotals MUST report the longest red run WHEN runs of different length occur', () => {
  const ride = oneRide(doc('a', 'KPN', 's', rounds('a', 0, 7, i => ([0, 1, 3, 4, 5].includes(i) ? {grades: RED} : {}))));
  assert.deepEqual(trackTotals(ride.tracks[0], ride).activities.voice.longest_red_run,
                   {rounds: 3, minutes: 1, from_clock: '18:14:00'});
});

r.test('redStretches MUST end a stretch WHEN no round arrives for more than 1.5 intervals', () => {
  const samples = [round('a', 0, {grades: RED}), round('a', 20, {grades: RED}), round('a', 100, {grades: RED})];
  const ride = oneRide(doc('a', 'KPN', 's', samples));
  assert.deepEqual(redStretches(ride.tracks[0], ride).map(s => s.rounds), [2, 1]);
});

r.test('redStretches MUST end a stretch WHEN an interrupted round follows a red round', () => {
  const samples = [round('a', 0, {grades: RED}), round('a', 20, {grades: null, interrupted: 'suspended'}),
                   round('a', 40, {grades: RED})];
  const ride = oneRide(doc('a', 'KPN', 's', samples));
  assert.deepEqual(redStretches(ride.tracks[0], ride).map(s => s.rounds), [1, 1]);
});

r.test('pairedTotals MUST count both, A-only and B-only red WHEN pairs mix red rounds', () => {
  const ride = oneRide(doc('a', 'KPN', 's1', rounds('a', 0, 4, i => (i <= 1 ? {grades: RED} : {}))),
                       doc('b', 'Odido', 's2', rounds('b', 3, 4, i => (i === 1 || i === 2 ? {grades: RED} : {}))));
  assert.deepEqual(pairedTotals(ride).any_red, {KPN: 2, Odido: 2, both: 1, neither: 1});
});

const positioned = i => ({lat: 52 + i * 0.001, lon: 4.3, accuracy: 10, pos_t: AT + (i * 20) * 1000});

r.test('rideSummary MUST carry no lat or lon key WHEN the rounds carry coordinates', () => {
  const ride = oneRide(doc('a', 'KPN', 's', rounds('a', 0, 4, positioned)));
  const keys = [];
  const walk = v => (Array.isArray(v) ? v.forEach(walk)
    : v && typeof v === 'object' ? Object.entries(v).forEach(([k, x]) => { keys.push(k); walk(x); }) : null);
  walk(rideSummary(ride, {places: [['Start', 52, 4.3]]}));
  assert.deepEqual(keys.filter(k => k === 'lat' || k === 'lon'), []);
});

r.test('rideSummary MUST name the start and end places WHEN fresh fixes lie near listed places', () => {
  const ride = oneRide(doc('a', 'KPN', 's', rounds('a', 0, 4, positioned)));
  const summary = rideSummary(ride, {places: [['Start', 52, 4.3], ['End', 52.003, 4.3]]});
  assert.deepEqual([summary.ride.from_place.name, summary.ride.to_place.name, summary.ride.title],
                   ['Start', 'End', 'Start → End']);
});

r.test('esc MUST escape markup WHEN text holds &, < and "', () => {
  assert.equal(esc('a & <b> "c"'), 'a &amp; &lt;b&gt; &quot;c&quot;');
});

r.test('renderSvg MUST write a renamed session name escaped WHEN the name holds markup', () => {
  const ride = oneRide(doc('a', 'KPN', 's', rounds('a', 0, 3), {name: 'Home & <work>', renamed: true}));
  const svg = renderSvg(ride, rideSummary(ride));
  assert.ok(svg.includes('Home &amp; &lt;work&gt;') && !svg.includes('<work>'));
});

r.test('layout MUST omit the radio panels WHEN no track carries radio', () => {
  const ids = layout(oneRide(doc('a', 'KPN', 's', rounds('a', 0, 3)))).blocks.map(b => b.id);
  assert.deepEqual(ids.filter(id => ['band', 'rsrp', 'snr', 'events'].includes(id)), []);
});

r.test('layout MUST give a numeric panel one shared row WHEN the ride has two tracks', () => {
  const ride = oneRide(doc('a', 'KPN', 's1', rounds('a', 0, 3)), doc('b', 'Odido', 's2', rounds('b', 5, 3)));
  assert.deepEqual(layout(ride).blocks.find(b => b.id === 'throughput').rows.map(row => row.h), [100]);
});

r.test('layout MUST give the grade strips one row per track WHEN the ride has two tracks', () => {
  const ride = oneRide(doc('a', 'KPN', 's1', rounds('a', 0, 3)), doc('b', 'Odido', 's2', rounds('b', 5, 3)));
  assert.deepEqual(layout(ride).blocks.find(b => b.id === 'grades').rows.map(row => row.track), ['KPN', 'Odido']);
});

r.test('is5g MUST count a round as 5G WHEN its RAT reads LTE and it measured NR signal', () => {
  assert.equal(is5g({rat: 'kLTE', nr: {n: 2}}), true);
});

r.test('is5g MUST count a round as 4G WHEN its RAT reads LTE and it measured no NR signal', () => {
  assert.equal(is5g({rat: 'kLTE', nr: null}), false);
});

const radioDoc = (id, operator, screen, band) => ({
  ...doc(id, operator, screen, rounds(id, 0, 3, () => ({radio: {coverage: 'full', rat: 'kLTE', cell: {band}, stalls: []}}))),
  format: 'nulog/session+radio'
});

r.test('renderSvg MUST label an LTE band by its frequency WHEN rounds carry the band', () => {
  const ride = oneRide(radioDoc('a', 'KPN', 's', 20));
  const svg = renderSvg(ride, rideSummary(ride));
  assert.ok(svg.includes('800 MHz') && !svg.includes('B20'));
});

r.test('renderSvg MUST label a 5G run with its NR frequency WHEN the rounds name an NR cell', () => {
  const nr = {radio: {coverage: 'full', rat: 'kENDCFR1', cell: {band: 3}, nr_cell: {dl_mhz: 3561.6, bands: ['n77', 'n78']}, stalls: []}};
  const ride = oneRide({...doc('a', 'Odido', 's', rounds('a', 0, 3, () => nr)), format: 'nulog/session+radio'});
  assert.ok(renderSvg(ride, rideSummary(ride)).includes('5G 3560 MHz'));
});

const pausedDoc = (id, operator, screen) => {
  const d = doc(id, operator, screen, [round(id, 0), round(id, 20), round(id, 240), round(id, 260)]);
  d.events = [{type: 'pause', t: AT + 238000, text: '198.0s bridged'}];
  return d;
};

r.test('renderSvg MUST name a collapsed pause on the time axis WHEN every phone paused', () => {
  const ride = oneRide(pausedDoc('a', 'KPN', 's'));
  assert.ok(renderSvg(ride, rideSummary(ride)).includes('>paused 3 min<'));
});

r.test('commonBreaks MUST collapse a gap WHEN every track paused over it', () => {
  const ride = oneRide(pausedDoc('a', 'KPN', 's1'), pausedDoc('b', 'Odido', 's2'));
  assert.deepEqual(commonBreaks(ride).map(g => [g.kind, (g.to - g.from) / 1000]), [['pause', 200]]);
});

r.test('commonBreaks MUST keep a gap at full width WHEN one track recorded through it', () => {
  const ride = oneRide(pausedDoc('a', 'KPN', 's1'), doc('b', 'Odido', 's2', rounds('b', 0, 14)));
  assert.deepEqual(commonBreaks(ride), []);
});

r.test('renderSvg MUST draw a track WHEN only some of its rounds carry radio', () => {
  const ride = oneRide(radioDoc('a', 'KPN', 's', 20), doc('b', 'KPN', 's', rounds('b', 62, 3)));
  assert.equal(ride.tracks.length, 1);
  assert.doesNotThrow(() => renderSvg(ride, rideSummary(ride)));
});

r.test('renderSvg MUST name each track by its operator WHEN two phones ride together', () => {
  const ride = oneRide(doc('a', 'KPN', 's1', rounds('a', 0, 3)), doc('b', 'Odido', 's2', rounds('b', 5, 3)));
  const svg = renderSvg(ride, rideSummary(ride));
  assert.ok(svg.includes('>KPN calling<') && svg.includes('>Odido calling<'));
});

r.test('timeTicks MUST space labels wider than a clock label WHEN a ride lasts 95 minutes', () => {
  const {step, ticks} = timeTicks(AT, AT + 95 * 60000, 1026, 'Europe/Amsterdam');
  assert.deepEqual([step, ticks[1].x - ticks[0].x >= 42], [5, true]);
});

const withDevice = (id, operator, screen, device) => {
  const d = {...doc(id, operator, screen, rounds(id, id === 'b' ? 5 : 0, 4, positioned)), format: 'nulog/session+radio'};
  d.session.radio = {device};
  return d;
};

r.test('rideFileName MUST name the file by time, route and phones WHEN places and devices are known', () => {
  const ride = oneRide(withDevice('a', 'KPN', 's1', 'iPhone SE'), withDevice('b', 'Odido', 's2', 'iPhone 15 Pro'));
  const summary = rideSummary(ride, {places: [['Start', 52, 4.3], ['End', 52.003, 4.3]]});
  assert.equal(rideFileName(ride, summary), '20260915-1813 Start to End - iPhone SE KPN + iPhone 15 Pro Odido');
});

r.test('rideFileName MUST say route unknown WHEN no fix places the ride', () => {
  const ride = oneRide(doc('a', 'KPN', 's', rounds('a', 0, 4)));
  assert.equal(rideFileName(ride, rideSummary(ride)), '20260915-1813 route unknown - KPN');
});

// A round at one signal level, one temperature and one download rate.
const warmRound = (seconds, {temp, rsrp, mbps, layers = 2}) =>
  round('a', seconds, {battery: {temp_c: temp, level: 90, age_ms: 1000},
                       probes: {...probes(), down: {ok: true, bps: mbps * 1e6}},
                       radio: {lte: {rsrp: {med: rsrp}}, mimo: {scheduled: {med: layers}}}});

r.test('thermalTotals MUST split at the median temperature WHEN rounds carry readings', () => {
  const t = thermalTotals([
    warmRound(0, {temp: 28, rsrp: -95, mbps: 20}),
    warmRound(20, {temp: 30, rsrp: -95, mbps: 20}),
    warmRound(40, {temp: 34, rsrp: -95, mbps: 20})
  ]);
  assert.equal(t.split_c, 30);
  assert.deepEqual(t.temp_c, {min: 28, p50: 30, max: 34});
  assert.equal(t.rounds, 3);
});

r.test('thermalTotals MUST compare warm against cool within one signal band WHEN signal differs across rounds', () => {
  // The strong-signal rounds are the cool ones and the weak-signal rounds the warm ones; pooling
  // them would read as a temperature effect that is only coverage.
  const t = thermalTotals([
    warmRound(0, {temp: 28, rsrp: -85, mbps: 25}),
    warmRound(20, {temp: 28, rsrp: -85, mbps: 25}),
    warmRound(40, {temp: 34, rsrp: -115, mbps: 5}),
    warmRound(60, {temp: 34, rsrp: -115, mbps: 5})
  ]);
  const strong = t.by_signal.find(b => b.signal === '-90 dBm and stronger');
  const weak = t.by_signal.find(b => b.signal === 'below -110 dBm');
  assert.deepEqual([strong.cool.rounds, strong.warm.rounds], [2, 0], 'every strong round was cool');
  assert.deepEqual([weak.cool.rounds, weak.warm.rounds], [0, 2], 'and every weak round was warm');
  assert.equal(strong.warm.dl_p50_mbps, null, 'so neither band compares anything');
});

r.test('thermalTotals MUST report the scheduled layers per side WHEN rounds carry mimo', () => {
  const t = thermalTotals([
    warmRound(0, {temp: 28, rsrp: -105, mbps: 25, layers: 4}),
    warmRound(20, {temp: 34, rsrp: -105, mbps: 25, layers: 1})
  ]);
  const band = t.by_signal.find(b => b.signal === '-110 to -100 dBm');
  assert.deepEqual([band.cool.mimo_p50, band.warm.mimo_p50], [4, 1],
                   'equal rate at equal signal on fewer layers is what a capped measurement hides');
});

r.test('thermalTotals MUST return null WHEN no round carries a battery reading', () => {
  assert.equal(thermalTotals([round('a', 0), round('a', 20)]), null);
});

await r.run();
