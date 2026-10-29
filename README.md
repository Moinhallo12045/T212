# Trading 212 Radar 📊

Ein schnelles, eigenständiges **Live-Portfolio-, Pie-, Allokations- & Dividenden-Dashboard** für **Trading 212** – komplett ohne externe Frameworks und optimiert als Progressive Web App (PWA) für Desktop, iPad und iPhone.

---

## ✨ Features

### 1. Exakte EUR-Bewertung & Multi-Währungs-Support
- **Offizielle Kontodaten**: Nutzt die Trading 212 Kontosummen (`/api/v0/equity/account/cash` via `summary`), inklusive freiem Cash, in Pies gebundenem Cash sowie realisiertem Gewinn/Verlust.
- **Präzise Fremdwährungs-Umrechnung**: Bewertet Einzelpositionen in `USD`, `GBP`, `GBX` (Britische Pence mit automatischer Faktor-100-Normalisierung), `CHF`, `CAD`, `PLN`, `DKK`, `SEK`, `NOK` und `EUR` anhand tagesaktueller EZB-Referenzkurse (`api.frankfurter.app`) sowie impliziter T212-FX-Kurse.
- **Klarnamen & Marken-Logos**: Automatische Auflösung kryptischer T212-Ticker (`GOOGL_US_EQ` → *Alphabet (Class A)*, `NGl_EQ` → *National Grid*) und mehrstufige Marken-Logo-Auflösung mit `no-referrer`-Schutz und SVG-Monogramm-Fallback.

### 2. Vier spezialisierte Dashboard-Ansichten
1. **📊 Positionen (`#tabPortfolio`)**:
   - Live-Bestände mit Volltextsuche, Pie-Filter (*Alle / Nur in Pies / Nur freie Einzelaktien / Einzelner Pie*) und Direkt-Sortierung per Tabellenkopf oder Dropdown.
   - Anzeige von Gesamtbestand vs. Pie-Anteil, Einstandskurs, aktuellem Kurs, EUR-Marktwert, Depot-Gewichtung sowie Kurs- und Währungseffekt (`FX`).
2. **🥧 Pies (`#tabPies`)**:
   - Einklappbare Übersicht aller Trading 212 Pies mit Status-Badge (*Ahead / On Track / Behind*), Zielwert-Fortschritt, Pie-Cash, Dividenden-Modus (*Reinvestieren* vs. *Auszahlen*) sowie erhaltenen/reinvestierten Dividenden.
   - Interaktives Donut-Diagramm je Pie mit **Ist- vs. Ziel-Gewichtung** und Drift-Indikator (Abweichung in Prozentpunkten je enthaltener Position).
3. **💰 Dividenden-Radar (`#tabDividends`)**:
   - Jahres- und Monatsprognose, persönliche Dividendenrendite (*Yield on Cost*), Ex-Tag- & Zahltag-Countdowns sowie ein interaktiver Editor für eigene Dividenden-Daten je Ticker.
   - **Steuer-Umschalter**: *Brutto (100 %)*, *T212 Auszahlung (-15 % US-Quellensteuer, 0 % Abzug für EUR/UK)* oder *DE Netto (nach 26,375 % Abgeltungsteuer inkl. Soli)*.
   - **Historie**: Zeigt die tatsächlich ausgezahlten historischen Dividenden aus Trading 212 (`/api/v0/equity/history/dividends`).
4. **📈 Analyse & Allokation (`#tabAnalytics`)**:
   - **Interaktive SVG-Donut-Charts** mit Hover-/Touch-Fokus für *Depot-Architektur (Pies vs. Einzelaktien vs. Cash)*, *Währungs-Allokation* und *Top-Positionen*.
   - **Performance-Spitzenreiter & Trefferquote** (Gewinner vs. Verlierer im Depot).
   - **📅 Monatlicher Dividenden-Kalender (Jan – Dez)**: Interaktives SVG-Balkendiagramm des erwarteten monatlichen Cashflows inkl. Monatsdurchschnitt und Tooltip-Aufschlüsselung je Zahler.

### 3. Komfort, Sicherheit & Datenschutz
- **👁️ Privat-Modus**: Blendet sämtliche Geldbeträge, Renditen, FX-Effekte, Pie-Werte, Cash-Bestände und Chart-Summen per Klick unscharf aus (`.blur-val`).
- **🧪 Demo-Modus**: Sofortiges Ausprobieren aller 4 Tabs inkl. Beispiel-Pies und Dividenden-Historie ohne eigene API-Schlüssel.
- **🔒 Gehärtete Sicherheit**:
  - **HTTPS-Zwang** für Remote-Worker-URLs (verhindert unverschlüsselte Übertragung des `Authorization`-Headers).
  - **Strikte Storage-Trennung**: API-Zugangsdaten verbleiben ohne aktiviertes *„Lokal merken"* ausschließlich im flüchtigen `sessionStorage`.
  - **DOM-XSS- & CSV-Injection-Schutz**: Vollständiges HTML-Escaping aller API-/JSON-Felder sowie Formel-Sanitizing (`=`, `+`, `-`, `@`) beim CSV-Export.
- **📥 JSON-Import & 📤 CSV-Export**: Manuelles Einlesen von API-Responses (Strg+V) und UTF-8-BOM-kodierter CSV-Export für Excel/Numbers.
- **📲 PWA & Offline-Cache**: Installierbar auf iOS/iPadOS/Android/Desktop inkl. App-Shortcuts (`#tabPies`, `#tabDividends`, `#tabAnalytics`) und Network-First Service Worker (`sw.js`, Cache `t212-radar-v11`).

---

## 🚀 Einrichtung

### 1. Trading 212 API-Key erstellen
1. Öffne die **Trading 212** App → **Einstellungen** → **API (Beta)**.
2. Erstelle einen neuen Schlüssel mit **Lese-Berechtigungen** (*Account Data*, *Portfolio*, *Pies*, *History / Dividends*).
3. Notiere dir **API Key (ID)** und **API Secret**.

### 2. Cloudflare Worker (CORS-Proxy & Rate-Limit-Shield)
Da die Trading 212 API direkte Browser-Aufrufe per CORS blockiert und strikte Rate-Limits besitzt (z. B. `/equity/portfolio` und `/equity/pies/{id}` max. 1 Request / 5 Sekunden), übernimmt [`worker.js`](./worker.js) das Bündeln und Cachen:
- Ruft parallel `/api/v0/equity/portfolio`, `/api/v0/equity/account/cash`, `/api/v0/equity/history/dividends?limit=50`, `/api/v0/equity/pies` (+ Einzel-Details `/api/v0/equity/pies/{id}`) sowie `/api/v0/equity/metadata/instruments` ab.
- **Intelligentes Caching & Rate-Limit-Schutz**:
  - Kombiniertes Cloudflare Edge-Caching (`caches.default`) und größenbegrenztes In-Memory-Caching (`MAX_CACHE_ENTRIES = 250`).
  - **Progressives Pie-Nachladen**: Bei Depots mit mehr als 4 Pies lädt der Worker bis zu 4 Pie-Details pro Abruf und vervollständigt verbleibende Pies beim nächsten Refresh aus dem 10-Minuten-Cache.
  - Automatischer Retry bei kurzzeitigen HTTP-429-Antworten sowie Geo-Restriction auf Deutschland (`DE`).
- Gibt ein konsolidiertes JSON-Payload `{ portfolio, summary, pies, piesStatus, dividends, environment, fetchedAt }` zurück.

---

## 📁 Projektstruktur

- [`index.html`](./index.html) – Gesamte Web-Applikation (HTML5, CSS3 & Vanilla JavaScript ohne externe Abhängigkeiten)
- [`worker.js`](./worker.js) – Cloudflare Worker Proxy-Skript für die Trading 212 API (inkl. Pie-Auflösung, Instrumenten-Metadaten & Caching)
- [`sw.js`](./sw.js) – Service Worker (`t212-radar-v11`, Network-First mit Offline-Fallback für alle statischen Assets & Icons)
- [`manifest.json`](./manifest.json) – Web App Manifest inkl. Icons und App-Shortcuts für die PWA-Installation
