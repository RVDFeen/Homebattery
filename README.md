# Batterij-besparing calculator

Statische, client-side calculator (geen server nodig). Alles draait in de
browser van de bezoeker.

## Op GitHub Pages zetten

1. Zet deze hele map (met `index.html` en de map `data/`) in je repo
   `RVDFeen/Homebattery`.
2. Ga naar **Settings → Pages**.
3. Kies bij **Source**: "Deploy from a branch", branch `main`, map `/ (root)`.
4. Na een minuut is de site live op `https://rvdfeen.github.io/homebattery/`.

Geen build-stap, geen Actions-workflow nodig — het is puur statische HTML/CSS/JS.

## Prijzenlijsten per leverancier toevoegen

Zie `data/leveranciers/README.md`. Kort samengevat: prijzen-CSV in de map
`data/leveranciers/` zetten en committen. De dropdown op de site leest de
map automatisch uit via de GitHub API — geen los manifest-bestand nodig.
**Let op:** dit vereist dat de repo openbaar (public) is.

## Meterdata

De meter-CSV (iemands eigen kwartier-verbruik/opwek) wordt **niet**
meegeleverd in de repo. Elke bezoeker uploadt die zelf via de knop op de
site; er wordt niets naar een server verstuurd.
