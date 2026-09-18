// Draws one chart per ride, and writes a summary to compare rides by, from session exports, bundles
// and radio-joined files. A directory contributes the JSON files directly inside it.
//
//   node tools/ride-chart.mjs <file|dir>... [--out <dir>] [--places <file>]
//
// A directory holding an `input` folder is read from there; every chart is written to `output`
// beside it, unless --out names a directory. A ride's files are named by its time, route and phones. The PNG is drawn with playwright's Chromium; where Chromium cannot run,
// the chart is written as .svg. The summary names places and carries no coordinates.
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {validatePlaces} from './places.mjs';
import {ridesFrom, zonedClock} from './ride.mjs';
import {rideSummary} from './ride-summary.mjs';
import {renderSvg} from './ride-svg.mjs';

const USAGE = 'usage: node tools/ride-chart.mjs <file|dir>... [--out <dir>] [--places <file>]';
const DEFAULT_PLACES = new URL('./places-nl.json', import.meta.url);

export function parseArgs(argv) {
  const opts = {paths: [], out: null, places: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--places') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return null;
      opts[a.slice(2)] = value;
      i++;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      opts.paths.push(a);
    }
  }
  return opts.paths.length ? opts : null;
}

// Recordings live in <dir>/input once that folder exists; a plain directory is read as it stands.
const inputDir = dir => (existsSync(join(dir, 'input')) ? join(dir, 'input') : dir);
const collectFiles = paths => paths.flatMap(p => (statSync(p).isDirectory()
  ? readdirSync(inputDir(p)).filter(f => f.endsWith('.json')).sort().map(f => join(inputDir(p), f))
  : [p]));

const safeName = s => String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();

// Time, route and one phone per track, so a file names the ride it holds.
export function rideFileName(ride, summary) {
  const when = ride.id.replace('nulog-ride-', '');
  const route = summary.ride.from_place && summary.ride.to_place
    ? `${summary.ride.from_place.name} to ${summary.ride.to_place.name}` : 'route unknown';
  // A label that already names the model, as it does when two phones share an operator, stands alone.
  const phones = summary.tracks.map(k => (k.device && k.label.includes(k.device)
    ? k.label : [k.device, k.label].filter(Boolean).join(' '))).join(' + ');
  return safeName(`${when} ${route} - ${phones}`);
}

// A second ride starting in the same minute gets a numbered name.
export function uniqueName(id, taken) {
  let name = id;
  for (let n = 2; taken.has(name); n++) name = `${id}-${n}`;
  taken.add(name);
  return name;
}

async function renderPng(svg, path, height) {
  let chromium;
  try {
    ({chromium} = await import('playwright'));
  } catch {
    return 'playwright is not installed';
  }
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({viewport: {width: 1200, height}, deviceScaleFactor: 2});
    // The chart references nothing outside itself; any request is refused.
    await page.route('**', route => route.abort());
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0">` +
                          `${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body>`);
    await page.locator('svg').screenshot({path});
    return null;
  } catch (e) {
    return e.message.split('\n')[0];
  } finally {
    await browser?.close();
  }
}

function loadPlaces(path) {
  if (!existsSync(path)) return {places: [], source: null, note: `no place list at ${path}; places stay unnamed`};
  return {places: validatePlaces(JSON.parse(readFileSync(path, 'utf8'))), source: basename(String(path))};
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const files = collectFiles(opts.paths);
    const inputs = [];
    const unreadable = [];
    for (const file of files) {
      try {
        inputs.push({file, doc: JSON.parse(readFileSync(file, 'utf8'))});
      } catch (e) {
        unreadable.push({file: basename(file), format: null, session_id: null, used: false, reason: `unreadable: ${e.message}`});
      }
    }
    const {rides, ignored, dropped} = ridesFrom(inputs);
    const notUsed = [...unreadable, ...ignored];
    for (const d of [...notUsed, ...dropped]) {
      console.error(`  not used: ${d.file}${d.session_id ? ` [${d.session_id.slice(0, 8)}]` : ''}: ${d.reason}`);
    }
    if (!rides.length) throw new Error('no ride found: no input holds a session with enough rounds');

    const {places, source, note} = loadPlaces(opts.places ?? DEFAULT_PLACES);
    if (note) console.error(`  ${note}`);
    const base = statSync(opts.paths[0]).isDirectory() ? opts.paths[0] : dirname(opts.paths[0]);
    const outDir = opts.out ?? join(base, 'output');
    mkdirSync(outDir, {recursive: true});
    const taken = new Set();

    for (const ride of rides) {
      const ids = new Set(ride.tracks.flatMap(k => k.sessions.map(s => s.id)));
      const rideInputs = [
        ...ride.tracks.flatMap(k => k.sessions.map(s => ({file: s.file, format: s.format, session_id: s.id,
                                                          used: true, reason: null}))),
        ...dropped.filter(d => ids.has(d.session_id)),
        ...notUsed
      ];
      const summary = rideSummary(ride, {places, placesSource: source, inputs: rideInputs,
                                         generated: new Date().toISOString()});
      const svg = renderSvg(ride, summary);
      const base = join(outDir, uniqueName(rideFileName(ride, summary), taken));
      writeFileSync(`${base}-summary.json`, `${JSON.stringify(summary, null, 1)}\n`);
      const height = Number(svg.match(/<svg[^>]* height="(\d+)"/)?.[1] ?? 1200);
      const failed = await renderPng(svg, `${base}.png`, height);
      if (failed) {
        writeFileSync(`${base}.svg`, svg);
        console.error(`  ${basename(base)}.png not written (${failed}); the chart is in ${basename(base)}.svg`);
      }
      const tracks = ride.tracks.map(k => `${k.label} ${k.samples.length}`).join(', ');
      console.log(`${base}.${failed ? 'svg' : 'png'}: ${summary.ride.title}, ${zonedClock(ride.t0, ride.timezone)}–` +
                  `${zonedClock(ride.t1, ride.timezone)}, rounds ${tracks}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('ride-chart.mjs')) await main();
