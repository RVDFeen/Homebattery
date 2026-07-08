# Leveranciers-map

Zet hier per leverancier één meter-CSV neer (kwartierwaarden, cumulatief),
met kolommen:

```
time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh
```

## Nieuwe leverancier toevoegen

1. Zet het CSV-bestand in deze map, bv. `vattenfall.csv`.
2. Voeg een regel toe aan `index.json`:

```json
[
  { "naam": "Voorbeeld leverancier", "bestand": "voorbeeld.csv" },
  { "naam": "Vattenfall", "bestand": "vattenfall.csv" }
]
```

3. Commit + push. De site pikt 'm automatisch op in de dropdown — geen
   verdere code-aanpassingen nodig.

Je kunt `voorbeeld.csv` gerust verwijderen zodra je je eigen bestanden hebt
toegevoegd (haal 'm dan ook uit `index.json`).

De kwartierprijzen-CSV (dynamische uurprijzen) hoort hier **niet** in dit
mapje — die uploadt de bezoeker altijd zelf via de knop op de site.
