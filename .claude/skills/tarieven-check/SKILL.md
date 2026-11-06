---
name: tarieven-check
description: Controleer en actualiseer de opslag (inkoopvergoeding) per energieleverancier en de energiebelasting in data/leveranciers.json van de Homebattery-app. Gebruik bij "check de tarieven", "kloppen de prijzen nog", "update de leveranciers", of rond 1 januari / 1 juli.
---

# Tarieven-check Homebattery

Doel: `data/leveranciers.json` laten kloppen met de **huidige** tarieven, zonder ooit een
getal in te voeren dat niet goed onderbouwd is. De kale beursprijzen (`data/epex.csv`) worden
al dagelijks door een GitHub Action bijgewerkt — die hoef je niet te controleren.

## Hoe de data in elkaar zit

```
prijs per uur = (kale beursprijs + vast) × (1 + btw)
vast          = inkoopvergoeding excl. btw + energiebelasting excl. btw
```

- Elke leverancier heeft een lijst periodes `{ "vanaf": "JJJJ-MM-DD", "vast": 0.xxxxx, "bron": "..." }`.
  Een periode geldt vanaf zijn datum tot de volgende. **Bestaande periodes nooit wijzigen of
  verwijderen** — ze zijn historie. Alleen nieuwe periodes toevoegen.
- De laatste periode schuift automatisch mee met de energiebelasting van een nieuw jaar, zolang
  dat jaar in `energiebelasting` staat. Bij alleen een belastingwijziging hoeft er dus géén nieuwe
  periode bij.
- Leveranciers communiceren hun inkoopvergoeding bijna altijd **incl. btw**. Omrekenen:
  `node scripts/opslagen.mjs vast <bedrag incl. btw> <jaar>` → geeft het `vast`-getal.

## Stappen

1. **Huidige stand bekijken**: `node scripts/opslagen.mjs`. Dit toont per leverancier de opslag
   incl. btw die de app nu gebruikt, vanaf wanneer, en de bron.
   (Geen Node lokaal? Op Windows is er een draagbare versie te downloaden in de scratchpad; of
   reken het handmatig uit: opslag incl. btw = (vast − energiebelasting van dat jaar) × 1,21.)

2. **Energiebelasting**: staat het volgende kalenderjaar al in `energiebelasting`? Zo niet, en het
   is na Prinsjesdag: zoek het tarief elektriciteit, 1e schijf, **excl. btw**. Gebruik bij voorkeur
   de officiële bron (Fiscale sleuteltabel op rijksfinancien.nl, of belastingdienst.nl). Let op
   rectificaties — in 2026 bleken de Prinsjesdag-cijfers fout. Zet de bron in
   `_energiebelasting_bron`.

3. **Per leverancier de inkoopvergoeding stroom (dynamisch contract) opzoeken.**
   - Begin met een overzicht (bijv. jeroen.nl/dynamische-energie/aanbieders) om te zien waar
     verschillen zitten — maar **neem nooit een getal over op basis van alleen een vergelijkingssite**.
     (Voorbeeld uit nov 2026: jeroen.nl noemde €0,0339 voor Hegg; Hegg zelf: €0,02242.)
   - Zoek bij afwijking gericht op het domein van de leverancier zelf (WebSearch met
     `allowed_domains`), en lees de pagina met WebFetch. Tarievenbladen/productvoorwaarden (PDF) en
     supportpagina's zijn vaak beter dan marketingpagina's.
   - Een wijziging mag je doorvoeren als:
     a. de leverancier het bedrag zelf publiceert, **of**
     b. minstens twee onafhankelijke, recente (< 3 maanden) bronnen exact hetzelfde bedrag noemen
        én de leverancier het nergens zelf tegenspreekt. Noem dit expliciet "niet door leverancier
        bevestigd" in de `bron`.
   - Is het verschil met de huidige waarde ≤ €0,0003 → afronding, niets doen.
   - Kun je niets betrouwbaars vinden → **niets aanpassen**, wel melden.

4. **Wijziging invoeren**: nieuwe periode achteraan de lijst van die leverancier:
   ```json
   { "vanaf": "<ingangsdatum>", "vast": <uitkomst van opslagen.mjs vast ...>, "bron": "<url/paginanaam>: EUR x,xxxx/kWh incl. btw (gecontroleerd JJJJ-MM-DD)" }
   ```
   - `vanaf` = de ingangsdatum die de bron noemt. Noemt de bron geen datum, gebruik dan de dag na
     `laatstGecontroleerd` (dus: niet met terugwerkende kracht schatten) en vermeld dat in `bron`.
   - Bevestigd maar ongewijzigd? Je mag in de laatste periode een `bron` toevoegen/bijwerken.
   - Nieuwe leverancier: nieuwe sleutel met één periode. Leverancier gestopt met dynamisch: laten staan.
   - Werk `laatstGecontroleerd` bij naar vandaag.
   - **Terugleveringsvoorwaarden** (`teruglevering` in leveranciers.json): controleer per leverancier wat hij
     bij een dynamisch contract betaalt voor teruglevering, binnen én buiten de saldering, per kWh excl. btw
     bovenop de marktprijs (`binnen`, `buiten`; negatief = verkoopvergoeding), plus een eventuele bonus
     (`bonusPct`, `bonusUren`). Goede bron: keuze.nl "Zo anders gaan dynamische leveranciers om met terugleveren".
     Leveranciers zonder gegevens stonden er niet in; voeg ze toe zodra er een bron is.

5. **Controleren**:
   - `node -e "JSON.parse(require('fs').readFileSync('data/leveranciers.json','utf8'))"` (geldige JSON)
   - `node scripts/opslagen.mjs` (nieuwe waarden zien er logisch uit: meestal €0,00–€0,05 incl. btw)

6. **Rapporteren** aan de gebruiker, in een tabel:
   | Leverancier | Was (incl. btw) | Nu | Status | Bron |
   met status = *aangepast*, *bevestigd ongewijzigd*, of *niet te verifiëren*. Plus de
   energiebelasting. Daarna voorstellen om te committen (niet zelf pushen zonder akkoord).

## Thuisbatterijen (data/batterijen.json)

Neem bij elke check ook de batterijen mee:
- **Prijzen** (`prijs`, `prijsInfo`, `prijsBron`) veranderen het snelst. Controleer ze bij de fabrikant/webshop;
  vermeld in `prijsInfo` wat erin zit (incl./excl. btw, installatie, btw-teruggave) en de maand. Onbekend → `null`
  met uitleg; nooit een prijs gokken.
- **Nieuwe modellen** of configuraties: toevoegen met bron. Velden die de fabrikant niet publiceert in `geschat`.
- `capaciteit` is altijd de **bruikbare** capaciteit; `rendement` is round-trip AC (niet de vaak geadverteerde DC-waarde).
- Werk `laatstGecontroleerd` bij en draai `node tests/run-tests.mjs` (controleert o.a. dat alles binnen de schuifjes past).

## Bekende eigenaardigheden

- Eneco, Vattenfall en Energie VanOns tonen de inkoopvergoeding vaak alleen in Mijn-omgeving of
  een rekentool; kijk in de productvoorwaarden-PDF of het tarievenblad.
- Hegg en SamSam draaien (deels) op het platform van EnergyZero; hun opslag kan gelijk zijn aan die
  van EnergyZero, maar controleer dat apart.
- "Inkoopvergoeding" heet soms "opslag", "handling fee" (Zonneplan), "marktprijsopslag" (Energiek)
  of "inkoopkosten" (Vandebron).
- Vaste maandkosten (vastrecht) en terugleverkosten horen **niet** in `vast` — alleen bedragen per kWh.
