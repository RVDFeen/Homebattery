// Testsuite voor de Homebattery-app. Geen extra pakketten nodig, alleen Node 18+.
//
//   node tests/run-tests.mjs            alle offline tests
//   node tests/run-tests.mjs --online   ook controleren tegen de live EnergyZero API
//   node tests/run-tests.mjs --filter=simulatie   alleen tests waarvan groep/naam dit bevat
//
// Wat er getest wordt:
//   1. Prijsdata      data/epex.csv: formaat, geen gaten, actueel, realistische waarden
//   2. Leveranciers   data/leveranciers.json: structuur, periodes, energiebelasting per jaar
//   3. Prijzen        berekende leveranciersprijzen vs. echte historische prijzen (fixtures)
//   4. Rekenkern      CSV-inlezen, simulatie, saldering, slim laden (met handberekende gevallen)
//   5. Interface      HTML/JS consistent, geen externe bronnen, thema, alle knoppen werken
//   6. End-to-end     volledige gebruikersflow in een nagebootste browser + vaste referentie-uitkomst
//   7. Scripts        tijdzone-omrekening, hulpscripts, GitHub Actions-config

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONLINE = process.argv.includes('--online');
const FILTER = (process.argv.find(a => a.startsWith('--filter=')) || '').slice(9).toLowerCase();
const lees = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------------ mini-testframework
const resultaten = [];
let huidigeGroep = '';
const groep = naam => { huidigeGroep = naam; };
const tests = [];
function test(naam, fn) { tests.push({ groep: huidigeGroep, naam, fn }); }

class Fout extends Error {}
const ok = (v, msg) => { if (!v) throw new Fout(msg || 'verwacht: waar'); };
const eq = (a, b, msg) => { if (a !== b) throw new Fout(`${msg ? msg + ': ' : ''}verwacht ${JSON.stringify(b)}, kreeg ${JSON.stringify(a)}`); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Fout(`${msg ? msg + ': ' : ''}verwacht ${b} ± ${tol}, kreeg ${a}`); };
const gooit = (fn, regex, msg) => {
  try { fn(); } catch (e) { if (regex && !regex.test(e.message)) throw new Fout(`${msg || 'foutmelding'}: "${e.message}" past niet bij ${regex}`); return; }
  throw new Fout(msg || 'verwacht een fout, maar er gebeurde niets');
};
const euro = s => parseFloat(String(s).replace(/[€\s.]/g, '').replace(',', '.').replace(/^-/, '-'));

// ------------------------------------------------------------------ hulpfuncties
const csvRegels = tekst => tekst.split(/\r?\n/).filter(Boolean).slice(1).map(l => l.split(','));
const HOUR = 3600e3;

function seeded(seed) { // mulberry32: herhaalbare "willekeurige" getallen
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Vaste, herhaalbare test-meterdata (cumulatieve standen per kwartier, HomeWizard-formaat)
function maakMeterCSV(vanUtc = Date.UTC(2025, 10, 1), totUtc = Date.UTC(2026, 10, 1)) {
  let imp = 0, exp = 0;
  const l = ['time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh'];
  for (let t = vanUtc; t < totUtc; t += 900e3) {
    const d = new Date(t + 3600e3), h = d.getUTCHours(), m = d.getUTCMonth();
    const zon = h >= 9 && h <= 17 ? 0.25 + 0.35 * Math.sin(Math.PI * (m + 0.5) / 12) : 0;
    const verbruik = 0.12 + (h >= 17 && h <= 21 ? 0.15 : 0);
    // stand aan het BEGIN van het kwartier (zoals HomeWizard), daarna het verbruik van dit kwartier
    l.push(`${d.toISOString().slice(0, 16).replace('T', ' ')},${imp.toFixed(3)},0,${exp.toFixed(3)},0`);
    if (zon > verbruik) exp += zon - verbruik; else imp += verbruik - zon;
  }
  return l.join('\n');
}

// ------------------------------------------------------------------ de app laden in een nagebootste browser
const HTML = lees('index.html');
const SCRIPT_START = HTML.lastIndexOf('<script>');
const APP_JS = HTML.slice(SCRIPT_START + 8, HTML.lastIndexOf('</script>'));
const HTML_DEEL = HTML.slice(0, SCRIPT_START);

// elementen met een id uit de HTML, met hun beginwaarden en klassen
const HTML_ELEMENTEN = new Map();
for (const m of HTML_DEEL.matchAll(/<(\w+)\b([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
  const attrs = m[2] + ' ' + m[4];
  HTML_ELEMENTEN.set(m[3], {
    tag: m[1],
    value: (attrs.match(/\bvalue="([^"]*)"/) || [])[1] ?? '',
    klassen: ((attrs.match(/\bclass="([^"]*)"/) || [])[1] ?? '').split(/\s+/).filter(Boolean),
    style: (attrs.match(/\bstyle="([^"]*)"/) || [])[1] ?? '',
    min: parseFloat((attrs.match(/\bmin="([^"]*)"/) || [])[1]),
    max: parseFloat((attrs.match(/\bmax="([^"]*)"/) || [])[1]),
  });
}

function maakElement(id, info = { value: '', klassen: [], style: '' }) {
  const klassen = new Set(info.klassen);
  const luisteraars = {};
  const style = {};
  for (const decl of info.style.split(';')) { const [k, v] = decl.split(':').map(s => s && s.trim()); if (k) style[k] = v; }
  const el = {
    id, value: info.value, textContent: '', options: [], style, _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === '') this.options = []; }, // net als in een browser: leegmaken wist de kinderen
    get className() { return [...klassen].join(' '); },
    set className(v) { klassen.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => klassen.add(c)); },
    classList: {
      add: c => klassen.add(c), remove: c => klassen.delete(c), contains: c => klassen.has(c),
      toggle: (c, aan) => { const nu = aan === undefined ? !klassen.has(c) : !!aan; nu ? klassen.add(c) : klassen.delete(c); return nu; },
    },
    addEventListener(ev, fn) { (luisteraars[ev] ??= []).push(fn); },
    appendChild(c) { el.options.push(c); return c; },
    vuur(ev, arg = {}) { for (const fn of luisteraars[ev] || []) fn({ target: el, preventDefault() {}, ...arg }); },
  };
  return el;
}

async function laadApp({ fetchFn, opgeslagen = {} } = {}) {
  const els = new Map();
  for (const [id, info] of HTML_ELEMENTEN) els.set(id, maakElement(id, info));
  const bodyKlassen = maakElement('body');
  const opslag = new Map(Object.entries(opgeslagen));
  let thema = null;
  const fouten = [];
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => fouten.push(a.join(' ')) },
    setTimeout, clearTimeout, queueMicrotask, Promise, Intl, Date, Math, JSON, Map, Set,
    document: {
      getElementById: id => els.get(id) || null,
      createElement: tag => maakElement('<' + tag + '>'),
      body: { classList: bodyKlassen.classList },
      documentElement: { getAttribute: () => thema, setAttribute: (k, v) => { if (k === 'data-theme') thema = v; } },
    },
    window: { addEventListener() {} },
    matchMedia: () => ({ matches: false }),
    location: { protocol: 'http:' },
    localStorage: { getItem: k => opslag.has(k) ? opslag.get(k) : null, setItem: (k, v) => opslag.set(k, String(v)) },
    FileReader: class { readAsText(f) { this.result = f.__tekst; this.onload && this.onload(); } },
    fetch: fetchFn || (async url => {
      const p = url.split('?')[0];
      if (/^https?:/.test(p)) return { ok: false, status: 404, text: async () => '' };
      const vol = path.join(ROOT, p);
      if (!fs.existsSync(vol)) return { ok: false, status: 404, text: async () => '' };
      const t = fs.readFileSync(vol, 'utf8');
      return { ok: true, status: 200, text: async () => t };
    }),
  };
  vm.createContext(ctx);
  const blootstellen = `
;globalThis.__t = { vasteKostenMaand, berekenAdvies, sorteerAdvies, berekenLeverancierAdvies, parseCSV, loadMeterCSV, loadPriceCSV, lookupPrice, simulate, markGridChargeWindow,
  kostenMetSalderen, kostenZonderSalderen, vastOp, terugVoor, terugPrijzen, ebVoor, maakPrijzenTekst, kiesLeverancier, recompute,
  setLevConfig: v => { levConfig = v; },
  get staat(){ return { berekening: laatsteBerekening, meterRows, priceRows, epexRows, levConfig, resMode, gridChargeMode, saldMode, stratMode, priceRawText }; } };`;
  vm.runInContext(APP_JS + blootstellen, ctx, { filename: 'index.html' });
  await new Promise(r => setTimeout(r, 30)); // laat het asynchroon laden van de prijzen afronden
  const T = ctx.__t;
  return {
    T, els, el: id => els.get(id), ctx, fouten,
    heeftResultaten: () => bodyKlassen.classList.contains('has-results'),
    thema: () => thema, opslag,
    upload: (naam, tekst) => els.get('fileMeter').vuur('change', { target: { files: [{ name: naam, __tekst: tekst }] } }),
    kies: naam => { const s = els.get('leverancierSelect'); s.value = naam; s.vuur('change'); },
    kiesBatterij: id => { const s = els.get('batterijSelect'); s.value = id; s.vuur('change'); },
    klik: id => els.get(id).vuur('click'),
    schuif: (id, waarde) => { const e = els.get(id); e.value = String(waarde); e.vuur('input'); },
  };
}

// ==================================================================================
groep('1. Prijsdata (data/epex.csv)');
// ==================================================================================
const EPEX_TEKST = lees('data/epex.csv');
const EPEX = csvRegels(EPEX_TEKST).map(([d, p]) => ({ d, ms: Date.parse(d), p: +p }));

test('kopregel is "datum,prijs"', () => eq(EPEX_TEKST.split(/\r?\n/)[0], 'datum,prijs'));
test('elke regel heeft een geldige datum en prijs', () => {
  const slecht = EPEX.filter(r => !Number.isFinite(r.ms) || !Number.isFinite(r.p) || !/^\d{4}-\d\d-\d\dT\d\d:00:00[+-]\d\d:\d\d$/.test(r.d));
  eq(slecht.length, 0, 'ongeldige regels (eerste: ' + (slecht[0]?.d ?? '-') + ')');
});
test('tijdstippen lopen op zonder gaten of dubbelingen (precies 1 uur ertussen)', () => {
  const fout = [];
  for (let i = 1; i < EPEX.length; i++) if (EPEX[i].ms - EPEX[i - 1].ms !== HOUR) fout.push(EPEX[i - 1].d + ' → ' + EPEX[i].d);
  eq(fout.length, 0, `${fout.length} onderbrekingen, bijv. ${fout.slice(0, 3).join('; ')}`);
});
test('tijdzone-aanduiding klopt met Nederlandse zomer/wintertijd', () => {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', timeZoneName: 'shortOffset' });
  const fout = EPEX.filter((r, i) => i % 97 === 0).filter(r => {
    const tz = fmt.formatToParts(new Date(r.ms)).find(p => p.type === 'timeZoneName').value; // "GMT+1" / "GMT+2"
    return r.d.slice(19) !== (tz === 'GMT+2' ? '+02:00' : '+01:00');
  });
  eq(fout.length, 0, 'verkeerde offset bij ' + (fout[0]?.d ?? ''));
});
test('begint uiterlijk op 23-10-2022', () => ok(EPEX[0].d <= '2022-10-23T00:00:00+02:00', 'begint pas op ' + EPEX[0].d));
test('is actueel (prijzen t/m minstens vandaag)', () => {
  const vandaag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  const laatste = EPEX.at(-1).d.slice(0, 10);
  ok(laatste >= vandaag, `laatste prijs is van ${laatste}, vandaag is ${vandaag} — draait de GitHub Action nog?`);
});
test('prijzen zijn realistisch (tussen -€1 en €2 per kWh excl. btw)', () => {
  const raar = EPEX.filter(r => r.p < -1 || r.p > 2);
  eq(raar.length, 0, 'onrealistische prijs op ' + (raar[0]?.d ?? ''));
});
test('negatieve prijzen komen voor (anders is er iets mis met de bron)', () => ok(EPEX.some(r => r.p < 0)));

// ==================================================================================
groep('2. Leveranciers (data/leveranciers.json)');
// ==================================================================================
let CFG;
test('is geldige JSON met btw, energiebelasting en leveranciers', () => {
  CFG = JSON.parse(lees('data/leveranciers.json'));
  near(CFG.btw, 0.21, 0.05, 'btw');
  ok(CFG.energiebelasting && typeof CFG.energiebelasting === 'object', 'energiebelasting ontbreekt');
  ok(Object.keys(CFG.leveranciers || {}).length >= 5, 'te weinig leveranciers');
});
test('energiebelasting bekend voor elk jaar in de prijsdata', () => {
  const jaren = [...new Set(EPEX.map(r => r.d.slice(0, 4)))];
  const mist = jaren.filter(j => CFG.energiebelasting[j] === undefined);
  eq(mist.length, 0, 'ontbreekt voor ' + mist.join(', '));
});
test('energiebelasting heeft realistische waarden (€0,01–€0,20 excl. btw)', () => {
  for (const [j, v] of Object.entries(CFG.energiebelasting)) ok(v > 0.01 && v < 0.2, `${j}: ${v}`);
});
test('elke leverancier heeft geldige, oplopende periodes', () => {
  for (const [naam, per] of Object.entries(CFG.leveranciers)) {
    ok(Array.isArray(per) && per.length > 0, naam + ': geen periodes');
    per.forEach((p, i) => {
      ok(/^\d{4}-\d\d-\d\d$/.test(p.vanaf) && !Number.isNaN(Date.parse(p.vanaf)), `${naam}: ongeldige datum ${p.vanaf}`);
      ok(typeof p.vast === 'number' && p.vast > 0 && p.vast < 0.3, `${naam} ${p.vanaf}: vast=${p.vast} onrealistisch`);
      if (i > 0) ok(p.vanaf > per[i - 1].vanaf, `${naam}: periodes niet oplopend bij ${p.vanaf}`);
    });
  }
});
test('huidige opslag per leverancier is realistisch (€-0,01 tot €0,08 incl. btw)', () => {
  for (const [naam, per] of Object.entries(CFG.leveranciers)) {
    const p = per.at(-1), eb = CFG.energiebelasting[p.vanaf.slice(0, 4)];
    const opslag = (p.vast - eb) * (1 + CFG.btw);
    ok(opslag > -0.01 && opslag < 0.08, `${naam}: opslag €${opslag.toFixed(4)}`);
  }
});
test('vaste kosten bekend (of bewust leeg) voor elke leverancier, met bron', () => {
  ok(CFG.vasteKosten && typeof CFG.vasteKosten === 'object', 'vasteKosten ontbreekt');
  for (const naam of Object.keys(CFG.leveranciers)) {
    const v = CFG.vasteKosten[naam];
    ok(v, naam + ': geen vasteKosten-regel');
    ok(v.perMaand === null || (v.perMaand >= 0 && v.perMaand <= 20), `${naam}: €${v.perMaand} per maand onrealistisch`);
    ok(typeof v.bron === 'string' && v.bron.length > 3, naam + ': bron ontbreekt');
  }
  for (const naam of Object.keys(CFG.vasteKosten)) ok(CFG.leveranciers[naam], 'vasteKosten voor onbekende leverancier: ' + naam);
});
test('laatstGecontroleerd is niet ouder dan 9 maanden', () => {
  ok(CFG.laatstGecontroleerd, 'veld ontbreekt');
  const dagen = (Date.now() - Date.parse(CFG.laatstGecontroleerd)) / 864e5;
  ok(dagen < 275, `laatst gecontroleerd ${Math.round(dagen)} dagen geleden — draai /tarieven-check`);
});

// ==================================================================================
groep('2b. Thuisbatterijen (data/batterijen.json)');
// ==================================================================================
let BAT;
test('is geldige JSON met een lijst batterijen', () => {
  BAT = JSON.parse(lees('data/batterijen.json')).batterijen;
  ok(Array.isArray(BAT) && BAT.length >= 10, 'te weinig batterijen');
});
test('elke batterij heeft unieke id, merk, model, type en bron', () => {
  const ids = new Set();
  for (const b of BAT) {
    ok(/^[a-z0-9-]+$/.test(b.id), 'ongeldige id: ' + b.id);
    ok(!ids.has(b.id), 'dubbele id: ' + b.id); ids.add(b.id);
    ok(b.merk && b.model, b.id + ': merk/model ontbreekt');
    ok(['stekker', 'vast'].includes(b.type), b.id + ': type moet stekker of vast zijn');
    ok(/^https:\/\//.test(b.bron || ''), b.id + ': bron (https-link) ontbreekt');
    ok(Array.isArray(b.geschat) && b.geschat.every(g => ['capaciteit', 'laadKw', 'ontlaadKw', 'rendement'].includes(g)), b.id + ': ongeldige "geschat"');
  }
});
test('alle waarden passen binnen de schuifjes van de app', () => {
  const grens = { capaciteit: 'cap', laadKw: 'charge', ontlaadKw: 'discharge', rendement: 'rte' };
  for (const b of BAT) for (const [veld, id] of Object.entries(grens)) {
    const { min, max } = HTML_ELEMENTEN.get(id);
    ok(typeof b[veld] === 'number' && b[veld] >= min && b[veld] <= max, `${b.id}: ${veld}=${b[veld]} valt buiten schuifje ${id} (${min}–${max})`);
  }
});
test('waarden zijn realistisch (rendement 60–98%, volladen in 1 tot 12 uur)', () => {
  for (const b of BAT) {
    ok(b.rendement >= 60 && b.rendement <= 98, b.id + ': rendement ' + b.rendement);
    const uren = b.capaciteit / b.laadKw;
    ok(uren >= 1 && uren <= 12, `${b.id}: volladen duurt ${uren.toFixed(1)} uur`);
  }
});
test('prijzen: bekend → realistisch en met bron; onbekend → uitleg', () => {
  for (const b of BAT) {
    ok(typeof b.prijsInfo === 'string' && b.prijsInfo.length > 10, b.id + ': prijsInfo ontbreekt');
    if (b.prijs === null) continue;
    ok(Number.isFinite(b.prijs) && b.prijs > 300 && b.prijs < 30000, `${b.id}: prijs €${b.prijs}`);
    const perKwh = b.prijs / b.capaciteit;
    ok(perKwh > 100 && perKwh < 1500, `${b.id}: €${Math.round(perKwh)} per kWh is onrealistisch`);
    ok(/^https:\/\//.test(b.prijsBron || ''), b.id + ': prijsBron ontbreekt');
  }
  ok(BAT.filter(b => b.prijs).length >= 8, 'te weinig batterijen met prijs');
});
test('door de gebruiker gevraagde modellen staan erin', () => {
  const heeft = re => BAT.some(b => re.test(b.merk + ' ' + b.model));
  for (const re of [/Zonneplan.*\b10 kWh/, /Zonneplan.*\b20 kWh/, /Zonneplan.*\b30 kWh/, /Quatt.*9,3/, /Quatt.*55,8/, /Anker.*Solarbank/, /Anker.*X1/])
    ok(heeft(re), 'ontbreekt: ' + re);
  const quattCaps = [...new Set(BAT.filter(b => b.merk === 'Quatt').map(b => b.capaciteit))];
  eq(quattCaps.length, 6, 'alle 6 Quatt-capaciteiten');
});

// ==================================================================================
groep('3. Berekende leveranciersprijzen vs. echte historische prijzen');
// ==================================================================================
const FIXTURES = { 'Zonneplan': 'zonneplan', 'Tibber': 'tibber', 'Coolblue Energie': 'coolblue-energie', 'ZonderGas': 'zondergas' };
for (const [naam, slug] of Object.entries(FIXTURES)) {
  test(`${naam}: juni 2026 komt overeen met de oorspronkelijke prijzen`, async () => {
    const app = await laadApp();
    app.klik('tariefHistorisch'); // vergelijking met wat er toen echt gerekend werd
    const gegenereerd = new Map(csvRegels(app.T.maakPrijzenTekst(naam)).map(([d, p]) => [d, +p]));
    const echt = csvRegels(lees(`tests/fixtures/prijzen-${slug}-2026-06.csv`)).map(([d, p]) => [d, +p]);
    let exact = 0, max = 0;
    for (const [d, p] of echt) {
      ok(gegenereerd.has(d), 'geen prijs berekend voor ' + d);
      const fout = Math.abs(gegenereerd.get(d) - p);
      if (fout < 0.0001) exact++; max = Math.max(max, fout);
    }
    ok(exact / echt.length >= 0.98, `slechts ${(100 * exact / echt.length).toFixed(1)}% exact`);
    ok(max < 0.005, `grootste afwijking €${max.toFixed(4)}`);
  });
}
test('formule: prijs = (kale prijs + vast) × 1,21, ook voor "eigen opslag"', async () => {
  const app = await laadApp();
  app.kies('__eigen__');
  const eerste = csvRegels(app.T.staat.priceRawText)[0];
  const verwacht = (EPEX[0].p + 0.018 + CFG.energiebelasting[EPEX[0].d.slice(0, 4)]) * 1.21; // opslag-veld + belasting van dat jaar
  eq(eerste[0], EPEX[0].d);
  near(+eerste[1], verwacht, 1e-6);
});
test('terugleverprijs = kale beursprijs: verschil tussen leveranciers zit alleen in de afname', async () => {
  const app = await laadApp();
  const week = maakMeterCSV(Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 8)); // juni 2026: beide opslagen constant
  app.upload('verbruik.csv', week);
  const afname = app.T.loadMeterCSV(week, 'uur').reduce((t, r) => t + r.importKwh, 0);
  const kostenZonder = naam => { app.kies(naam); // tabelrij "Zonder salderen", kolom "zonder batterij" (totaal)
    return euro(app.el('scenarioTable').options[0].innerHTML.split('<td')[2].replace(/^[^>]*>/, '').split('<')[0]); };
  const vastJuni = naam => CFG.leveranciers[naam].filter(p => p.vanaf <= '2026-06-01').at(-1).vast;
  const verschil = kostenZonder('Mijndomein Energie') - kostenZonder('ZonderGas');
  const vastVerschil = 12 * (app.T.vasteKostenMaand('Mijndomein Energie') - app.T.vasteKostenMaand('ZonderGas')) * 7 / 365; // 7 dagen
  const verwacht = afname * (vastJuni('Mijndomein Energie') - vastJuni('ZonderGas')) * (1 + CFG.btw) + vastVerschil;
  near(verschil, verwacht, 0.02, 'kostenverschil (als teruglevering meetelt, wijkt dit af)');
  // terugleverkosten verlagen de terugleverprijs
  const voor = kostenZonder('ZonderGas');
  app.schuif('terugleverkosten', 0.02);
  const terug = app.T.loadMeterCSV(week, 'uur').reduce((t, r) => t + r.exportKwh, 0);
  near(kostenZonder('ZonderGas') - voor, terug * 0.02, 0.02, 'terugleverkosten × teruglevering');
});
test('vastOp: periode, terug in de tijd en nieuw jaar corrigeren voor energiebelasting', async () => {
  const app = await laadApp();
  app.T.setLevConfig({ btw: 0.21, energiebelasting: { 2025: 0.10, 2026: 0.09, 2027: 0.08 }, leveranciers: {} });
  const per = [{ vanaf: '2025-06-01', vast: 0.12 }, { vanaf: '2026-03-01', vast: 0.11 }];
  near(app.T.vastOp(per, '2025-07-01T10:00:00+02:00'), 0.12, 1e-12, 'binnen periode');
  near(app.T.vastOp(per, '2025-12-31T23:00:00+01:00'), 0.12, 1e-12, 'binnen periode, zelfde jaar');
  near(app.T.vastOp(per, '2026-03-01T00:00:00+01:00'), 0.11, 1e-12, 'eerste uur van nieuwe periode');
  near(app.T.vastOp(per, '2027-02-01T00:00:00+01:00'), 0.10, 1e-12, 'laatste periode schuift mee met belasting 2027');
  near(app.T.vastOp(per, '2024-05-01T00:00:00+02:00'), 0.12, 1e-12, 'vóór eerste periode: 2024 onbekend → geen correctie');
  app.T.setLevConfig({ btw: 0.21, energiebelasting: { 2024: 0.11, 2025: 0.10 }, leveranciers: {} });
  near(app.T.vastOp(per, '2024-05-01T00:00:00+02:00'), 0.13, 1e-12, 'vóór eerste periode: gecorrigeerd naar belasting 2024');
});

// ==================================================================================
groep('4. Rekenkern');
// ==================================================================================
let K; // rekenfuncties van de app
test('app-script laadt zonder fouten', async () => { K = (await laadApp()).T; ok(K && K.simulate); });

test('parseCSV: Windows-regeleinden, lege regels en te korte regels', () => {
  const r = K.parseCSV('a,b\r\n1,2\r\n\r\n3\r\n4,5\r\n');
  eq(r.length, 2); eq(r[0].a, '1'); eq(r[1].b, '5');
});
test('meter-CSV: cumulatieve standen worden verbruik per uur', () => {
  const csv = 'time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh\n' +
    '2026-01-01 00:00,100,50,10,0\n2026-01-01 00:15,100.5,50,10,0\n2026-01-01 00:30,100.5,50.5,10,0\n' +
    '2026-01-01 00:45,101,50.5,10.2,0\n2026-01-01 01:00,101,50.5,10.2,0.3\n2026-01-01 01:15,101.2,50.5,10.2,0.3\n';
  // de stand op een rij is de stand aan het BEGIN van dat kwartier: 00:45→01:00 hoort nog bij uur 00
  const r = K.loadMeterCSV(csv, 'uur');
  eq(r.length, 2);
  eq(r[0].hourKey, '2026-01-01 00'); near(r[0].importKwh, 1.5, 1e-9); near(r[0].exportKwh, 0.5, 1e-9);
  eq(r[1].hourKey, '2026-01-01 01'); near(r[1].importKwh, 0.2, 1e-9); near(r[1].exportKwh, 0, 1e-9);
});
test('meter-CSV: kwartierresolutie en ongesorteerde invoer', () => {
  const csv = 'time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh\n' +
    '2026-01-01 00:30,2,0,0,0\n2026-01-01 00:00,0,0,0,0\n2026-01-01 00:15,1,0,0,0\n';
  const r = K.loadMeterCSV(csv, 'kwartier');
  eq(r.map(x => x.hourKey).join('|'), '2026-01-01 00:00|2026-01-01 00:15');
  near(r[0].importKwh, 1, 1e-9); near(r[1].importKwh, 1, 1e-9);
});
test('meter-CSV: meterwissel (stand gaat omlaag) telt niet als negatief verbruik', () => {
  const csv = 'time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh\n2026-01-01 00:00,500,0,0,0\n2026-01-01 00:15,2,0,0,0\n2026-01-01 00:30,3,0,0,0\n';
  const r = K.loadMeterCSV(csv, 'uur');
  near(r[0].importKwh, 1, 1e-9);
});
test('meter-CSV: duidelijke foutmelding bij verkeerd bestand', () => {
  gooit(() => K.loadMeterCSV('datum,prijs\n2026-01-01T00:00:00+01:00,0.2\n', 'uur'), /meter-CSV/);
  gooit(() => K.loadMeterCSV('', 'uur'), /leeg/);
});
test('prijzen: kwartierwaarden worden per uur gemiddeld; kwartier valt terug op uurprijs', () => {
  const txt = 'datum,prijs\n2026-01-01T00:00:00+01:00,0.10\n2026-01-01T00:15:00+01:00,0.20\n2026-01-01T00:30:00+01:00,0.30\n2026-01-01T00:45:00+01:00,0.40\n2026-01-01T01:00:00+01:00,0.50\n';
  const uur = K.loadPriceCSV(txt, 'uur');
  near(uur.get('2026-01-01 00'), 0.25, 1e-12); near(uur.get('2026-01-01 01'), 0.5, 1e-12);
  const kw = K.loadPriceCSV(txt, 'kwartier');
  near(K.lookupPrice(kw, '2026-01-01 00:15', 'kwartier'), 0.2, 1e-12);
  near(K.lookupPrice(kw, '2026-01-01 01:30', 'kwartier'), 0.5, 1e-12, 'terugval op uurprijs');
  eq(K.lookupPrice(kw, '2026-01-02 05:00', 'kwartier'), undefined);
});

// simulate(data, capaciteit, laadKw, ontlaadKw, rte, strategie, marge, stapUren, slimLaden)
const rij = (i, imp, exp, pi, pe) => ({ hourKey: `2026-01-01 ${String(i).padStart(2, '0')}`, importKwh: imp, exportKwh: exp, importPrice: pi, exportPrice: pe });

test('handberekend: zon overdag opslaan, \'s avonds gebruiken (100% rendement)', () => {
  const data = [rij(0, 0, 2, 0.30, 0.05), rij(1, 3, 0, 0.30, 0.05)];
  const s = K.simulate(data, 10, 5, 5, 100, 'naive', 0, 1, false);
  near(s[0].exportKwh, 0, 1e-9, 'zonnestroom gaat de batterij in'); near(s[1].importKwh, 1, 1e-9, 'resterende afname');
  near(K.kostenZonderSalderen(data) - K.kostenZonderSalderen(s), 2 * 0.30 - 2 * 0.05, 1e-9, 'besparing');
});
test('handberekend: 81% rendement → 2 kWh erin, 1,62 kWh eruit', () => {
  const data = [rij(0, 0, 2, 0.30, 0.05), rij(1, 3, 0, 0.30, 0.05)];
  const s = K.simulate(data, 10, 5, 5, 81, 'naive', 0, 1, false);
  near(s[1].importKwh, 3 - 1.62, 1e-9);
});
test('handberekend: capaciteit en laad-/ontlaadvermogen worden gerespecteerd', () => {
  const data = [rij(0, 0, 10, 0.3, 0.05), rij(1, 10, 0, 0.3, 0.05)];
  const s = K.simulate(data, 3, 2, 1.5, 100, 'naive', 0, 1, false);
  near(s[0].exportKwh, 8, 1e-9, 'max 2 kW laden'); near(s[1].importKwh, 8.5, 1e-9, 'max 1,5 kW ontladen');
  const s2 = K.simulate(data, 1, 5, 5, 100, 'naive', 0, 1, false);
  near(s2[0].exportKwh, 9, 1e-9, 'max 1 kWh capaciteit');
});
test('prijs-bewust: ontlaadt niet als stroom nu goedkoper is dan de opgeslagen energie', () => {
  const data = [rij(0, 0, 2, 0.30, 0.25), rij(1, 2, 0, 0.20, 0.05), rij(2, 2, 0, 0.40, 0.05)];
  const s = K.simulate(data, 10, 5, 5, 100, 'smart', 10, 1, false);
  near(s[1].importKwh, 2, 1e-9, 'uur 1 (te goedkoop): niet ontladen'); near(s[2].importKwh, 0, 1e-9, 'uur 2 (duur): wel ontladen');
});
test('saldering: elk uur tegen de uurprijs van dát uur verrekend', () => {
  const r = [rij(0, 10, 0, 0.30, 0.05), rij(1, 0, 4, 0.20, 0.05)];
  near(K.kostenMetSalderen(r), 10 * 0.30 - 4 * 0.20, 1e-9, 'teruglevering tegen de uurprijs van uur 1');
  near(K.kostenZonderSalderen(r), 10 * 0.30 - 4 * 0.05, 1e-9);
  // meer terug- dan afgenomen: 2 van de 5 kWh gesaldeerd (volle prijs), de rest kaal
  near(K.kostenMetSalderen([rij(0, 2, 5, 0.30, 0.10)]), 2 * 0.30 - 0.4 * 5 * 0.30 - 0.6 * 5 * 0.10, 1e-9, 'overschot tegen kale prijs');
  const metSalder = [{ ...rij(0, 0, 3, 0.30, 0.05), salderPrice: 0.28 }, rij(1, 5, 0, 0.40, 0.05)];
  near(K.kostenMetSalderen(metSalder), 5 * 0.40 - 3 * 0.28, 1e-9, 'salderPrice (bijv. min terugleverkosten) wordt gebruikt');
});
test('gemengd uur (zon én verbruik): batterij laadt met overschot én dekt de afname', () => {
  // uur 0: 3 kWh zon over → batterij. Uur 1: 1 kWh zon over én 2 kWh afname (wolk/waterkoker).
  const data = [rij(0, 0, 3, 0.30, 0.05), rij(1, 2, 1, 0.30, 0.05)];
  const s = K.simulate(data, 10, 5, 5, 100, 'naive', 0, 1, false);
  near(s[1].exportKwh, 0, 1e-9, 'overschot in uur 1 gaat de batterij in');
  near(s[1].importKwh, 0, 1e-9, 'afname in uur 1 komt uit de batterij');
  // maar niet ontladen in een uur waarin net vanaf het net is bijgeladen
  const net = [{ ...rij(0, 1, 0, 0.05, 0.02), gridChargeOk: true, tekort: 5 }];
  const sn = K.simulate(net, 5, 5, 5, 100, 'naive', 0, 1, true);
  ok(sn[0].importKwh > 1, 'in het laaduur wordt bijgeladen, niet ontladen');
});
test('zonder salderen: stroom naar dure uren verplaatsen wordt per uur gewaardeerd', () => {
  // middag: 2 kWh zon over, levert kaal €0,02 op; avond: 2 kWh nodig bij €0,50. Rendement 81%.
  const data = [rij(0, 0, 2, 0.10, 0.02), rij(1, 2, 0, 0.50, 0.02)];
  const s = K.simulate(data, 10, 5, 5, 81, 'smart', 10, 1, false, 'exportPrice');
  const besparing = K.kostenZonderSalderen(data) - K.kostenZonderSalderen(s);
  near(besparing, 2 * 0.81 * 0.50 - 2 * 0.02, 1e-9, 'avond 1,62 kWh vermeden (€0,81) − gemiste teruglevering (€0,04)');
  // dezelfde situatie levert zonder salderen meer op dan met salderen (daar is de middagstroom €0,10 waard)
  const metSP = r => ({ ...r, salderPrice: r.importPrice });
  const sm = K.simulate(data.map(metSP), 10, 5, 5, 81, 'smart', 10, 1, false, 'salderPrice');
  ok(besparing > K.kostenMetSalderen(data.map(metSP)) - K.kostenMetSalderen(sm), 'zonder salderen moet een batterij meer opleveren');
  // slim laden vanaf het net: goedkoop uur laden, duur uur gebruiken
  const net = [rij(0, 0.5, 0, 0.05, 0.02), rij(1, 3, 0, 0.45, 0.02)];
  K.markGridChargeWindow(net, 2, 2, 5, 5, Math.sqrt(0.81), 0);
  const sn = K.simulate(net, 5, 5, 5, 81, 'smart', 10, 1, true, 'exportPrice');
  ok(K.kostenZonderSalderen(net) - K.kostenZonderSalderen(sn) > 0, 'laden in het goedkope uur moet geld opleveren');
});
test('salderen: batterij die stroom naar dure uren verplaatst bespaart geld (ondanks verlies)', () => {
  // middag: 2 kWh zon over bij €0,10; avond: 2 kWh nodig bij €0,50. Rendement 81%.
  const metSP = r => ({ ...r, salderPrice: r.importPrice }); // zoals in de app: teruglevering tegen de uurprijs
  const data = [rij(0, 0, 2, 0.10, 0.02), rij(1, 2, 0, 0.50, 0.02)].map(metSP);
  const s = K.simulate(data, 10, 5, 5, 81, 'smart', 10, 1, false, 'salderPrice');
  const besparing = K.kostenMetSalderen(data) - K.kostenMetSalderen(s);
  near(besparing, 2 * 0.50 * 0.81 - 2 * 0.10, 1e-9, 'avond 1,62 kWh vermeden (€0,81) − middag 2 kWh niet teruggeleverd (€0,20)');
  ok(besparing > 0, 'batterij met salderen mag niet altijd verlies geven');
  // zonder prijsverschil: alleen verlies → prijs-bewuste strategie ontlaadt dan niet
  const vlak = [rij(0, 0, 2, 0.30, 0.02), rij(1, 2, 0, 0.30, 0.02)].map(metSP);
  const sv = K.simulate(vlak, 10, 5, 5, 81, 'smart', 10, 1, false, 'salderPrice');
  near(sv[1].importKwh, 2, 1e-9, 'bij gelijke prijs niet ontladen (zou alleen verlies zijn)');
});
test('slim laden: laadt op het goedkoopste uur binnen de horizon als er geen zon komt', () => {
  const data = [0.30, 0.10, 0.25, 0.40, 0.35, 0.30, 0.28, 0.33].map((p, i) => rij(i, 0.5, 0, p, 0.02));
  K.markGridChargeWindow(data, 4, 4, 5, 2, 1, 0);
  eq(data.slice(0, 2).map(d => d.gridChargeOk).join(), 'false,true', 'uur 0 wacht op het goedkopere uur 1');
  ok(!data[3].gridChargeOk && !data[4].gridChargeOk, 'dure uren (0,40 en 0,35) mogen nooit laden als er binnen de horizon goedkoper komt');
});
test('slim laden: laadt niet als er genoeg zon verwacht wordt', () => {
  const data = [rij(0, 0.5, 0, 0.10, 0.02), rij(1, 0, 6, 0.05, 0.02), rij(2, 0.5, 0, 0.40, 0.02)];
  K.markGridChargeWindow(data, 3, 3, 5, 10, 1, 0);
  ok(!data[0].gridChargeOk, 'uur 0: zon in uur 1 vult de batterij al, dus niet van het net laden');
  const weinigZon = [rij(0, 0.5, 0, 0.10, 0.02), rij(1, 0, 1, 0.20, 0.02), rij(2, 0.5, 0, 0.40, 0.02)];
  K.markGridChargeWindow(weinigZon, 3, 3, 5, 10, 1, 0);
  ok(weinigZon[0].gridChargeOk, 'uur 0: te weinig zon verwacht, dus wel laden op dit goedkope uur');
});

test('500 willekeurige scenario\'s: natuurkundige grenzen worden nooit overschreden', () => {
  const rnd = seeded(42);
  for (let n = 0; n < 500; n++) {
    const len = 24 + Math.floor(rnd() * 72);
    const data = Array.from({ length: len }, (_, i) => {
      const zon = rnd() < 0.4 ? rnd() * 3 : 0, verbruik = rnd() * 2;
      const pi = -0.05 + rnd() * 0.6;
      return { hourKey: 'k' + i, importKwh: Math.max(0, verbruik - zon), exportKwh: Math.max(0, zon - verbruik), importPrice: pi, exportPrice: pi / 1.21 - 0.11 };
    });
    const cap = 1 + rnd() * 15, lk = 0.5 + rnd() * 5, ok_ = 0.5 + rnd() * 5, rte = 70 + rnd() * 30;
    const strat = rnd() < 0.5 ? 'naive' : 'smart', stap = rnd() < 0.5 ? 1 : 0.25;
    const s = K.simulate(data, cap, lk, ok_, rte, strat, rnd() * 50, stap, false);
    eq(s.length, data.length);
    let opgeladen = 0, ontladen = 0;
    s.forEach((r, i) => {
      const extraOpslag = data[i].exportKwh - r.exportKwh, minderAfname = data[i].importKwh - r.importKwh;
      ok(r.importKwh >= -1e-9 && r.exportKwh >= -1e-9, 'negatieve energie');
      ok(extraOpslag >= -1e-9 && extraOpslag <= lk * stap + 1e-9, 'laadvermogen overschreden');
      ok(minderAfname >= -1e-9 && minderAfname <= ok_ * stap + 1e-9, 'ontlaadvermogen overschreden');
      opgeladen += extraOpslag; ontladen += minderAfname;
      ok(opgeladen * Math.sqrt(rte / 100) - ontladen / Math.sqrt(rte / 100) <= cap + 1e-6, 'capaciteit overschreden');
    });
    ok(ontladen <= opgeladen * rte / 100 + 1e-6, `energie uit het niets (scenario ${n})`);
  }
});
test('teruglevering: voorwaarden per leverancier (bonus, verkoopvergoeding, saldering)', () => {
  const eb26 = K.ebVoor('2026');
  const zp = K.terugVoor('Zonneplan');
  let p = K.terugPrijzen(zp, 0.10, '2026-06-01 12', 0);
  near(p.exportPrice, 0.10 + 0.02 + 0.01, 1e-12, 'Zonneplan: beurs + 2 ct + 10% bonus');
  near(p.salderPrice, (0.10 + 0.02 + eb26) * 1.21 + 0.01, 1e-12, 'Zonneplan binnen saldering: + EB + btw');
  p = K.terugPrijzen(zp, -0.05, '2026-06-01 13', 0);
  near(p.exportPrice, -0.03, 1e-12, 'negatieve prijs: geen bonus');
  const tib = K.terugVoor('Tibber');
  near(K.terugPrijzen(tib, 0.10, '2026-06-01 12', 0).exportPrice, 0.10 - 0.0248, 1e-12, 'Tibber: verkoopvergoeding eraf');
  const ne = K.terugVoor('NextEnergy');
  near(K.terugPrijzen(ne, 0.10, '2026-06-01 12', 0).exportPrice, 0.15, 1e-12, 'NextEnergy: 50% bonus overdag');
  near(K.terugPrijzen(ne, 0.10, '2026-06-01 22', 0).exportPrice, 0.10, 1e-12, 'NextEnergy: geen bonus na 22 uur');
  const onb = K.terugVoor('Quatt');
  ok(!onb.bekend, 'Quatt hoort (nog) onbekend te zijn');
  near(K.terugPrijzen(onb, 0.10, '2026-06-01 12', 0.01).exportPrice, 0.09, 1e-12, 'onbekend: beursprijs min extra kosten');
});
test('disclaimer staat op de pagina met de controledatum', async () => {
  ok(/id="disclaimer"/.test(HTML) && /geen financieel advies/.test(HTML), 'disclaimer ontbreekt');
  ok(/href="#disclaimer"/.test(HTML), 'geen verwijzing naar de disclaimer bij de resultaten');
  const app = await laadApp();
  const [y, m, d] = JSON.parse(lees('data/leveranciers.json')).laatstGecontroleerd.split('-');
  eq(app.el('disclaimerDatum').textContent, `${d}-${m}-${y}`);
});
test('batterij van 0 kWh verandert niets', () => {
  const data = [rij(0, 0, 2, 0.3, 0.05), rij(1, 2, 0, 0.3, 0.05)];
  const s = K.simulate(data, 0, 5, 5, 90, 'smart', 10, 1, true);
  near(K.kostenZonderSalderen(s), K.kostenZonderSalderen(data), 1e-12);
});

// ==================================================================================
groep('5. Interface');
// ==================================================================================
test('elk element dat de code gebruikt bestaat in de HTML', () => {
  const gebruikt = [...new Set([...APP_JS.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  const mist = gebruikt.filter(id => !HTML_ELEMENTEN.has(id));
  eq(mist.length, 0, 'ontbreekt: ' + mist.join(', '));
});
test('geen dubbele id\'s', () => {
  const ids = [...HTML_DEEL.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const dubbel = ids.filter((id, i) => ids.indexOf(id) !== i);
  eq(dubbel.length, 0, 'dubbel: ' + dubbel.join(', '));
});
test('handmatige prijzen-upload is verwijderd', () => {
  ok(!/filePrice|uploadPrice|prijzen-CSV uploaden/i.test(HTML), 'restanten van de prijzen-upload gevonden');
  eq((HTML_DEEL.match(/type="file"/g) || []).length, 1, 'precies één bestandsupload (meterdata)');
});
test('geen externe scripts, stylesheets of fonts (privacy)', () => {
  const extern = [...HTML.matchAll(/<(script|link|img)\b[^>]*(src|href)="(https?:)?\/\/[^"]+"/g)].map(m => m[0]);
  eq(extern.length, 0, 'externe bron: ' + extern[0]);
});
test('licht én donker thema gedefinieerd, met wisselknop', () => {
  ok(HTML_ELEMENTEN.has('themeToggle'), 'knop ontbreekt');
  ok(/prefers-color-scheme:\s*dark/.test(HTML), 'volgt systeeminstelling niet');
  ok(/:root\[data-theme="dark"\]/.test(HTML), 'handmatige donkere modus ontbreekt');
  ok(/:root:not\(\[data-theme="light"\]\)/.test(HTML), 'handmatige lichte modus wordt overschreven door systeem');
  ok(/<body/.test(HTML) && /body\{[^}]*background:var\(--bg\)/.test(HTML.replace(/\s+/g, '')), 'body heeft geen achtergrondkleur');
});
test('mobiel: viewport-meta en smalle-schermregels aanwezig', () => {
  ok(/name="viewport"[^>]*width=device-width/.test(HTML));
  ok(/@media \(max-width: ?520px\)/.test(HTML));
});
test('elke kleur in de donkere modus heeft een lichte tegenhanger', () => {
  const blok = sel => { const i = HTML.indexOf(sel); return HTML.slice(i, HTML.indexOf('}', i)); };
  const tokens = s => new Set([...s.matchAll(/(--[\w-]+):/g)].map(m => m[1]));
  const licht = tokens(blok(':root{')), donker = tokens(blok(':root[data-theme="dark"]{'));
  const mist = [...donker].filter(t => !licht.has(t));
  eq(mist.length, 0, 'alleen in donker: ' + mist.join(', '));
});

// ==================================================================================
groep('6. End-to-end (volledige gebruikersflow)');
// ==================================================================================
const METER = maakMeterCSV();
// Referentie-uitkomst: vaste testdata + Zonneplan, standaardinstellingen. Verandert dit getal, dan is
// de berekening veranderd. Bewust? Pas dan REFERENTIE aan (en noem het in je commit).
// Historie: 513.69 → 515.42 (nov 2026: terugleverprijs is nu de echte kale beursprijs i.p.v. afgeleid)
// → 515.37 (nov 2026: meterstand = begin van het kwartier, verbruik niet langer een kwartier te laat)
// → 442.52 (nov 2026: terugleveringsvoorwaarden per leverancier; Zonneplan +2 ct + 10% zonnebonus).
const REFERENTIE = { leverancier: 'Zonneplan', besparingPerJaar: 442.52, tolerantie: 0.02 };

test('startscherm: leveranciers geladen, nog geen resultaat', async () => {
  const app = await laadApp();
  eq(app.el('leverancierSelect').options.length, Object.keys(CFG.leveranciers).length + 1, 'aantal opties (incl. "eigen opslag")');
  ok(!app.heeftResultaten(), 'resultaat zichtbaar zonder data');
  ok(/Upload je meter-CSV/.test(app.el('status').textContent), 'status: ' + app.el('status').textContent);
});
test('alleen meterdata → vraagt om leverancier; daarna verschijnt het resultaat', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER);
  ok(app.el('uploadMeter').classList.contains('ok'), 'uploadvak niet gemarkeerd');
  ok(/Kies nu je energieleverancier/.test(app.el('status').textContent), 'status: ' + app.el('status').textContent);
  app.kies('Zonneplan');
  ok(app.heeftResultaten(), 'geen resultaat');
  ok(/t\/m/.test(app.el('levInfo').textContent), 'prijsbereik niet getoond');
  ok(/^€[\d.]+,\d\d$/.test(app.el('heroSavings').textContent), 'besparing: ' + app.el('heroSavings').textContent);
  eq(app.el('scenarioTable').options.length, 2, 'beide scenario\'s in de tabel');
  ok(app.el('bars').options.length >= 12, 'maandgrafiek heeft te weinig staven');
  ok(/365 dagen/.test(app.el('periodNote').innerHTML), 'periode: ' + app.el('periodNote').innerHTML);
});
test(`referentie-uitkomst: ${REFERENTIE.leverancier} levert €${REFERENTIE.besparingPerJaar} per jaar op`, async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies(REFERENTIE.leverancier);
  near(euro(app.el('heroSavings').textContent), REFERENTIE.besparingPerJaar, REFERENTIE.tolerantie, 'besparing per jaar');
  near(euro(app.el('heroBefore').textContent) - euro(app.el('heroAfter').textContent), euro(app.el('heroSavings').textContent), 0.011, 'zonder − met = besparing');
});
test('volgorde maakt niet uit: eerst leverancier, dan meterdata', async () => {
  const app = await laadApp();
  app.kies(REFERENTIE.leverancier); app.upload('verbruik.csv', METER);
  near(euro(app.el('heroSavings').textContent), REFERENTIE.besparingPerJaar, REFERENTIE.tolerantie);
});
test('alle knoppen werken en passen het resultaat aan', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const basis = app.el('heroSavings').textContent;
  app.klik('saldAan');
  ok(app.el('saldAan').classList.contains('active') && !app.el('saldUit').classList.contains('active'), 'saldering-knop');
  ok(app.el('heroSavings').textContent !== basis, 'met salderen geeft hetzelfde resultaat');
  app.klik('saldUit');
  eq(app.el('heroSavings').textContent, basis, 'terugschakelen');
  app.klik('stratNaive'); ok(app.el('reserveField').classList.contains('disabled'), 'marge niet uitgeschakeld');
  app.klik('stratSmart'); ok(!app.el('reserveField').classList.contains('disabled'), 'marge niet ingeschakeld');
  ok(app.el('horizonField').classList.contains('disabled'), 'horizon moet standaard uit staan');
  app.klik('gridChargeAan');
  ok(!app.el('horizonField').classList.contains('disabled'), 'horizon niet ingeschakeld');
  ok(/Slim laden staat aan/.test(app.el('dataNote').innerHTML), 'uitleg slim laden ontbreekt');
  app.klik('gridChargeUit');
  eq(app.el('heroSavings').textContent, basis, 'slim laden uit → zelfde als begin');
  eq(app.fouten.length, 0, 'console-fouten: ' + app.fouten.join(' | '));
});
test('alle schuifjes werken en tonen hun waarde', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const verwacht = { cap: ['12', '12.0 kWh'], charge: ['5', '5.0 kW'], discharge: ['2', '2.0 kW'], rte: ['85', '85%'], reserve: ['20', '20%'],
    horizon: ['12', '12 uur'], terugleverkosten: ['0.02', '€ 0,020'] };
  const moetVeranderen = ['cap', 'rte', 'terugleverkosten']; // de rest hangt af van de data (bijv. laadvermogen dat nooit de grens raakt)
  for (const [id, [waarde, label]] of Object.entries(verwacht)) {
    const voor = app.el('heroSavings').textContent;
    app.schuif(id, waarde);
    eq(app.el(id + 'Val').textContent, label, id + ' label');
    if (moetVeranderen.includes(id)) ok(app.el('heroSavings').textContent !== voor, id + ' verandert het resultaat niet');
  }
});
test('grotere batterij bespaart meer, kleinere minder', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const bij = c => { app.schuif('cap', c); return euro(app.el('heroSavings').textContent); };
  const b1 = bij(1), b7 = bij(7), b20 = bij(20);
  ok(b1 < b7 && b7 <= b20 + 0.01, `1 kWh: ${b1}, 7 kWh: ${b7}, 20 kWh: ${b20}`);
  ok(b1 > 0, 'ook een kleine batterij bespaart iets');
});
test('kwartierresolutie geeft vrijwel hetzelfde resultaat als uur', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const uur = euro(app.el('heroSavings').textContent);
  app.klik('resKwartier');
  ok(/kwartieren gekoppeld/.test(app.el('status').textContent), 'status: ' + app.el('status').textContent);
  near(euro(app.el('heroSavings').textContent), uur, uur * 0.02, 'kwartier vs uur');
  app.klik('resUur');
  near(euro(app.el('heroSavings').textContent), uur, 0.001, 'terug naar uur');
});
test('elke leverancier geeft een geldig resultaat', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER);
  for (const naam of Object.keys(CFG.leveranciers)) {
    app.kies(naam);
    ok(app.heeftResultaten(), naam + ': geen resultaat');
    const b = euro(app.el('heroSavings').textContent);
    ok(b > 100 && b < 1500, `${naam}: besparing €${b} onrealistisch`);
  }
});
test('"eigen opslag": veld verschijnt en een hogere opslag verandert het resultaat', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('__eigen__');
  eq(app.el('eigenField').style.display, 'block');
  const voor = app.el('heroBefore').textContent;
  app.el('eigenOpslag').value = '0.05'; app.el('eigenOpslag').vuur('input');
  ok(euro(app.el('heroBefore').textContent) > euro(voor), 'hogere opslag moet duurder zijn');
  app.kies('Zonneplan'); eq(app.el('eigenField').style.display, 'none');
});
test('verkeerd bestand geeft een duidelijke melding en geen crash', async () => {
  const app = await laadApp();
  app.upload('prijzen.csv', 'datum,prijs\n2026-01-01T00:00:00+01:00,0.2\n');
  ok(app.el('status').classList.contains('err'), 'geen foutstatus');
  ok(/meter-CSV/.test(app.el('status').textContent), app.el('status').textContent);
});
test('meterdata zonder overlap met prijzen → nette melding', async () => {
  const app = await laadApp();
  app.upload('oud.csv', maakMeterCSV(Date.UTC(2019, 0, 1), Date.UTC(2019, 0, 3))); app.kies('Zonneplan');
  ok(!app.heeftResultaten()); ok(/Geen overlappende/.test(app.el('status').textContent), app.el('status').textContent);
});
test('prijzen onbereikbaar → nette melding, geen crash', async () => {
  const app = await laadApp({ fetchFn: async () => ({ ok: false, status: 404, text: async () => '' }) });
  for (let i = 0; i < 60 && !app.el('status').classList.contains('err'); i++) await new Promise(r => setTimeout(r, 100)); // app probeert het eerst opnieuw
  ok(app.el('status').classList.contains('err'), 'geen foutmelding: ' + app.el('status').textContent); ok(/Prijzen konden niet geladen worden/.test(app.el('status').textContent));
});
test('batterij kiezen vult schuifjes en prijs in en herberekent', async () => {
  const app = await laadApp();
  eq(app.el('batterijSelect').options.length, new Set(BAT.map(b => b.merk)).size, 'één groep per merk');
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const voor = app.el('heroSavings').textContent;
  app.kiesBatterij('tesla-powerwall-3');
  eq(app.el('cap').value, '13.5'); eq(app.el('capVal').textContent, '13.5 kWh');
  eq(app.el('chargeVal').textContent, '5.0 kW'); eq(app.el('dischargeVal').textContent, '5.0 kW'); eq(app.el('rteVal').textContent, '89%');
  ok(/Geschat/.test(app.el('batterijInfo').textContent), 'geschatte velden niet vermeld');
  ok(app.el('heroSavings').textContent !== voor, 'resultaat niet herberekend');
  eq(app.el('prijs').value, '', 'Tesla heeft geen bekende prijs');
  eq(app.el('heroPayback').textContent, '—');
  app.kiesBatterij('zonneplan-nexus-10-1f');
  eq(app.el('prijs').value, '4690'); ok(/Indicatie/.test(app.el('prijsInfo').textContent));
  eq(app.opslag.get('hb.batterij'), 'zonneplan-nexus-10-1f');
});
test('terugverdientijd = prijs ÷ besparing per jaar, met kleur en uitleg', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan'); app.kiesBatterij('zonneplan-nexus-10-1f');
  const besparing = euro(app.el('heroSavings').textContent);
  const verwacht = 4690 / besparing;
  near(parseFloat(app.el('heroPayback').textContent.replace(',', '.')), verwacht, 0.051, 'jaren');
  ok(/÷/.test(app.el('paybackNote').textContent), 'berekening niet uitgelegd');
  // eigen prijs invullen
  app.el('prijs').value = '1000'; app.el('prijs').vuur('input');
  near(parseFloat(app.el('heroPayback').textContent.replace(',', '.')), 1000 / besparing, 0.051);
  ok(app.el('heroPayback').classList.contains('goed'), 'korte terugverdientijd moet groen zijn');
  app.el('prijs').value = '50000'; app.el('prijs').vuur('input');
  ok(app.el('heroPayback').classList.contains('slecht') && /levensduur/.test(app.el('paybackNote').textContent), 'lange terugverdientijd moet gewaarschuwd worden');
  eq(app.el('batterijSelect').value, 'zonneplan-nexus-10-1f', 'prijs aanpassen mag de gekozen batterij niet wissen');
  app.el('prijs').value = ''; app.el('prijs').vuur('input');
  eq(app.el('heroPayback').textContent, '—');
});
test('elke batterij uit de lijst geeft een geldig resultaat', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  for (const b of BAT) {
    app.kiesBatterij(b.id);
    near(parseFloat(app.el('cap').value), b.capaciteit, 1e-9, b.id + ' capaciteit');
    const besparing = euro(app.el('heroSavings').textContent);
    ok(besparing > 0 && besparing < 2000, `${b.id}: besparing €${besparing}`);
    if (b.prijs) ok(/jaar$/.test(app.el('heroPayback').textContent), `${b.id}: terugverdientijd "${app.el('heroPayback').textContent}"`);
  }
});
test('zelf een schuifje verschuiven → "Eigen instellingen" (prijs blijft staan)', async () => {
  const app = await laadApp();
  app.kiesBatterij('huawei-luna2000-10');
  app.el('prijs').value = '6000';
  app.schuif('rte', 80);
  eq(app.el('batterijSelect').value, '', 'keuze niet gewist');
  ok(/Eigen/.test(app.el('batterijInfo').textContent));
  eq(app.opslag.get('hb.batterij'), '');
  eq(app.el('prijs').value, '6000', 'prijs mag blijven staan');
  app.kiesBatterij('zonneplan-nexus-20'); app.schuif('reserve', 20);
  eq(app.el('batterijSelect').value, 'zonneplan-nexus-20', 'strategie-schuifjes hebben geen invloed op de batterijkeuze');
});
test('advies: alle batterijen doorgerekend, beste = kortste terugverdientijd', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const advies = app.T.berekenAdvies();
  eq(advies.length, BAT.length, 'aantal doorgerekende batterijen');
  const metPrijs = advies.filter(r => r.jaren !== null);
  ok(metPrijs.length >= 8, 'te weinig batterijen met terugverdientijd');
  const beste = metPrijs.reduce((a, b) => (b.jaren < a.jaren ? b : a));
  const top = app.el('adviesTop').innerHTML;
  ok(top.includes('Beste keuze voor jou') && top.includes(beste.b.model), 'aanbeveling noemt niet de beste: ' + top.slice(0, 150));
  const volgorde = app.T.sorteerAdvies(advies);
  ok(volgorde.slice(0, metPrijs.length).every(r => r.jaren !== null), 'batterijen met prijs moeten bovenaan');
  for (let i = 1; i < metPrijs.length; i++) ok(volgorde[i].jaren >= volgorde[i - 1].jaren, 'niet gesorteerd op terugverdientijd');
  eq((app.el('adviesTabel').innerHTML.match(/data-kies=/g) || []).length, 8, 'eerst 8 batterijen tonen');
  ok(/Toon alle/.test(app.el('adviesTabel').innerHTML), 'knop "toon alle" ontbreekt');
});
test('advies klopt exact met het hoofdresultaat voor de gekozen batterij', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  for (const id of ['zonneplan-nexus-10-1f', 'homewizard-plugin', 'quatt-homebattery-37-2-3f']) {
    app.kiesBatterij(id);
    for (const slim of ['gridChargeUit', 'gridChargeAan']) {
      app.klik(slim);
      const r = app.T.berekenAdvies().find(x => x.b.id === id);
      near(r.besparing, euro(app.el('heroSavings').textContent), 0.006, `${id} (${slim})`);
    }
    app.klik('gridChargeUit');
  }
});
test('advies: filter stekker/vast, "Kies" en "toon alle" werken', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan'); app.T.berekenAdvies();
  app.klik('adviesStekker');
  const ids = [...app.el('adviesTabel').innerHTML.matchAll(/data-kies="([^"]+)"/g)].map(m => m[1]);
  ok(ids.length > 0 && ids.every(id => BAT.find(b => b.id === id).type === 'stekker'), 'filter laat andere types zien');
  ok(app.el('adviesStekker').classList.contains('active') && !app.el('adviesAlles').classList.contains('active'));
  app.klik('adviesAlles');
  const klik = attrs => app.el('adviesTabel').vuur('click', { target: { getAttribute: k => attrs[k] ?? null } });
  klik({ 'data-meer': '1' });
  eq((app.el('adviesTabel').innerHTML.match(/data-kies=/g) || []).length, BAT.length, 'toon alle');
  klik({ 'data-kies': 'anker-solarbank-max-ac' });
  eq(app.el('batterijSelect').value, 'anker-solarbank-max-ac'); eq(app.el('capVal').textContent, '7.0 kWh');
});
test('leveranciersadvies: alle leveranciers, goedkoopste bovenaan', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Tibber'); app.kiesBatterij('zonneplan-nexus-10-1f');
  const lijst = app.T.berekenLeverancierAdvies();
  eq(lijst.length, Object.keys(CFG.leveranciers).length, 'aantal leveranciers');
  for (let i = 1; i < lijst.length; i++) ok(lijst[i].met >= lijst[i - 1].met, 'niet gesorteerd op kosten met batterij');
  ok(lijst.every(r => r.met < r.zonder), 'met batterij moet bij elke leverancier goedkoper zijn');
  const top = app.el('levAdviesTop').innerHTML;
  ok(top.includes('Goedkoopst voor jou') && top.includes(lijst[0].naam), top.slice(0, 120));
  ok(top.includes('goedkoper dan Tibber') || lijst[0].naam === 'Tibber', 'vergelijking met huidige leverancier ontbreekt');
  ok(/inclusief vaste leveringskosten/.test(app.el('levAdviesNote').textContent), 'vermelding vaste kosten ontbreekt');
  ok(/per maand vast/.test(app.el('levAdviesTabel').innerHTML), 'vaste kosten niet per leverancier getoond');
});
test('vaste leveringskosten: tellen mee in de totalen, niet in de besparing', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const z = { voor: euro(app.el('heroBefore').textContent), na: euro(app.el('heroAfter').textContent), b: euro(app.el('heroSavings').textContent) };
  ok(/6,25 vaste|€75,00 vaste/.test(app.el('periodNote').innerHTML), 'periode-uitleg noemt de vaste kosten niet: ' + app.el('periodNote').innerHTML.slice(-220));
  ok(/per maand vast/.test(app.el('levInfo').textContent), 'vaste kosten niet bij de leverancier getoond');
  // "eigen opslag" met dezelfde opslag maar andere vaste kosten: totalen verschuiven precies 12 × verschil
  app.kies('__eigen__');
  app.el('eigenVast').value = '6.25'; app.el('eigenVast').vuur('input');
  const a = euro(app.el('heroBefore').textContent), bA = euro(app.el('heroSavings').textContent);
  app.el('eigenVast').value = '10.25'; app.el('eigenVast').vuur('input');
  near(euro(app.el('heroBefore').textContent) - a, 48, 0.011, 'zonder batterij: 12 × €4 erbij');
  near(euro(app.el('heroSavings').textContent), bA, 0.011, 'vaste kosten veranderen de besparing niet');
  ok(z.b > 0);
  const b1 = euro(app.el('heroSavings').textContent);
  app.el('eigenVast').value = '0'; app.el('eigenVast').vuur('input');
  near(euro(app.el('heroSavings').textContent), b1, 0.001, 'vaste kosten mogen de besparing niet veranderen');
});
test('vaste leveringskosten: onbekend → mediaan, gemarkeerd als geschat', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Mijndomein Energie');
  ok(/\(geschat\)/.test(app.el('levInfo').textContent), 'niet als geschat gemarkeerd');
  const bekend = Object.values(CFG.vasteKosten).map(v => v.perMaand).filter(v => v !== null).sort((x, y) => x - y);
  const m = bekend.length >> 1, mediaan = bekend.length % 2 ? bekend[m] : (bekend[m - 1] + bekend[m]) / 2;
  near(app.T.vasteKostenMaand('Mijndomein Energie'), mediaan, 1e-9);
});
test('regressie: advies-bedragen = bedragen bovenaan na "Kies" (ZonderGas, beide tariefmodi)', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  for (const modus of ['tariefHuidig', 'tariefHistorisch']) {
    app.klik(modus);
    const rij = app.T.berekenLeverancierAdvies().find(r => r.naam === 'ZonderGas');
    app.el('levAdviesTabel').vuur('click', { target: { getAttribute: k => (k === 'data-lev' ? 'ZonderGas' : null) } });
    near(euro(app.el('heroBefore').textContent), rij.zonder, 0.006, `${modus}: zonder batterij`);
    near(euro(app.el('heroAfter').textContent), rij.met, 0.006, `${modus}: met batterij`);
    app.kies('Zonneplan');
  }
});
test('huidige vs. historische tarieven: wisselen werkt en wordt onthouden', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('ZonderGas');
  ok(app.el('tariefHuidig').classList.contains('active'), 'standaard: huidige tarieven');
  ok(/huidige opslag/.test(app.el('levInfo').textContent), 'huidige opslag niet getoond');
  const huidig = euro(app.el('heroBefore').textContent);
  app.klik('tariefHistorisch');
  ok(app.el('tariefHistorisch').classList.contains('active') && !app.el('tariefHuidig').classList.contains('active'));
  ok(euro(app.el('heroBefore').textContent) > huidig + 50, 'ZonderGas was historisch duurder (opslag €0,048 tot mei 2026)');
  eq(app.opslag.get('hb.tarief'), 'historisch');
  const app2 = await laadApp({ opgeslagen: { 'hb.tarief': 'historisch' } });
  ok(app2.el('tariefHistorisch').classList.contains('active'), 'keuze niet hersteld');
});
test('tariefhint zegt of huidig/historisch verschil maakt', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('ZonderGas');
  const hint = app.el('tariefHint').textContent;
  ok(/ZonderGas was het in je meterperiode €\s?[\d.,]+ duurder dan nu/.test(hint), 'ZonderGas-verschil niet genoemd: ' + hint);
  const huidig = euro(app.el('heroBefore').textContent);
  app.klik('tariefHistorisch');
  const v = euro(app.el('heroBefore').textContent) - huidig;
  const genoemd = euro(app.el('tariefHint').textContent.match(/€\s?[\d.,]+/)[0]);
  near(genoemd, v, 0.02 * v + 1, 'genoemd verschil ≠ verschil in kosten zonder batterij');
  app.klik('tariefHuidig');
  // Zonneplan: opslag gelijk gebleven, alleen de energiebelasting veranderde per 2026
  app.kies('Zonneplan');
  const a = euro(app.el('heroBefore').textContent);
  app.klik('tariefHistorisch');
  ok(/niet veranderd/.test(app.el('tariefHint').textContent), 'Zonneplan: geen "niet veranderd"-hint');
  near(euro(app.el('heroBefore').textContent), a, 0.01, 'Zonneplan huidig en historisch moeten gelijk zijn');
});
test('leveranciersadvies klopt exact met het hoofdresultaat', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER);
  for (const naam of ['Zonneplan', 'ZonderGas', 'Tibber']) {
    app.kies(naam);
    for (const instelling of [[], ['saldAan'], ['gridChargeAan', 'resKwartier']]) {
      instelling.forEach(k => app.klik(k));
      const r = app.T.berekenLeverancierAdvies().find(x => x.naam === naam);
      near(r.zonder, euro(app.el('heroBefore').textContent), 0.006, `${naam} zonder batterij ${instelling}`);
      near(r.met, euro(app.el('heroAfter').textContent), 0.006, `${naam} met batterij ${instelling}`);
      ['saldUit', 'gridChargeUit', 'resUur'].forEach(k => app.klik(k));
    }
  }
});
test('leveranciersadvies: "Kies" wisselt van leverancier', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Essent');
  const goedkoopst = app.T.berekenLeverancierAdvies()[0].naam;
  app.el('levAdviesTabel').vuur('click', { target: { getAttribute: k => (k === 'data-lev' ? goedkoopst : null) } });
  eq(app.el('leverancierSelect').value, goedkoopst); eq(app.el('levVal').textContent, goedkoopst);
  app.T.berekenLeverancierAdvies(); // in de browser gebeurt dit automatisch na 0,3 s
  ok(app.el('levAdviesTop').innerHTML.includes('die je nu gekozen hebt'), 'na kiezen moet het advies dat bevestigen');
});
test('netafname: batterij verlaagt de afname en geeft meer dagen zonder netstroom', async () => {
  const app = await laadApp();
  app.upload('verbruik.csv', METER); app.kies('Zonneplan');
  const lees = () => { const t = app.el('netNote').innerHTML.replace(/<[^>]+>/g, '');
    const m = t.match(/Van het net: ([\d.]+) kWh → ([\d.]+) kWh.*?: (\d+) → (\d+)/); ok(m, 'netafname niet getoond: ' + t);
    return m.slice(1).map(x => +x.replace(/\./g, '')); };
  const [voor, na, dVoor, dNa] = lees();
  ok(na < voor, `afname moet dalen (${voor} → ${na})`); ok(dNa >= dVoor, 'dagen zonder netafname mogen niet dalen');
  app.schuif('cap', 20); app.schuif('discharge', 5);
  const [, naGroot, , dGroot] = lees();
  ok(naGroot <= na && dGroot >= dNa, 'grotere batterij → minder afname, meer dagen zonder netstroom');
});
test('gekozen batterij wordt hersteld bij een volgend bezoek', async () => {
  const app = await laadApp({ opgeslagen: { 'hb.batterij': 'quatt-homebattery-27-9-3f' } });
  eq(app.el('batterijSelect').value, 'quatt-homebattery-27-9-3f');
  eq(app.el('capVal').textContent, '27.9 kWh'); eq(app.el('chargeVal').textContent, '10.0 kW');
});
test('thema-knop wisselt licht/donker en onthoudt de keuze', async () => {
  const app = await laadApp();
  app.klik('themeToggle'); eq(app.thema(), 'dark'); eq(app.opslag.get('hb.theme'), 'dark');
  app.klik('themeToggle'); eq(app.thema(), 'light'); eq(app.opslag.get('hb.theme'), 'light');
});
test('gekozen leverancier wordt onthouden bij een volgend bezoek', async () => {
  const app = await laadApp();
  app.kies('Tibber'); eq(app.opslag.get('hb.leverancier'), 'Tibber');
});

// ==================================================================================
groep('7. Scripts en automatisering');
// ==================================================================================
test('update-script: omrekening naar Nederlandse tijd, ook rond zomer-/wintertijd', async () => {
  const mtimeVoor = fs.statSync(path.join(ROOT, 'data/epex.csv')).mtimeMs;
  const { naarLokaal } = await import(pathToFileURL(path.join(ROOT, 'scripts/update-prijzen.mjs')).href);
  eq(naarLokaal(Date.UTC(2026, 6, 1, 10)), '2026-07-01T12:00:00+02:00', 'zomer');
  eq(naarLokaal(Date.UTC(2026, 0, 15, 23)), '2026-01-16T00:00:00+01:00', 'winter, over middernacht');
  eq(naarLokaal(Date.UTC(2026, 2, 29, 0)), '2026-03-29T01:00:00+01:00', 'vlak voor zomertijd');
  eq(naarLokaal(Date.UTC(2026, 2, 29, 1)), '2026-03-29T03:00:00+02:00', 'zomertijd: 02:00 bestaat niet');
  eq(naarLokaal(Date.UTC(2026, 9, 25, 0)), '2026-10-25T02:00:00+02:00', 'wintertijd: eerste 02:00');
  eq(naarLokaal(Date.UTC(2026, 9, 25, 1)), '2026-10-25T02:00:00+01:00', 'wintertijd: tweede 02:00');
  eq(fs.statSync(path.join(ROOT, 'data/epex.csv')).mtimeMs, mtimeVoor, 'importeren mag het script niet laten draaien');
});
test('opslagen.mjs rekent inkoopvergoeding om naar "vast"', () => {
  const r = spawnSync(process.execPath, ['scripts/opslagen.mjs', 'vast', '0.0180', '2026'], { cwd: ROOT, encoding: 'utf8' });
  eq(r.status, 0, r.stderr); eq(r.stdout.trim(), '0.10649');
  const t = spawnSync(process.execPath, ['scripts/opslagen.mjs'], { cwd: ROOT, encoding: 'utf8' });
  eq(t.status, 0, t.stderr); ok(/Zonneplan/.test(t.stdout), 'tabel bevat geen leveranciers');
});
test('GitHub Action: draait dagelijks, test vóór het committen', () => {
  const wf = lees('.github/workflows/update-prijzen.yml');
  ok(/cron:/.test(wf), 'geen schema'); ok(/workflow_dispatch/.test(wf), 'niet handmatig te starten');
  ok(/contents: write/.test(wf), 'geen schrijfrechten');
  const iTest = wf.indexOf('run-tests.mjs'), iCommit = wf.indexOf('git commit');
  ok(iTest > 0 && iTest < iCommit, 'tests draaien niet vóór de commit');
});
test('GitHub Action: tests bij elke push en pull request', () => {
  const wf = lees('.github/workflows/tests.yml');
  ok(/push:/.test(wf) && /pull_request:/.test(wf)); ok(/run-tests\.mjs/.test(wf));
});

// ==================================================================================
// Echte meterdata: alleen lokaal. Zet een HomeWizard-export (P1e-*.csv) in de projectmap; die staat
// in .gitignore en komt dus nooit online. Op GitHub wordt deze groep overgeslagen.
const ECHT = fs.readdirSync(ROOT).filter(f => /^P1e?-.*\.csv$/i.test(f)).sort().pop();
if (ECHT) {
  groep(`8. Echte meterdata (${ECHT}, alleen lokaal)`);
  const tekst = lees(ECHT);
  const regels = csvRegels(tekst);
  const kop = tekst.split(/\r?\n/)[0].split(',');
  const totaal = (i0, i1) => (+regels.at(-1)[i0] + +regels.at(-1)[i1]) - (+regels[0][i0] + +regels[0][i1]);
  const echteAfname = totaal(kop.indexOf('Import T1 kWh'), kop.indexOf('Import T2 kWh'));
  const echteTerug = totaal(kop.indexOf('Export T1 kWh'), kop.indexOf('Export T2 kWh'));

  test('bestand wordt ingelezen en verbruik klopt met de meterstanden', async () => {
    const app = await laadApp();
    for (const res of ['uur', 'kwartier']) {
      const r = app.T.loadMeterCSV(tekst, res);
      const afname = r.reduce((s, x) => s + x.importKwh, 0), terug = r.reduce((s, x) => s + x.exportKwh, 0);
      near(afname, echteAfname, 0.01, `${res}: totale afname (kWh)`);
      near(terug, echteTerug, 0.01, `${res}: totale teruglevering (kWh)`);
    }
  });
  test('staat niet in git en wordt genegeerd', () => {
    const r = spawnSync('git', ['check-ignore', '-q', ECHT], { cwd: ROOT });
    eq(r.status, 0, `${ECHT} wordt NIET genegeerd door .gitignore`);
    const l = spawnSync('git', ['ls-files', '--error-unmatch', ECHT], { cwd: ROOT });
    ok(l.status !== 0, `${ECHT} staat in git! Verwijder met: git rm --cached "${ECHT}"`);
  });
  test('volledige flow met elke leverancier, per uur en per kwartier', async () => {
    const app = await laadApp();
    app.upload(ECHT, tekst);
    const uitkomsten = [];
    for (const naam of Object.keys(CFG.leveranciers)) {
      app.kies(naam);
      ok(app.heeftResultaten(), naam + ': geen resultaat');
      ok(!app.el('status').classList.contains('err'), naam + ': ' + app.el('status').textContent);
      const voor = euro(app.el('heroBefore').textContent), na = euro(app.el('heroAfter').textContent);
      ok(na < voor, `${naam}: met batterij (€${na}) niet goedkoper dan zonder (€${voor})`);
      uitkomsten.push(euro(app.el('heroSavings').textContent));
    }
    const min = Math.min(...uitkomsten), max = Math.max(...uitkomsten);
    // de terugleveringsvoorwaarden verschillen (Zonneplan +2 ct + 10%, Tibber −2,48 ct): een batterij is
    // meer waard waar teruglevering weinig oplevert. Een spreiding tot ±40% is dus normaal.
    ok(max - min < 0.4 * max, `besparing verschilt te veel tussen leveranciers (€${min}–€${max})`);
    app.kies('Zonneplan');
    const uur = euro(app.el('heroSavings').textContent);
    app.klik('resKwartier');
    const kw = euro(app.el('heroSavings').textContent);
    ok(kw >= uur * 0.95, `kwartier (€${kw}) mag niet veel lager zijn dan uur (€${uur})`);
    eq(app.fouten.length, 0, app.fouten.join(' | '));
  });
  test('vrijwel elk kwartier krijgt een prijs (geen gaten in de koppeling)', async () => {
    const app = await laadApp();
    app.upload(ECHT, tekst); app.kies('Zonneplan'); app.klik('resKwartier');
    const m = app.el('status').textContent.match(/^(\d+) kwartieren gekoppeld(?: \((\d+) zonder)?/);
    ok(m, 'status: ' + app.el('status').textContent);
    const gekoppeld = +m[1], mist = +(m[2] || 0);
    ok(mist / (gekoppeld + mist) < 0.001, `${mist} kwartieren zonder prijs`);
  });
} else {
  groep('8. Echte meterdata');
  test('overgeslagen: geen P1e-*.csv in de projectmap', () => {});
}

// ==================================================================================
if (ONLINE) {
  groep("9. Online (live EnergyZero API)");
  test('API bereikbaar en gisteren komt overeen met epex.csv', async () => {
    const { haalKalePrijzen, naarLokaal } = await import(pathToFileURL(path.join(ROOT, 'scripts/update-prijzen.mjs')).href);
    const nu = new Date(), gisteren = Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth(), nu.getUTCDate() - 1);
    const live = await haalKalePrijzen(gisteren - 2 * HOUR, gisteren + 22 * HOUR);
    ok(live.size >= 23, `slechts ${live.size} uurprijzen ontvangen`);
    const lokaal = new Map(EPEX.map(r => [r.d, r.p]));
    let verschil = 0;
    for (const [ms, p] of live) { const l = lokaal.get(naarLokaal(ms)); if (l === undefined || Math.abs(l - p) > 1e-6) verschil++; }
    eq(verschil, 0, `${verschil} uur wijkt af van de API`);
  });
}

// ------------------------------------------------------------------ hulpmodus: batterijadvies voor een meterbestand
//   node tests/run-tests.mjs --advies=P1e-....csv [--leverancier=Zonneplan] [--salderen]
const ADVIES = (process.argv.find(a => a.startsWith('--advies=')) || '').slice(9);
if (ADVIES) {
  const lev = (process.argv.find(a => a.startsWith('--leverancier=')) || '--leverancier=Zonneplan').slice(14);
  const app = await laadApp();
  app.upload(ADVIES, fs.readFileSync(path.resolve(ADVIES), 'utf8'));
  app.kies(lev);
  if (process.argv.includes('--salderen')) app.klik('saldAan');
  if (process.argv.includes('--slimladen')) app.klik('gridChargeAan');
  if (process.argv.includes('--altijd')) app.klik('stratNaive');
  if (!app.heeftResultaten()) { console.log('Geen resultaat: ' + app.el('status').textContent); process.exit(1); }
  const advies = app.T.sorteerAdvies(app.T.berekenAdvies());
  console.log(`\nBatterijadvies voor ${ADVIES} · ${lev} · ${process.argv.includes('--salderen') ? 'met' : 'zonder'} salderen`);
  console.log(app.el('status').textContent + '\n');
  console.log('Batterij'.padEnd(52) + 'bespaart/jr'.padStart(12) + 'prijs'.padStart(9) + 'terug in'.padStart(11));
  for (const r of advies) console.log((r.b.merk + ' ' + r.b.model).padEnd(52) + ('€' + r.besparing.toFixed(0)).padStart(12) +
    (r.b.prijs ? '€' + r.b.prijs : '—').padStart(9) + (r.jaren ? r.jaren.toFixed(1) + ' jr' : '—').padStart(11));
  console.log('\n' + app.el('adviesTop').innerHTML.replace(/<[^>]+>/g, ''));
  const batId = (process.argv.find(a => a.startsWith('--batterij=')) || '').slice(11) || advies[0].b.id;
  app.kiesBatterij(batId);
  // netafname per maand met de gekozen batterij
  const L = app.T.staat.berekening;
  const maanden = new Map();
  L.data.forEach((r, i) => { const m = r.hourKey.slice(0, 7); const x = maanden.get(m) || { voor: 0, na: 0, dagen: new Map() };
    x.voor += r.importKwh; x.na += L.sim[i].importKwh; const d = r.hourKey.slice(0, 10); x.dagen.set(d, (x.dagen.get(d) || 0) + L.sim[i].importKwh); maanden.set(m, x); });
  console.log(`\nNetafname per maand met ${advies.find(r => r.b.id === batId).b.merk} ${advies.find(r => r.b.id === batId).b.model}:\n`);
  console.log('Maand'.padEnd(9) + 'zonder'.padStart(9) + 'met'.padStart(9) + 'dagen ~0'.padStart(10));
  for (const [m, x] of maanden) console.log(m.padEnd(9) + (x.voor.toFixed(0) + ' kWh').padStart(9) + (x.na.toFixed(0) + ' kWh').padStart(9) +
    (String([...x.dagen.values()].filter(v => v < 0.1).length) + '/' + x.dagen.size).padStart(10));
  console.log('\n' + app.el('netNote').innerHTML.replace(/<[^>]+>/g, ''));
  const levLijst = app.T.berekenLeverancierAdvies();
  console.log(`\nLeveranciers (huidige tarieven, met ${advies.find(r => r.b.id === batId).b.merk} ${advies.find(r => r.b.id === batId).b.model}):\n`);
  console.log('Leverancier'.padEnd(24) + 'zonder batt.'.padStart(14) + 'met batt.'.padStart(12) + 'verschil'.padStart(11));
  for (const r of levLijst) console.log(r.naam.padEnd(24) + ('€' + r.zonder.toFixed(0)).padStart(14) + ('€' + r.met.toFixed(0)).padStart(12) +
    (r === levLijst[0] ? "goedkoopst" : "+€" + (r.met - levLijst[0].met).toFixed(0)).padStart(11));
  console.log('\n' + app.el('levAdviesTop').innerHTML.replace(/<[^>]+>/g, ''));
  process.exit(0);
}

// ------------------------------------------------------------------ uitvoeren en rapporteren
const kleur = (c, s) => process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s;
let vorigeGroep = '', geslaagd = 0, mislukt = 0;
const start = Date.now();
for (const t of tests) {
  if (FILTER && !(t.groep + ' ' + t.naam).toLowerCase().includes(FILTER)) continue;
  if (t.groep !== vorigeGroep) { console.log('\n' + kleur('1', t.groep)); vorigeGroep = t.groep; }
  const t0 = Date.now();
  try {
    await t.fn();
    geslaagd++;
    console.log(`  ${kleur('32', '✓')} ${t.naam} ${kleur('90', `(${Date.now() - t0} ms)`)}`);
  } catch (e) {
    mislukt++;
    console.log(`  ${kleur('31', '✗')} ${t.naam}\n      ${kleur('31', e instanceof Fout ? e.message : (e.stack || e.message))}`);
  }
}
console.log(`\n${mislukt ? kleur('31', `${mislukt} mislukt`) : kleur('32', 'Alles geslaagd')} · ${geslaagd} geslaagd · ${((Date.now() - start) / 1000).toFixed(1)} s` +
  (ONLINE ? '' : kleur('90', '   (tip: --online test ook tegen de live API)')));
process.exitCode = mislukt ? 1 : 0;
