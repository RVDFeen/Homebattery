// Houdt data/epex.csv bij: de kale day-ahead stroomprijs per uur (euro/kWh, excl. btw).
//
// De app rekent daaruit zelf de prijs per leverancier uit:
//   prijs = (kale prijs + vaste opslag leverancier incl. energiebelasting) × (1 + btw)
// De opslagen staan in data/leveranciers.json.
//
// Bron: EnergyZero API (gratis, geen sleutel nodig).
// Gebruik:  node scripts/update-prijzen.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPEX = path.join(ROOT, 'data', 'epex.csv');
const CONFIG = path.join(ROOT, 'data', 'leveranciers.json');
const DRY = process.argv.includes('--dry-run');

const START = Date.parse('2022-10-23T00:00:00+02:00'); // begin als epex.csv nog niet bestaat
const HOUR = 3600e3, DAY = 24 * HOUR;
const MAX_DAGEN_PER_CALL = 30;

// UTC-ms -> "2026-07-01T00:00:00+02:00"
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
export function naarLokaal(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000);
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0'), mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off >= 0 ? '+' : '-'}${hh}:${mm}`;
}

export async function haalKalePrijzen(vanMs, totMs) {
  const kaart = new Map();
  for (let start = vanMs; start < totMs; start += MAX_DAGEN_PER_CALL * DAY) {
    const eind = Math.min(totMs, start + MAX_DAGEN_PER_CALL * DAY);
    const url = 'https://api.energyzero.nl/v1/energyprices'
      + `?fromDate=${new Date(start).toISOString()}&tillDate=${new Date(eind - 1).toISOString()}`
      + '&interval=4&usageType=1&inclBtw=false';
    let json;
    for (let poging = 1; ; poging++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Homebattery-prijs-updater' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        json = await r.json();
        break;
      } catch (e) {
        if (poging >= 4) throw new Error(`EnergyZero API faalt (${url}): ${e.message}`);
        await new Promise(res => setTimeout(res, 2000 * poging));
      }
    }
    for (const p of json.Prices || []) {
      const ms = Date.parse(p.readingDate);
      if (Number.isFinite(ms) && typeof p.price === 'number') kaart.set(ms, p.price);
    }
  }
  return kaart;
}

// Alleen uitvoeren bij direct starten (niet bij importeren door de tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let regels = [];
  let laatste = START - HOUR;
  if (fs.existsSync(EPEX)) {
    regels = fs.readFileSync(EPEX, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
    if (regels.length) laatste = Date.parse(regels[regels.length - 1].split(',')[0]);
  }
  const tot = Math.floor(Date.now() / DAY) * DAY + 3 * DAY; // t/m overmorgen (day-ahead)
  console.log(`Ophalen vanaf ${naarLokaal(laatste + HOUR)}`);
  const kaal = await haalKalePrijzen(laatste + HOUR, tot);
  const nieuw = [...kaal.keys()].filter(ms => ms > laatste).sort((a, b) => a - b);
  for (const ms of nieuw) regels.push(`${naarLokaal(ms)},${kaal.get(ms).toFixed(6)}`);
  console.log(nieuw.length ? `+${nieuw.length} uur, t/m ${naarLokaal(nieuw[nieuw.length - 1])}` : 'Al actueel.');
  if (nieuw.length && !DRY) fs.writeFileSync(EPEX, ['datum,prijs', ...regels].join('\n') + '\n');

  // Waarschuw (en faal, zodat GitHub mailt) als de energiebelasting van het nieuwste jaar ontbreekt.
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const laatsteJaar = (nieuw.length ? naarLokaal(nieuw[nieuw.length - 1]) : regels.at(-1) || '').slice(0, 4);
  if (laatsteJaar && cfg.energiebelasting[laatsteJaar] === undefined) {
    console.log(`::error::Energiebelasting voor ${laatsteJaar} ontbreekt in data/leveranciers.json. ` +
      'Tot je die toevoegt rekent de app met het tarief van het vorige jaar.');
    process.exitCode = 1;
  }
}
