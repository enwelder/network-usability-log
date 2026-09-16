// The radio join: the patterns the log is read with, and the rules that decide what a round is
// allowed to claim. Log records here are written by hand, since a real archive carries a home
// address and the phone's identifiers.
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {suite} from './helpers.mjs';
import {PATTERNS, REQUIRED, predicate} from '../tools/radio-patterns.mjs';
import {createCollector, enrich, extractSysdiagnose, isSysdiagnoseArchive, prefix64,
        withBattery, withoutDeviceAddresses} from '../tools/radio-join.mjs';
import {nearestReading, parseBattery} from '../tools/powerlog.mjs';

const r = suite('radio');

const AT = Date.parse('2026-09-12T15:00:00.000+02:00');
// A record as `log show --style ndjson` writes one.
const record = (pattern, message, offsetMs = 0) => ({
  timestamp: new Date(AT + offsetMs).toISOString(),
  subsystem: pattern.subsystem,
  category: Array.isArray(pattern.category) ? pattern.category[0] : pattern.category,
  eventMessage: message
});
const byName = name => PATTERNS.find(p => p.name === name);
const collect = records => {
  const c = createCollector();
  for (const rec of records) c.add(rec);
  return c;
};
const signal = (offsetMs, rsrp) =>
  record(byName('lte_signal'), `QMI.NAS.2: received LTE SigInfo rssi -80 snr 1 rsrq -14 rsrp ${rsrp}`,
         offsetMs);
const identity = (offsetMs, eci) =>
  record(byName('rat_info'), `QMI.DSD.1 RAT Info: kLTE, MCC 204, MNC 8, TAC 32004, cell_id ${eci}`,
         offsetMs);
const session = rounds => ({
  session: {intervalMs: 20000, operator: 'KPN', environment: {timezone: 'Europe/Amsterdam'}},
  samples: rounds
});
const round = (seq, offsetMs, over = {}) =>
  ({seq, t: AT + offsetMs, round_ms: 4000, probes: {}, grades: {voice: 'green'}, ...over});

r.test('every pattern MUST match its own example WHEN the registry is read', () => {
  for (const p of PATTERNS) {
    assert.match(p.example, p.regex, `${p.name} no longer matches the line it was written for`);
    assert.ok(p.read(p.example.match(p.regex)), `${p.name} reads nothing from its example`);
  }
  assert.ok(REQUIRED.length >= 4, `required patterns: ${REQUIRED.join(', ')}`);
  assert.match(predicate(), /subsystem == "com\.apple\.WirelessRadioManager\.iRAT"/);
});

r.test('createCollector MUST drop the record and keep no value WHEN it carries a device identifier', () => {
  const c = collect([
    record(byName('rat_info'),
           '<CTMobileEquipmentInfo 0x1, IMEI=350719113624127, ICCID=(null), IMSI=(null)> ' +
           'QMI.DSD.1 RAT Info: kLTE, MCC 204, MNC 8, TAC 32004, cell_id 16461107'),
    identity(10, 16461107)
  ]);
  assert.equal(c.state.identifiers_dropped, 1);
  assert.equal(c.events.length, 1, 'only the clean record is kept');
  assert.equal(c.counts.rat_info, 1);
});

r.test('createCollector MUST null a zeroed field and keep the rest WHEN a report is partly absent', () => {
  const c = collect([record(byName('serving_cell'),
    'Index: 0, MCC: 204, MNC: 08, Band info: 0, Area code: 32004, Cell ID: <private>, ' +
    'EARFCN: 0, PID: 253, Bandwidth: 0')]);
  const [config] = c.events;
  assert.equal(config.tac, 32004, 'a real area code survives a zeroed band');
  assert.deepEqual([config.band, config.earfcn, config.bw_rb], [null, null, null]);
  assert.equal(config.pci, 253, 'PCI 0 is a valid identity and is not treated as absent');
  assert.ok(c.state.sentinels_dropped >= 3, `dropped ${c.state.sentinels_dropped}`);
});

r.test('createCollector MUST null a sentinel reading WHEN the log writes one in place of a value', () => {
  const c = collect([record(byName('nr_signal'),
                            'QMI.NAS.2: received New SigInfo snr -3276 rsrp -32768')]);
  assert.deepEqual([c.events[0].snr, c.events[0].rsrp], [null, null]);
  assert.equal(c.state.sentinels_dropped, 2);
});

r.test('createCollector MUST report the patterns that matched nothing WHEN a required line is absent', () => {
  const c = collect([identity(0, 16461107)]);
  const missing = c.missingRequired();
  assert.ok(missing.includes('lte_signal'), `missing: ${missing.join(', ')}`);
  assert.ok(!missing.includes('rat_info'), 'a pattern that matched is not missing');
});

r.test('enrich MUST report coverage none and no cell WHEN no radio record falls in the round', () => {
  const {samples} = enrich(session([round(0, 0)]), []);
  assert.equal(samples[0].radio.coverage, 'none');
  assert.equal(samples[0].radio.cell, null);
  assert.equal(samples[0].radio.lte, null);
});

r.test('enrich MUST report coverage partial WHEN the round holds one signal sample', () => {
  const events = collect([identity(0, 16461107), signal(500, -103)]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  assert.equal(samples[0].radio.coverage, 'partial');
  assert.equal(samples[0].radio.lte.n, 1);
  assert.equal(samples[0].radio.cell.gci, '204.8.32004.16461107');
});

r.test('enrich MUST report coverage full and the sample spread WHEN the round holds a run of samples', () => {
  const events = collect([identity(0, 16461107), signal(500, -103), signal(2000, -95),
                          signal(3500, -99)]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  const {radio} = samples[0];
  assert.equal(radio.coverage, 'full');
  assert.deepEqual(radio.lte.rsrp, {min: -103, med: -99, max: -95});
  assert.deepEqual(radio.lte.samples.map(s => s[0]), [500, 2000, 3500], 'offsets from the round');
});

r.test('enrich MUST derive the eNB and sector WHEN the identity carries a cell id', () => {
  const events = collect([identity(0, 1426188), signal(100, -121), signal(1000, -120)]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  assert.deepEqual([samples[0].radio.cell.enb, samples[0].radio.cell.sector], [5571, 12]);
});

r.test('enrich MUST count one reselection WHEN the flag repeats inside a second', () => {
  const flag = byName('cell_changed');
  const events = collect([
    identity(0, 16461107), signal(100, -100), signal(1200, -101),
    record(flag, 'updateConnectedStateSummary 1, Cell Changed 1, nrCellType: 0', 900),
    record(flag, 'updateConnectedStateSummary 1, Cell Changed 1, nrCellType: 0', 1100),
    record(flag, 'updateConnectedStateSummary 1, Cell Changed 0, nrCellType: 0', 1500)
  ]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  assert.equal(samples[0].radio.cell_changes, 1, 'two marks 200 ms apart are one reselection');
});

r.test('enrich MUST flag the change and list both cells WHEN the cell differs between rounds', () => {
  const events = collect([
    identity(0, 16461107), signal(100, -100), signal(1000, -101),
    identity(6000, 16458509), signal(6100, -120), signal(7000, -122)
  ]).events;
  const {samples} = enrich(session([round(0, 0), round(1, 6000)]), events);
  assert.equal(samples[0].radio.cell_changed_since_previous, false, 'the first round has no prior');
  assert.equal(samples[1].radio.cell_changed_since_previous, true);
  assert.deepEqual(samples[1].radio.cells,
                   ['204.8.32004.16461107', '204.8.32004.16458509'],
                   'a change between windows still names the cell it left');
});

r.test('enrich MUST bound a round by the interval WHEN the round never recorded its duration', () => {
  const events = collect([identity(0, 16461107), signal(100, -100), signal(15000, -101)]).events;
  const {samples} = enrich(session([round(0, 0, {round_ms: null})]), events);
  assert.equal(samples[0].radio.lte.n, 2, 'the 20 s interval bounds a round with no round_ms');
});

const nrCell = (offsetMs, over = '') =>
  record(byName('nr_cell'),
         `NRARFCN: 646848, PCI: 119, RSRP: 4294967221, RSRQ: 4294967285, SCS: 0, Is SA: 0, ` +
         `Bandwidth: 100000000, BWP Support: 0, Neighbor Type: ${over || '1'}, Throughput: 0`,
         offsetMs);
const nrSignal = (offsetMs, rsrp) =>
  record(byName('nr_signal'), `QMI.NAS.2: received New SigInfo snr 24 rsrp ${rsrp}`, offsetMs);

r.test('nr_cell MUST read a signed level WHEN the log prints it as an unsigned integer', () => {
  const [cell] = collect([nrCell(0)]).events;
  assert.deepEqual([cell.rsrp, cell.rsrq], [-75, -11]);
  assert.equal(cell.bw_mhz, 100);
});

r.test('nr_cell MUST derive the frequency and every band the ARFCN falls in WHEN it is read', () => {
  const p = byName('nr_cell');
  const read = arfcn => p.read((`NRARFCN: ${arfcn}, PCI: 1, RSRP: 4294967221, RSRQ: 4294967285, ` +
    'SCS: 0, Is SA: 0, Bandwidth: 20000000, BWP Support: 0, Neighbor Type: 1').match(p.regex));
  assert.equal(read(646848).dl_mhz, 3702.72);
  assert.deepEqual(read(646848).bands, ['n77', 'n78'], 'the FR1 band ranges overlap');
  assert.equal(read(432030).dl_mhz, 2160.15);
  assert.deepEqual(read(432030).bands, ['n1', 'n65']);
});

r.test('nr_cell MUST keep no event WHEN the report is a cell the phone did not aggregate', () => {
  const c = collect([nrCell(0, '2')]);
  assert.equal(c.counts.nr_cell, 0);
  assert.equal(c.events.length, 0);
});

r.test('nr_cell MUST null the level and keep the identity WHEN the level is a sentinel', () => {
  const [cell] = collect([record(byName('nr_cell'),
    'NRARFCN: 646848, PCI: 456, RSRP: 4294934528, RSRQ: 4294934528, SCS: 0, Is SA: 0, ' +
    'Bandwidth: 100000000, BWP Support: 0, Neighbor Type: 1, Throughput: 0')]).events;
  assert.deepEqual([cell.rsrp, cell.rsrq], [null, null]);
  assert.equal(cell.pci, 456);
});

const lteRound = (...extra) =>
  collect([identity(0, 16461107), signal(100, -100), signal(1000, -101), ...extra]).events;
const nrCellOf = events => enrich(session([round(0, 0)]), events).samples[0].radio.nr_cell;

r.test('enrich MUST attach the NR cell beside the LTE cell WHEN the round measured NR signal', () => {
  const events = lteRound(nrCell(200), nrSignal(300, -80));
  const {radio} = enrich(session([round(0, 0)]), events).samples[0];
  assert.equal(radio.cell.gci, '204.8.32004.16461107');
  assert.deepEqual([radio.nr_cell.arfcn, radio.nr_cell.pci, radio.nr_cell.rsrp,
                    radio.nr_cell.offset_ms], [646848, 119, -75, 200]);
});

r.test('enrich MUST name no NR cell WHEN the round measured no NR signal', () => {
  assert.equal(nrCellOf(lteRound(nrCell(200))), null);
});

r.test('enrich MUST name no NR cell WHEN no report reaches the round', () => {
  assert.equal(nrCellOf(lteRound(nrSignal(300, -80))), null);
});

r.test('enrich MUST name no NR cell WHEN the report predates the round beyond the bound', () => {
  assert.equal(nrCellOf(lteRound(nrSignal(300, -80), nrCell(-130000))), null);
});

r.test('enrich MUST name the NR cell WHEN the report predates the round within the bound', () => {
  assert.equal(nrCellOf(lteRound(nrSignal(300, -80), nrCell(-60000))).offset_ms, -60000);
});

r.test('withoutDeviceAddresses MUST carry an address as its prefix WHEN a probe reported one', () => {
  const row = withoutDeviceAddresses({probes: {
    down: {egress_ip: '2a02:a420:27a2:805c:3df8:69d4:63d3:56d9'},
    udp: {public_ips: ['2a02:a420:27a2:805c:1:2:3:4', '77.63.125.222']}
  }});
  assert.equal(row.probes.down.egress_ip, '2a02:a420:27a2:805c::/64');
  assert.deepEqual(row.probes.udp.public_ips, ['2a02:a420:27a2:805c::/64', '77.63.125.222'],
                   'a public IPv4 address has no device half and is carried whole');
  assert.equal(prefix64(null), null);
});

const score = (offsetMs, slotName) =>
  record(byName('score'), 'evaluateCellularScore: RRC state: 1, forceActiveEval:0, RSRP: -103.000000, ' +
         `SNR: 0.400000, RSRQ: -16.000000, data slot: CTSubscriptionSlot${slotName}`, offsetMs);
const otherSignal = (offsetMs, rsrp) =>
  record(byName('lte_signal'), `QMI.NAS.1: received LTE SigInfo rssi -60 snr 9 rsrq -9 rsrp ${rsrp}`,
         offsetMs);
const slotOf = rec => collect([rec]).events[0].slot;

r.test('createCollector MUST record the SIM slot a line names WHEN the line carries a slot marker', () => {
  assert.equal(slotOf(otherSignal(0, -70)), 1, 'QMI NAS instances count from 1');
  assert.equal(slotOf(identity(0, 16461107)), 2, 'QMI DSD instances count from 0');
  assert.equal(slotOf(record(byName('cell_changed'),
                             'updateCurrentRatInfo 0, Cell Changed 1, nrCellType: 1')), 1,
               'the number before Cell Changed counts from 0');
  assert.equal(slotOf({...record(byName('serving_cell'),
    'Index: 0, MCC: 204, MNC: 16, Band info: 3, Area code: 69, Cell ID: <private>, EARFCN: 1800, ' +
    'PID: 214'), category: 'cm.1'}), 1, 'CommCenter category suffixes count from 1');
  assert.equal(slotOf(score(0, 'Two')), 2);
});

r.test('createCollector MUST record no slot WHEN the line carries no slot marker', () => {
  assert.equal(slotOf(record(byName('pdn_up'), 'ipv6ServiceUp: addr = 2a02:a420:1:2:3:4:5:6')), null);
});

r.test('enrich MUST drop the lines of the other SIM WHEN a score line names the data slot', () => {
  const events = collect([
    score(0, 'Two'), identity(0, 16461107), signal(100, -100), signal(1000, -101),
    otherSignal(500, -70),
    record(byName('rat_info'), 'QMI.DSD.0 RAT Info: kENDCFR1, MCC 204, MNC 4, TAC 1, cell_id 99', 1500)
  ]).events;
  const joined = enrich(session([round(0, 0)]), events);
  const {radio} = joined.samples[0];
  assert.deepEqual(radio.lte.samples.map(s => s[1]), [-100, -101]);
  assert.equal(radio.rat, 'kLTE', 'the RAT is read from the SIM carrying data');
  assert.equal(joined.plmn, '204-08');
  assert.equal(joined.other_sim_dropped, 2);
  assert.deepEqual(joined.data_slots, [2]);
});

r.test('enrich MUST keep lines from every slot WHEN no score line names a data slot', () => {
  const joined = enrich(session([round(0, 0)]),
                        collect([identity(0, 16461107), signal(100, -100), otherSignal(500, -70)]).events);
  assert.equal(joined.samples[0].radio.lte.n, 2);
  assert.equal(joined.other_sim_dropped, 0);
});

r.test('enrich MUST follow the data slot WHEN the score lines move it to the other SIM', () => {
  const events = collect([
    identity(0, 16461107), score(0, 'Two'), signal(100, -100),
    score(2000, 'One'), otherSignal(2500, -70), signal(3000, -101)
  ]).events;
  const {radio} = enrich(session([round(0, 0)]), events).samples[0];
  assert.deepEqual(radio.lte.samples.map(s => s[1]), [-100, -70]);
});

r.test('isSysdiagnoseArchive MUST hold only for a packed archive WHEN a path is given', () => {
  assert.equal(isSysdiagnoseArchive('sysdiagnose_2026.09.12_15-50-12+0200_iPhone.tar.gz'), true);
  assert.equal(isSysdiagnoseArchive('/a/b/system_logs.logarchive'), false);
});

r.test('extractSysdiagnose MUST unpack the log bundle alone and remove it WHEN cleanup runs', () => {
  const src = mkdtempSync(join(tmpdir(), 'nulog-fixture-'));
  const name = 'sysdiagnose_2026.09.12_15-50-12+0200_iPhone-OS_iPhone_24A435';
  mkdirSync(join(src, name, 'system_logs.logarchive', 'Persist'), {recursive: true});
  mkdirSync(join(src, name, 'logs', 'SystemVersion'), {recursive: true});
  mkdirSync(join(src, name, 'WiFi'), {recursive: true});
  writeFileSync(join(src, name, 'system_logs.logarchive', 'Persist', '0001.tracev3'), 'trace');
  writeFileSync(join(src, name, 'logs', 'SystemVersion', 'SystemVersion.plist'), 'plist');
  writeFileSync(join(src, name, 'WiFi', 'wifi.log'), 'not part of the join');
  const archive = join(src, `${name}.tar.gz`);
  execFileSync('tar', ['czf', archive, '-C', src, name]);

  const {archive: bundle, cleanup} = extractSysdiagnose(archive);
  assert.ok(existsSync(join(bundle, 'Persist', '0001.tracev3')), 'the log bundle is unpacked');
  assert.ok(existsSync(join(bundle, '..', 'logs', 'SystemVersion', 'SystemVersion.plist')),
            'the build plist is unpacked beside it');
  assert.equal(existsSync(join(bundle, '..', 'WiFi')), false, 'nothing else is unpacked');
  cleanup();
  assert.equal(existsSync(bundle), false, 'the unpacked copy is removed');
  rmSync(src, {recursive: true, force: true});
});

r.test('extractSysdiagnose MUST fail and leave nothing WHEN the archive holds no log bundle', () => {
  const src = mkdtempSync(join(tmpdir(), 'nulog-fixture-'));
  mkdirSync(join(src, 'other'), {recursive: true});
  writeFileSync(join(src, 'other', 'notes.txt'), 'no log bundle here');
  const archive = join(src, 'empty.tar.gz');
  execFileSync('tar', ['czf', archive, '-C', src, 'other']);
  assert.throws(() => extractSysdiagnose(archive), /system_logs\.logarchive/);
  rmSync(src, {recursive: true, force: true});
});

const mimoLine = (offsetMs, which, layers) =>
  record(byName('mimo'), `QMI.DSD.1 ${which} MIMO Layer${which === 'Total Downlink' ? 's' : ''}: ${layers}`,
         offsetMs);

r.test('enrich MUST report scheduled layers beside the offer WHEN the window holds both', () => {
  const events = collect([
    identity(0, 16461107), signal(100, -100),
    mimoLine(200, 'Max Network', 4), mimoLine(300, 'Max Scheduled', 2), mimoLine(400, 'Max Scheduled', 1)
  ]).events;
  const {mimo} = enrich(session([round(0, 0)]), events).samples[0].radio;
  assert.equal(mimo.network.med, 4);
  assert.equal(mimo.scheduled.med, 1, 'the median of the scheduled samples, not the offer');
  assert.equal(mimo.n, 3);
});

r.test('enrich MUST report no mimo WHEN the window holds no layer line', () => {
  const events = collect([identity(0, 16461107), signal(100, -100)]).events;
  assert.equal(enrich(session([round(0, 0)]), events).samples[0].radio.mimo, null);
});

r.test('parseBattery MUST return wall-clock milliseconds and degrees WHEN rows use the database clock', () => {
  const rows = parseBattery('93299883|28.7|99\n93299913|3319|98\n', 1696241527);
  assert.deepEqual(rows[0], {t: 1789541410000, temp_c: 28.7, level: 99});
  assert.equal(rows[1].temp_c, 33.2, 'a build writing centidegrees reads as degrees');
});

r.test('parseBattery MUST drop a row WHEN it carries no temperature', () => {
  assert.equal(parseBattery('93299883||99\n93299913|28.7|98\n', 0).length, 1);
});

r.test('nearestReading MUST return null WHEN the closest reading is older than the bound', () => {
  const samples = [{t: 1000, temp_c: 30, level: 50}, {t: 200000, temp_c: 31, level: 49}];
  assert.equal(nearestReading(samples, 150000, 20000), null);
  assert.equal(nearestReading(samples, 150000, 60000).temp_c, 31, 'within the bound the nearer one wins');
});

r.test('withBattery MUST leave a round untouched WHEN no reading lies within the bound', () => {
  const rows = [{seq: 0, t: AT}, {seq: 1, t: AT + 600000}];
  const out = withBattery(rows, [{t: AT + 1000, temp_c: 29.4, level: 88}]);
  assert.equal(out[0].battery.temp_c, 29.4);
  assert.equal(out[0].battery.age_ms, 1000);
  assert.equal(out[1].battery, undefined);
});

r.test('withBattery MUST return the rounds unchanged WHEN the archive carried no powerlog', () => {
  const rows = [{seq: 0, t: AT}];
  assert.equal(withBattery(rows, null), rows);
});

await r.run();
