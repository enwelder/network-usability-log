// The ride chart as one SVG string: header, route sketch, totals, then one panel per measure. Grades
// and connection strips keep a row per phone; every numeric panel draws all phones in one plot, each
// phone in its own colour throughout. Pure; every text passes through esc().
import {ACTIVITY_IDS, SCALES, roundTripFailed} from '../js/grade.js';
import {countsAsFailure} from '../js/export.js';
import {BAND_MHZ, is5g, isAnyRed, routeMs, routePoints, routeSegments, zonedClock} from './ride.mjs';

const W = 1200;
const X0 = 150;
const X1 = 1176;
const INK = '#1F2328';
const GREY = '#6B7280';
const GRID = '#E5E7EB';
const GRADE = {green: '#35B37E', yellow: '#C9B93C', orange: '#E0822F', red: '#E4574C'};
// Blue against magenta stays apart under the common colour-vision deficiencies and matches no grade
// colour. The light tone draws a phone's second line.
const TRACK = ['#0072B2', '#C2408A', '#1F2937'];
const TRACK_LIGHT = ['#6CB6E6', '#E79AC6', '#9CA3AF'];
// Neutral, so no fill here reads as a phone's colour. Lower frequencies are darker.
const FREQ_FILL = {700: '#5B4636', 800: '#7A624E', 900: '#98806A', 1500: '#B39E89', 1800: '#C9B8A6',
                   2100: '#DACDBF', 2300: '#E3D8CC', 2600: '#EDE5DC', 3500: '#F3EEE8', 3700: '#F6F2ED'};
const BAND_OTHER = '#E5E7EB';
const CONNECTION_FILL = {'4G': '#D1D5DB', '5G': '#1F2937'};
const DARK_FILLS = new Set(['5G', 700, 800, 900]);
const FONT = 'system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
const ACTIVITY_SHORT = {voice: 'calling', news: 'articles', streaming: 'video'};

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// No font metrics exist here; 0.6 em per character overestimates proportional sans text.
export const textWidth = (s, px) => String(s ?? '').length * px * 0.6;
export const fitText = (s, px, maxW) => {
  const str = String(s ?? '');
  return textWidth(str, px) <= maxW ? str : `${str.slice(0, Math.max(1, Math.floor(maxW / (px * 0.6)) - 1))}…`;
};

const n1 = v => Math.round(v * 10) / 10;
const text = (x, y, s, {size = 11, fill = INK, anchor = 'start', weight = 400} = {}) =>
  `<text x="${n1(x)}" y="${n1(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"` +
  `${weight === 400 ? '' : ` font-weight="${weight}"`}>${esc(s)}</text>`;
const rect = (x, y, w, h, fill, extra = '') =>
  `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(Math.max(0, w))}" height="${n1(h)}" fill="${fill}"${extra}/>`;
const line = (x1, y1, x2, y2, stroke, extra = '') =>
  `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" stroke="${stroke}"${extra}/>`;

export const linear = (lo, hi, y0, y1) => v =>
  (v == null || !Number.isFinite(v) ? null : y0 + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (y1 - y0));
export const logScale = (lo, hi, y0, y1) => v =>
  (v == null || !(v > 0) ? null
    : y0 + ((Math.log(Math.min(hi, Math.max(lo, v))) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (y1 - y0));

const STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60];

// The step is the smallest whose labels keep clear of each other. Minutes count real time from the
// start, so a collapsed break skips the minutes it covers.
export function timeTicks(t0, t1, plotW, timeZone, {tx = null, pxPerMin = null, breaks = []} = {}) {
  const minutes = (t1 - t0) / 60000;
  const toX = tx ?? (t => X0 + ((t - t0) / (t1 - t0)) * plotW);
  const need = textWidth('00:00', 10) + 12;
  const step = STEPS_MIN.find(s => s * (pxPerMin ?? plotW / minutes) >= need) ?? 60;
  const ticks = [];
  let lastX = -Infinity;
  for (let m = 0; m <= minutes; m += step) {
    const t = t0 + m * 60000;
    const x = toX(t);
    if (breaks.some(g => t > g.from && t < g.to) || x - lastX < need) continue;
    lastX = x;
    const anchor = m === 0 ? 'start' : X0 + plotW - x < need / 2 ? 'end' : 'middle';
    ticks.push({t, x, minute: m, clock: zonedClock(t, timeZone), anchor});
  }
  return {step, ticks};
}

const BREAK_PX = 16;

// Stretches in which no phone ran a round carry no measurement, so they collapse to a fixed width.
// A stretch one phone recorded through stays at full width.
export function commonBreaks(ride, minMs = 60000) {
  let common = ride.tracks[0].gaps.map(g => ({from: g.from_t, to: g.to_t, kind: g.kind}));
  for (const k of ride.tracks.slice(1)) {
    const next = [];
    for (const a of common) {
      for (const g of k.gaps) {
        const from = Math.max(a.from, g.from_t);
        const to = Math.min(a.to, g.to_t);
        if (to > from) next.push({from, to, kind: a.kind === g.kind ? a.kind : 'unknown'});
      }
    }
    common = next;
  }
  return common.filter(g => g.to - g.from >= minMs && g.from > ride.t0 && g.to < ride.t1)
    .sort((a, b) => a.from - b.from);
}

export function timeScale(ride, plotW = X1 - X0) {
  const breaks = commonBreaks(ride);
  const active = ride.t1 - ride.t0 - breaks.reduce((n, g) => n + g.to - g.from, 0);
  const pxPerMs = (plotW - breaks.length * BREAK_PX) / active;
  const tx = t => {
    let x = X0;
    let from = ride.t0;
    for (const g of breaks) {
      if (t <= g.from) break;
      x += (g.from - from) * pxPerMs;
      if (t < g.to) return x + ((t - g.from) / (g.to - g.from)) * BREAK_PX;
      x += BREAK_PX;
      from = g.to;
    }
    return x + (Math.min(t, ride.t1) - from) * pxPerMs;
  };
  return {tx, breaks, pxPerMs};
}

const SWATCH = {
  solid: () => line(0, -4, 16, -4, GREY, ' stroke-width="1.6"'),
  dotted: () => line(0, -4, 16, -4, GREY, ' stroke-width="1.2" stroke-dasharray="2 2"'),
  dashed: () => line(0, -4, 16, -4, GRADE.red, ' stroke-dasharray="4 3"'),
  cross: () => text(8, 0, '×', {size: 11, anchor: 'middle'}),
  hatch: () => rect(0, -9, 14, 10, 'url(#hatch)'),
  tick: () => line(8, -10, 8, 1, GREY),
  triangle: () => `<path d="M3,1 L8,-9 L13,1 Z" fill="${GRADE.orange}"/>`,
  routeAll: () => line(0, -4, 16, -4, GRADE.red, ' stroke-width="4"'),
  routeOne: () => line(0, -4, 16, -4, GRADE.orange, ' stroke-width="3"')
};
const swatchOf = kind => (kind.startsWith('#') ? rect(0, -9, 14, 10, kind) : SWATCH[kind]());
const itemWidth = ([, label]) => 20 + textWidth(label, 10) + 14;

function legendRow(x, y, items) {
  const out = [];
  let cx = x;
  for (const item of items) {
    out.push(`<g transform="translate(${n1(cx)},${n1(y)})">${swatchOf(item[0])}</g>`,
             text(cx + 20, y, item[1], {size: 10, fill: GREY}));
    cx += itemWidth(item);
  }
  return out.join('');
}

// A panel's key sits on its own title line, so each symbol is read beside the rows it marks.
function titleLine(b, title, items = []) {
  const x = Math.max(X0 + textWidth(title, 12) + 24, X1 - items.reduce((w, it) => w + itemWidth(it), 0));
  return text(X0, b.y + 12, title, {size: 12, weight: 600}) + legendRow(x, b.y + 12, items);
}

const RADIO_BLOCKS = new Set(['band', 'rsrp', 'snr', 'events']);
const BATTERY_BLOCKS = new Set(['heat']);
const NUMERIC_BLOCKS = new Set(['rsrp', 'snr', 'throughput', 'latency', 'heat']);

// A panel is drawn for the tracks whose file carries what it plots, and left out when no track does.
const carries = (track, id) => (RADIO_BLOCKS.has(id) ? track.has_radio
                              : BATTERY_BLOCKS.has(id) ? track.has_battery : true);
const absentNote = id => (BATTERY_BLOCKS.has(id) ? 'no battery readings for' : 'no radio log for');

export function layout(ride) {
  const n = ride.tracks.length;
  const blocks = [];
  let y = 0;
  const push = (id, h, rows = []) => { blocks.push({id, y, h, rows}); y += h; };
  const panel = (id, rowH, rowGap = 6) => {
    if (!ride.tracks.some(k => carries(k, id))) return;
    if (NUMERIC_BLOCKS.has(id)) {
      push(id, 18 + rowH + 12, [{track: null, y: y + 18, h: rowH}]);
      return;
    }
    const rows = ride.tracks.map((k, i) => ({track: k.label, y: y + 18 + i * (rowH + rowGap), h: rowH}));
    push(id, 18 + n * rowH + (n - 1) * rowGap + 12, rows);
  };
  const numeric = n === 1 ? 70 : 100;
  push('header', 70 + 20 * n);
  push('overview', 262);
  for (const [id, h, gap] of [['grades', 34, 6], ['band', 26, 6], ['rsrp', numeric], ['snr', numeric],
                              ['throughput', numeric], ['latency', numeric], ['heat', 56],
                              ['events', 10, 4]]) {
    panel(id, h, gap);
  }
  push('axis', 58);
  return {width: W, height: y, blocks};
}

const PANELS = {
  rsrp: {title: 'signal strength RSRP (dBm)', legend: [['solid', 'LTE'], ['dotted', 'NR'], ['dashed', '-115 dBm']],
         scale: linear, lo: -125, hi: -70, ticks: [-120, -100, -80], threshold: -115,
         series: [s => s.radio?.lte?.rsrp.med, s => s.radio?.nr?.rsrp.med]},
  snr: {title: 'signal quality SNR (dB)', legend: [['solid', 'LTE'], ['dotted', 'NR'], ['dashed', '5 dB']],
        scale: linear, lo: -10, hi: 30, ticks: [0, 10, 20], threshold: 5,
        series: [s => s.radio?.lte?.snr.med, s => s.radio?.nr?.snr.med]},
  throughput: {title: 'throughput (Mbit/s)',
               legend: [['solid', 'download'], ['dotted', 'upload'],
                        ['dashed', `video unusable below ${(SCALES.rate.edges[2] / 1e6).toFixed(1)}`], ['cross', 'failed']],
               scale: logScale, lo: 0.1, hi: 100, ticks: [0.1, 1, 10, 100], threshold: SCALES.rate.edges[2] / 1e6,
               series: [s => (s.probes?.down?.ok ? s.probes.down.bps / 1e6 : null),
                        s => (s.probes?.up?.ok ? s.probes.up.bps / 1e6 : null)],
               failed: s => countsAsFailure(s.probes?.down)},
  latency: {title: 'round trip (ms)',
            legend: [['solid', 'round trip'], ['dotted', 'new-host time'],
                     ['dashed', `calling unusable above ${SCALES.round_trip.edges[2]}`], ['cross', 'failed']],
            scale: logScale, lo: 10, hi: 5000, ticks: [10, 100, 1000], threshold: SCALES.round_trip.edges[2],
            series: [s => routeMs(s.probes), s => (s.probes?.dns?.ok ? s.probes.dns.ms : null)],
            failed: s => roundTripFailed(s.probes || {})},
  // The phone's own warmth, from the sysdiagnose powerlog. No line marks a limit: iOS states no
  // temperature at which it holds the modem back, and the battery is not the chip.
  heat: {title: 'battery temperature (°C)', legend: [],
         scale: linear, lo: 20, hi: 40, ticks: [25, 30, 35],
         series: [s => s.battery?.temp_c]}
};

function context(ride, summary) {
  const {tx, breaks, pxPerMs} = timeScale(ride);
  const track = label => ride.tracks.find(k => k.label === label);
  const index = label => ride.tracks.findIndex(k => k.label === label);
  const colour = label => TRACK[index(label)] ?? INK;
  const light = label => TRACK_LIGHT[index(label)] ?? GREY;
  const spanEnd = (k, i) => Math.min(k.samples[i + 1]?.t ?? Infinity, k.samples[i].t + k.interval_ms);
  return {ride, summary, tx, breaks, pxPerMs, track, colour, light, spanEnd};
}

// Left of the value labels, which end at the plot edge.
const rowLabel = (c, row) =>
  (c.ride.tracks.length > 1
    ? text(X0 - 34, row.y + row.h / 2 + 4, fitText(row.track, 10, 110), {size: 10, fill: c.colour(row.track), anchor: 'end'})
    : '');

function gradesBlock(b, c) {
  const out = [titleLine(b, 'what you would notice', [[GRID, 'not rated'], ['hatch', 'paused or interrupted']])];
  for (const row of b.rows) {
    const k = c.track(row.track);
    ACTIVITY_IDS.forEach((id, a) => {
      const y = row.y + a * 12;
      const label = c.ride.tracks.length > 1 ? `${row.track} ${ACTIVITY_SHORT[id]}` : ACTIVITY_SHORT[id];
      out.push(text(X0 - 6, y + 9, label, {size: 9, fill: c.ride.tracks.length > 1 ? c.colour(row.track) : GREY, anchor: 'end'}));
      k.samples.forEach((s, i) => {
        const x = c.tx(s.t);
        const w = c.tx(c.spanEnd(k, i)) - x;
        const fill = s.interrupted || s.in_pause ? 'url(#hatch)' : !s.grades ? GRID : GRADE[s.grades[id]] ?? GRID;
        out.push(rect(x, y, w + 0.3, 10, fill));
      });
    });
    for (const g of k.gaps) {
      const x1 = c.tx(g.from_t);
      const w = c.tx(g.to_t) - x1;
      if (g.kind === 'join') out.push(rect(x1, row.y, w, 34, 'none', ` stroke="${GREY}" stroke-dasharray="2 2"`));
      const minutes = Math.max(1, Math.round((g.to_t - g.from_t) / 60000));
      const label = {pause: `paused ${minutes} min`, join: 'not recording', unknown: `no rounds ${minutes} min`}[g.kind];
      if (label && textWidth(label, 9) + 8 <= w) {
        out.push(text(x1 + w / 2, row.y + 21, label, {size: 9, fill: GREY, anchor: 'middle'}));
      }
    }
  }
  return out.join('');
}

const bandText = band => (BAND_MHZ[band] ? `${BAND_MHZ[band]} MHz` : `band ${band}`);
const bandFill = band => FREQ_FILL[BAND_MHZ[band]] ?? BAND_OTHER;
// An NR carrier's own centre frequency, to 10 MHz; a band name would misname carriers at band edges.
const nrMhz = mhz => Math.round(mhz / 10) * 10;

// Consecutive rounds holding the same value merge into one run.
function runs(k, c, valueOf) {
  const out = [];
  k.samples.forEach((s, i) => {
    const value = valueOf(s);
    const x1 = c.tx(s.t);
    const x2 = c.tx(c.spanEnd(k, i));
    const last = out.at(-1);
    if (last && last.value === value && Math.abs(last.x2 - x1) < 0.5) last.x2 = x2;
    else out.push({value, x1, x2});
  });
  return out.filter(r => r.value != null);
}

function connectionBlock(b, c) {
  const bands = [...new Set(c.ride.tracks.flatMap(k => k.samples.map(s => s.radio?.cell?.band)).filter(v => v != null))]
    .sort((x, y) => (BAND_MHZ[x] ?? 1e6) - (BAND_MHZ[y] ?? 1e6));
  const frequencies = [...new Map(bands.map(band => [bandText(band), bandFill(band)]))].map(([label, fill]) => [fill, label]);
  const out = [titleLine(b, '4G or 5G with the 5G frequency, LTE frequency below',
                         [...Object.entries(CONNECTION_FILL).map(([name, fill]) => [fill, name]), ...frequencies])];
  for (const row of b.rows) {
    const k = c.track(row.track);
    out.push(rowLabel(c, row));
    if (!k.has_radio) { out.push(text(X0 + 4, row.y + 16, 'no radio log', {size: 10, fill: GREY})); continue; }
    // A round without radio, from a plain session continuing the track, draws nothing.
    const radioOf = (s, covered) => (!s.radio ? null : s.radio.coverage === 'none' ? 'none' : covered(s.radio));
    const strips = [
      {y: row.y, valueOf: s => radioOf(s, r => (!is5g(r) ? '4G' : r.nr_cell ? `5G ${nrMhz(r.nr_cell.dl_mhz)} MHz` : '5G')),
       fillOf: v => CONNECTION_FILL[v.slice(0, 2)], labelOf: v => v, dark: v => v.startsWith('5G')},
      {y: row.y + 14, valueOf: s => radioOf(s, r => r.cell?.band ?? 'unknown'),
       fillOf: v => (v === 'unknown' ? BAND_OTHER : bandFill(v)), labelOf: v => (v === 'unknown' ? '' : bandText(v)),
       dark: v => DARK_FILLS.has(BAND_MHZ[v])}
    ];
    // Labels follow every fill, so no neighbouring run covers them.
    const labels = [];
    for (const strip of strips) {
      for (const run of runs(k, c, strip.valueOf)) {
        const w = run.x2 - run.x1;
        out.push(rect(run.x1, strip.y, w + 0.3, 12, run.value === 'none' ? 'url(#hatch)' : strip.fillOf(run.value)));
        const label = run.value === 'none' ? '' : strip.labelOf(run.value);
        if (label && textWidth(label, 9) + 16 <= w) {
          labels.push(text(run.x1 + w / 2, strip.y + 9, label,
                           {size: 9, fill: strip.dark(run.value) ? '#FFFFFF' : INK, anchor: 'middle'}));
        }
      }
    }
    out.push(...labels);
  }
  return out.join('');
}

// All phones share one plot. Second lines go down first, so every phone's main line stays on top.
function linePanel(b, c, spec) {
  const shown = c.ride.tracks.filter(k => carries(k, b.id));
  const missing = c.ride.tracks.filter(k => !shown.includes(k)).map(k => k.label);
  const phones = c.ride.tracks.length > 1 ? shown.map(k => [c.colour(k.label), k.label]) : [];
  const title = missing.length
    ? `${spec.title}, ${absentNote(b.id)} ${missing.join(', ')}` : spec.title;
  const out = [titleLine(b, title, [...phones, ...spec.legend])];
  const row = b.rows[0];
  const y = spec.scale(spec.lo, spec.hi, row.y + row.h, row.y);
  out.push(rect(X0, row.y, X1 - X0, row.h, '#FAFAFB'));
  for (const t of spec.ticks) {
    const ty = y(t);
    out.push(line(X0, ty, X1, ty, GRID));
    // A label on the plot's edge would meet the panel title or the next panel.
    if (ty > row.y + 7 && ty < row.y + row.h - 3) out.push(text(X0 - 6, ty + 3, t, {size: 9, fill: GREY, anchor: 'end'}));
  }
  if (spec.threshold != null) {
    out.push(line(X0, y(spec.threshold), X1, y(spec.threshold), GRADE.red,
                  ' stroke-dasharray="4 3" stroke-opacity="0.8"'));
  }
  for (let si = spec.series.length - 1; si >= 0; si--) {
    for (const k of shown) {
      const stroke = si === 0 ? c.colour(k.label) : c.light(k.label);
      const style = si === 0 ? 'stroke-width="1.6"' : 'stroke-width="1.2" stroke-dasharray="2 2"';
      let path = [];
      let prevT = null;
      const flush = () => {
        if (path.length > 1) {
          out.push(`<polyline fill="none" stroke="${stroke}" ${style} points="${path.map(p => p.join(',')).join(' ')}"/>`);
        } else if (path.length === 1) {
          out.push(`<circle cx="${path[0][0]}" cy="${path[0][1]}" r="1.6" fill="${stroke}"/>`);
        }
        path = [];
      };
      for (const s of k.samples.filter(r => !r.interrupted && !r.round_error)) {
        const v = y(spec.series[si](s));
        if (v == null || (prevT != null && s.t - prevT > 1.5 * k.interval_ms)) flush();
        if (v != null) { path.push([n1(c.tx(s.t)), n1(v)]); prevT = s.t; }
      }
      flush();
    }
  }
  if (spec.failed) {
    shown.forEach((k, ki) => {
      for (const s of k.samples.filter(r => !r.interrupted && !r.round_error && spec.failed(r))) {
        out.push(text(c.tx(s.t), row.y + row.h - 2 - ki * 9, '×', {size: 10, fill: c.colour(k.label), anchor: 'middle'}));
      }
    });
  }
  return out.join('');
}

function eventsBlock(b, c) {
  const out = [titleLine(b, 'cell changes and iOS stalls', [['tick', 'cell change'], ['triangle', 'iOS stall']])];
  for (const row of b.rows) {
    const k = c.track(row.track);
    out.push(rowLabel(c, row), line(X0, row.y + row.h, X1, row.y + row.h, GRID));
    for (const s of k.samples.filter(r => r.radio)) {
      if (s.radio.cell_changes > 0 || s.radio.cell_changed_since_previous) {
        out.push(line(c.tx(s.t), row.y, c.tx(s.t), row.y + row.h, c.colour(row.track), ' stroke-width="1"'));
      }
      for (const [offset] of (s.radio.stalls || []).filter(st => st[1])) {
        const x = c.tx(s.t + offset);
        out.push(`<path d="M${n1(x - 4)},${row.y + row.h} L${n1(x)},${row.y} L${n1(x + 4)},${row.y + row.h} Z" fill="${GRADE.orange}"/>`);
      }
    }
  }
  return out.join('');
}

function axisBlock(b, c, top, spans) {
  const {ticks} = timeTicks(c.ride.t0, c.ride.t1, X1 - X0, c.ride.timezone,
                            {tx: c.tx, pxPerMin: c.pxPerMs * 60000, breaks: c.breaks});
  const out = [text(X0 - 12, b.y + 14, 'min', {size: 10, fill: GREY, anchor: 'end'}),
               text(X0 - 12, b.y + 28, 'clock', {size: 10, fill: GREY, anchor: 'end'})];
  for (const t of ticks) {
    out.push(line(t.x, top, t.x, b.y + 2, GRID, ' stroke-opacity="0.7"'),
             text(t.x, b.y + 14, t.minute, {size: 10, anchor: t.anchor}),
             text(t.x, b.y + 28, t.clock, {size: 10, fill: GREY, anchor: t.anchor}));
  }
  const groups = [];
  for (const g of c.breaks) {
    const x = c.tx(g.from);
    // Across the plotted rows only, so the break never runs through a panel title.
    for (const [y1, y2] of [...spans, [b.y, b.y + 30]]) {
      out.push(line(x + 5, y1, x + 5, y2, GREY, ' stroke-dasharray="3 3"'),
               line(x + 11, y1, x + 11, y2, GREY, ' stroke-dasharray="3 3"'));
    }
    // Breaks too close to label apart share one label.
    const centre = x + BREAK_PX / 2;
    const last = groups.at(-1);
    if (last && centre - last.x2 < 90) { last.items.push(g); last.x2 = centre; }
    else groups.push({x1: centre, x2: centre, items: [g]});
  }
  for (const group of groups) {
    const minutes = Math.max(1, Math.round(group.items.reduce((n, g) => n + g.to - g.from, 0) / 60000));
    const kind = group.items.every(g => g.kind === group.items[0].kind) ? group.items[0].kind : 'unknown';
    const word = {pause: 'paused', join: 'not recording'}[kind] ?? 'no rounds';
    const label = group.items.length > 1 ? `${word} ${group.items.length}× · ${minutes} min` : `${word} ${minutes} min`;
    const cx = Math.min(X1 - textWidth(label, 9) / 2, (group.x1 + group.x2) / 2);
    out.push(text(cx, b.y + 46, label, {size: 9, fill: GREY, anchor: 'middle'}));
  }
  return out.join('');
}

const dateLine = (t, timeZone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'short', day: 'numeric',
    month: 'short', year: 'numeric'}).formatToParts(t).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
};

function headerBlock(b, c) {
  const r = c.summary.ride;
  const intervals = [...new Set(c.ride.tracks.map(k => k.interval_ms / 1000))].join(' and ');
  const out = [text(24, b.y + 30, fitText(r.title, 18, W - 48), {size: 18, weight: 600}),
               text(24, b.y + 52, `${dateLine(c.ride.t0, r.timezone)} · ${r.start_clock.slice(0, 5)}–${r.end_clock.slice(0, 5)} ` +
                    `(${r.timezone}) · ${Math.round(r.duration_min)} min · rounds every ${intervals} s`, {size: 12, fill: GREY})];
  c.summary.tracks.forEach((k, i) => {
    const y = b.y + 72 + i * 20;
    const radio = k.totals.radio ? `radio ${k.totals.radio.coverage.full}/${k.totals.radio.rounds} full` : 'no radio log';
    const joins = k.joins.map(j => ` · joined at ${j.at_clock} (${j.gap_s} s gap)`).join('');
    out.push(rect(24, y - 10, 12, 12, TRACK[i] ?? INK),
             text(42, y, fitText(`${k.label} · screen ${k.screen} · iOS ${k.ios_version ?? 'unknown'} · ` +
                  `${k.totals.rounds.rounds} rounds · ${radio}${joins}`, 12, W - 70), {size: 12, fill: TRACK[i] ?? INK, weight: 600}));
  });
  return out.join('');
}

function routeBox(b, c) {
  const box = {x: 24, y: b.y + 8, w: 320, h: 220};
  const out = [rect(box.x, box.y, box.w, box.h, '#FAFAFB', ` stroke="${GRID}"`)];
  const points = routePoints(c.ride.tracks);
  out.push(legendRow(box.x, box.y + box.h + 20, c.ride.tracks.length > 1
    ? [['routeAll', 'unusable on every phone'], ['routeOne', 'unusable on one phone']] : [['routeAll', 'unusable']]));
  if (points.length < 2) {
    out.push(text(box.x + box.w / 2, box.y + box.h / 2, 'no position fixes', {size: 11, fill: GREY, anchor: 'middle'}));
    return out.join('');
  }
  const lat0 = (points.reduce((a, p) => a + p.lat, 0) / points.length) * (Math.PI / 180);
  const xs = points.map(p => p.lon * Math.cos(lat0));
  const ys = points.map(p => p.lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 16;
  const scale = Math.min((box.w - 2 * pad) / Math.max(maxX - minX, 1e-6), (box.h - 2 * pad) / Math.max(maxY - minY, 1e-6));
  const ox = box.x + (box.w - (maxX - minX) * scale) / 2;
  const oy = box.y + (box.h - (maxY - minY) * scale) / 2;
  const at = p => [n1(ox + (p.lon * Math.cos(lat0) - minX) * scale), n1(oy + (maxY - p.lat) * scale)];
  const redNear = (k, t) => k.samples.some(s => Math.abs(s.t - t) <= k.interval_ms / 2 && isAnyRed(s));
  const redCount = p => c.ride.tracks.filter(k => redNear(k, p.t)).length;
  for (const seg of routeSegments(points)) {
    out.push(`<polyline fill="none" stroke="#9CA3AF" stroke-width="2" points="${seg.map(p => at(p).join(',')).join(' ')}"/>`);
    for (let i = 1; i < seg.length; i++) {
      const red = Math.min(redCount(seg[i - 1]), redCount(seg[i]));
      if (!red) continue;
      const all = red === c.ride.tracks.length;
      const [x1, y1] = at(seg[i - 1]);
      const [x2, y2] = at(seg[i]);
      out.push(line(x1, y1, x2, y2, all ? GRADE.red : GRADE.orange, ` stroke-width="${all ? 4 : 3}" stroke-linecap="round"`));
    }
  }
  const ends = [[points[0], c.summary.ride.from_place, 'white'], [points.at(-1), c.summary.ride.to_place, INK]];
  for (const [p, place, fill] of ends) {
    const [x, y] = at(p);
    out.push(`<circle cx="${x}" cy="${y}" r="4" fill="${fill}" stroke="${INK}" stroke-width="1.5"/>`);
    if (place) {
      const left = x > box.x + box.w / 2;
      const ly = Math.min(box.y + box.h - 6, Math.max(box.y + 14, y - 8));
      out.push(text(left ? x - 8 : x + 8, ly, fitText(place.name, 10, 150), {size: 10, anchor: left ? 'end' : 'start'}));
    }
  }
  return out.join('');
}

const pctText = s => (s == null ? '–' : `${Math.round(s * 100)}%`);
const pair = (a, b, unit) => (a == null && b == null ? '–' : `${a ?? '–'} / ${b ?? '–'}${unit}`);

function totalsTable(b, c) {
  const x = 370;
  const tracks = c.summary.tracks;
  const step = Math.min(250, (X1 - 600) / tracks.length);
  const rows = [
    ['recorded minutes · rounds ran/slots', k => `${k.totals.rounds.recorded_min} · ${k.totals.rounds.ran}/${k.totals.rounds.slots}`],
    // The share counts rated rounds, so an activity the round could not rate names that base.
    ...ACTIVITY_IDS.map(id => [`${ACTIVITY_SHORT[id]} unusable`, k => {
      const a = k.totals.activities[id];
      if (!a.rated) return 'not rated';
      return `${a.counts.red} (${pctText(a.shares.red)}${a.unrated ? ` of ${a.rated} rated` : ''})`;
    }]),
    ['any activity unusable', k => `${k.totals.any_red.rounds} (${pctText(k.totals.any_red.share)})`],
    ['download p50 / p10', k => pair(k.totals.download.p50_mbps, k.totals.download.p10_mbps, ' Mbit/s')],
    ['round trip p50 / p90', k => pair(k.totals.round_trip.p50_ms, k.totals.round_trip.p90_ms, ' ms')],
    ['LTE RSRP p50 / p10', k => (k.totals.radio ? pair(k.totals.radio.lte_rsrp_dbm.p50, k.totals.radio.lte_rsrp_dbm.p10, ' dBm') : '–')],
    ['rounds on 5G', k => (k.totals.radio ? pctText(k.totals.radio.share_5g) : '–')],
    ['cell changes per hour', k => String(k.totals.radio?.cell_changes_per_hour ?? '–')]
  ];
  const top = b.y + 22;
  const out = [text(x, top, 'totals', {size: 12, weight: 600})];
  tracks.forEach((k, i) => out.push(text(600 + i * step, top, fitText(k.label, 11, step - 12),
                                         {size: 11, weight: 600, fill: TRACK[i] ?? INK})));
  rows.forEach(([label, cell], r) => {
    const y = top + 22 + r * 20;
    out.push(line(x, y + 6, X1, y + 6, GRID), text(x, y, label, {size: 11, fill: GREY}));
    tracks.forEach((k, i) => out.push(text(600 + i * step, y, fitText(cell(k), 11, step - 12), {size: 11})));
  });
  return out.join('');
}

export function renderSvg(ride, summary) {
  const L = layout(ride);
  const c = context(ride, summary);
  const panelsTop = L.blocks.find(b => b.id === 'grades').y;
  const spans = L.blocks.filter(bl => bl.rows.length).map(bl => [bl.rows[0].y, bl.rows.at(-1).y + bl.rows.at(-1).h]);
  const draw = {
    header: b => headerBlock(b, c),
    overview: b => routeBox(b, c) + totalsTable(b, c),
    grades: b => gradesBlock(b, c),
    band: b => connectionBlock(b, c),
    rsrp: b => linePanel(b, c, PANELS.rsrp),
    snr: b => linePanel(b, c, PANELS.snr),
    throughput: b => linePanel(b, c, PANELS.throughput),
    latency: b => linePanel(b, c, PANELS.latency),
    heat: b => linePanel(b, c, PANELS.heat),
    events: b => eventsBlock(b, c),
    axis: b => axisBlock(b, c, panelsTop, spans)
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${L.height}" viewBox="0 0 ${W} ${L.height}" ` +
    `font-family="${FONT}" style="font-variant-numeric: tabular-nums">`,
    `<title>${esc(summary.ride.title)}</title>`,
    '<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<rect width="2" height="4" fill="#9CA3AF"/></pattern></defs>',
    rect(0, 0, W, L.height, '#FFFFFF'),
    ...L.blocks.map(b => draw[b.id](b)),
    '</svg>'
  ].join('\n');
}
