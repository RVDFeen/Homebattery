# 🔋 Homebattery — Thuisbatterij Simulator

Simuleer de besparing van een thuisbatterij met je eigen energieverbruik en dynamische stroomprijzen.

🌐 **Live demo:**
https://rvdfeen.github.io/Homebattery

## Functies

* 🔋 Thuisbatterij simulatie
* ⚡ Dynamische energieprijzen
* ☀️ Slim laden op basis van prijs en zonneverwachting
* 💶 Vergelijking met/zonder batterij en met/zonder salderen

## CSV ondersteuning

Getest met CSV-exportbestanden van **HomeWizard**.

Ondersteunt:

* Import/export energie
* Uur- en kwartierwaarden

## Energieprijzen

De app gebruikt één bestand met de **kale day-ahead beursprijs** per uur ([`data/epex.csv`](data/epex.csv), vanaf oktober 2022).
Dat wordt **elke dag automatisch bijgewerkt** door een GitHub Action
([`.github/workflows/update-prijzen.yml`](.github/workflows/update-prijzen.yml)) via de gratis EnergyZero API,
inclusief de prijzen van morgen.

De prijs per leverancier rekent de app zelf uit:

```
prijs = (kale beursprijs + vast) × 1,21
vast  = opslag leverancier + energiebelasting   (excl. btw)
```

De `vast`-bedragen per leverancier staan in [`data/leveranciers.json`](data/leveranciers.json), als periodes
(een leverancier verandert soms zijn tarief). Staat jouw leverancier er niet tussen? Kies in de app
**"Andere leverancier (eigen opslag)"**.

Voor teruggeleverde stroom gebruikt de app per leverancier de voorwaarden onder `teruglevering`
(per kWh excl. btw bovenop de kale beursprijs):

```
binnen de saldering:  (kale beursprijs + binnen + energiebelasting) × 1,21 + bonus
buiten de saldering:   kale beursprijs + buiten + bonus          (overschot, en iedereen vanaf 2027)
bonus = bonusPct × kale beursprijs, alleen bij een positieve prijs (en binnen bonusUren als die er zijn)
```

Staat een leverancier niet onder `teruglevering`, dan rekent de app met alleen de beursprijs en zet een * bij de naam.

Onderhoud (ongeveer 1× per jaar):

* **Nieuwe energiebelasting** (per 1 januari): voeg het nieuwe jaar toe onder `energiebelasting` in `leveranciers.json`.
  Ontbreekt hij, dan faalt de Action met een melding (GitHub stuurt je een mail) en rekent de app met het tarief van het vorige jaar.
* **Leverancier wijzigt zijn opslag**: voeg een periode toe, bijv. `{ "vanaf": "2027-03-01", "vast": 0.1132 }`.
* **Nieuwe leverancier**: voeg een regel toe met één periode.

Huidige opslagen bekijken: `node scripts/opslagen.mjs`. Met Claude Code kun je alles laten nakijken
met het commando **`/tarieven-check`** (zie [`.claude/skills/tarieven-check/SKILL.md`](.claude/skills/tarieven-check/SKILL.md)).

Handmatig starten kan via het tabblad **Actions → Energieprijzen bijwerken → Run workflow**.

## Thuisbatterijen en advies

[`data/batterijen.json`](data/batterijen.json) bevat 31 thuisbatterijen (o.a. Zonneplan Nexus, Quatt HomeBattery,
Anker SOLIX, HomeWizard, Marstek, Huawei, Sessy en Tesla) met bruikbare capaciteit, laad-/ontlaadvermogen,
rendement en een indicatieve prijs. Elke waarde heeft een bron; wat de fabrikant niet publiceert staat onder
`geschat` en wordt in de app zo getoond.

- **Kies een batterij** om alle instellingen in te vullen, of stel ze zelf in.
- **Terugverdientijd** = aanschafprijs ÷ besparing per jaar. Vul je offerteprijs in voor een exact getal.
- **Advies**: de app rekent alle batterijen door met jouw meterdata en zet ze op volgorde van terugverdientijd.

Advies in de terminal: `node tests/run-tests.mjs --advies=P1e-....csv --leverancier=Zonneplan`

## Tests

```
node tests/run-tests.mjs            # alle tests (± 10 seconden)
node tests/run-tests.mjs --online   # ook controleren tegen de live EnergyZero API
```

De tests controleren de prijsdata, de leveranciersconfig, de rekenkern (met handberekende gevallen en
500 willekeurige scenario's), de interface en de volledige gebruikersflow in een nagebootste browser.
Ze draaien automatisch op GitHub bij elke push, en de dagelijkse prijsupdate wordt alleen opgeslagen
als de prijsdata de controle doorstaat.

Zet je eigen HomeWizard-export (`P1e-*.csv`) in de projectmap om ook met echte data te testen. Dat
bestand staat in `.gitignore` en komt dus nooit online.

## Privacy

Volledig lokaal in je browser.
Geen data wordt opgeslagen of verstuurd.
