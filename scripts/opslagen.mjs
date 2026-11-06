// Toont per leverancier de opslag die de app NU gebruikt, in dezelfde eenheid als
// leveranciers zelf communiceren (inkoopvergoeding per kWh, incl. btw).
//
//   node scripts/opslagen.mjs                → tabel
//   node scripts/opslagen.mjs vast 0.0180    → reken een inkoopvergoeding incl. btw om naar "vast" voor leveranciers.json
//   node scripts/opslagen.mjs vast 0.0180 2027  (idem, voor een ander jaar)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'leveranciers.json'), 'utf8'));
const btwF = 1 + cfg.btw;
const ebVan = jaar => cfg.energiebelasting[jaar];

if (process.argv[2] === 'vast') {
  const incl = parseFloat(process.argv[3]);
  const jaar = process.argv[4] || new Date().getFullYear().toString();
  if (Number.isNaN(incl) || ebVan(jaar) === undefined) {
    console.error('Gebruik: node scripts/opslagen.mjs vast <inkoopvergoeding incl. btw> [jaar]  (jaar moet in energiebelasting staan)');
    process.exit(1);
  }
  console.log((incl / btwF + ebVan(jaar)).toFixed(5));
  process.exit(0);
}

console.log(`Laatst gecontroleerd: ${cfg.laatstGecontroleerd ?? 'onbekend'}`);
console.log(`Energiebelasting (excl. btw): ${Object.entries(cfg.energiebelasting).map(([j, v]) => `${j}=${v}`).join('  ')}\n`);
console.log('Leverancier'.padEnd(22) + 'geldig vanaf'.padEnd(14) + 'opslag incl. btw   bron');
for (const [naam, perioden] of Object.entries(cfg.leveranciers)) {
  const p = perioden[perioden.length - 1];
  const eb = ebVan(p.vanaf.slice(0, 4));
  const opslag = eb === undefined ? '?' : '€ ' + ((p.vast - eb) * btwF).toFixed(4);
  console.log(naam.padEnd(22) + p.vanaf.padEnd(14) + opslag.padEnd(19) + (p.bron ?? 'afgeleid uit historische data'));
}
