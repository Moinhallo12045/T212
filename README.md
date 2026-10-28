# Trading 212 Radar 📊

Ein schnelles, eigenständiges **Live-Portfolio-, Allokations- & Dividenden-Dashboard** für **Trading 212** (optimiert als Progressive Web App für iPad, iPhone & Desktop).

## ✨ Features

- **Exakte EUR-Bewertung & Multi-Währungs-Support**:
  - Nutzt die offiziellen Trading 212 Kontodaten (`/api/v0/equity/account/cash` via `summary`), sofern vom Cloudflare Worker geliefert.
  - Berechnet für Einzelpositionen in `USD`, `GBP`/`GBX`, `CHF` und `EUR` präzise den aktuellen EUR-Marktwert sowie den historischen EUR-Einstandswert (`Marktwert EUR - T212 EUR-PPL`) mit aktuellen EZB-Referenzkursen.
- **3 Dashboard-Ansichten**:
  1. **📊 Positionen**: Live-Bestände mit Suche, Sortierung (Wert, Return in EUR/%, Gewichtung, Ticker), Währungs-Badges, Pie-Indikatoren und prozentualem Depot-Anteil.
  2. **💰 Dividenden-Radar**: Jahres- und Monatsprognose, persönliche Dividendenrendite (*Yield on Cost*), Ex-Tag- & Zahltag-Countdowns, Steuer-Umschalter (*Brutto / 15% Quellensteuer / DE Netto*) sowie ein interaktiver Editor für eigene Dividenden-Daten je Ticker. Zeigt zudem die historische Dividenden-Historie aus Trading 212 an, falls vom Worker bereitgestellt.
  3. **📈 Analyse & Allokation**: Visuelle Aufschlüsselung nach Top-Holdings, Währungs-Allokation und Performance-Spitzenreitern.
- **Komfort & Datenschutz**:
  - **👁️ Privat-Modus**: Blendet alle Geldbeträge per Klick unscharf aus.
  - **🧪 Demo-Modus**: Direktes Testen aller Funktionen mit realistischen Beispieldaten ohne API-Schlüssel.
  - **📥 JSON-Import & 📤 CSV-Export**: Manuelles Einlesen von API-Responses und Export für Excel/Numbers.
  - **📲 PWA & Offline-Cache**: Installierbar auf dem Home-Bildschirm (iOS/iPadOS/Desktop) mit sofortiger Cache-Anzeige beim Start und Ghost-Cache-freiem Network-First Service Worker (`sw.js`).

## 🚀 Einrichtung

### 1. Trading 212 API-Key erstellen
1. Öffne die **Trading 212** App → **Einstellungen** → **API (Beta)**.
2. Erstelle einen neuen Schlüssel mit Lese-Berechtigungen (*Account Data*, *Portfolio*, *History / Dividends*).
3. Notiere dir **API Key (ID)** und **API Secret**.

### 2. Cloudflare Worker (CORS-Proxy)
Da die Trading 212 API direkte Browser-Aufrufe per CORS blockiert, wird ein leichtgewichtiger Cloudflare Worker zwischenBrowser und Trading 212 geschaltet:
- Der vollständige Quellcode für den Worker liegt in [`worker.js`](./worker.js).
- Der Worker ruft parallel `/api/v0/equity/portfolio`, `/api/v0/equity/account/cash` und `/api/v0/equity/history/dividends` ab und gibt sie gebündelt als `{ portfolio, summary, dividends }` zurück.

## 📁 Projektstruktur

- [`index.html`](./index.html) – Gesamte Applikation (HTML, CSS & JavaScript ohne externe Abhängigkeiten)
- [`worker.js`](./worker.js) – Cloudflare Worker Proxy-Skript für die Trading 212 API
- [`sw.js`](./sw.js) – Service Worker (Network-First mit Offline-Fallback für statische Assets)
- [`manifest.json`](./manifest.json) – Web App Manifest für PWA-Installation
