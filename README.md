# SupaDupa Mail-Prüfung (Thunderbird-Erweiterung)

Prüft E-Mails inhaltlich, kontrolliert die Anhänge samt Dateinamen — und
**repariert die Empfänger-Zeile**: Vorname, Nachname und Adresse lassen sich
direkt bearbeiten, auch nachträglich an bereits abgelegten Nachrichten.

Entstanden als Ergänzung zum Arbeitsablauf rund um **SupaDupa Money**
(Finanztracking): Rechnungs-Mails sollen inhaltlich stimmen, einen sprechend
benannten Beleg im Anhang haben und sauber adressiert sein.

---

## Was die Erweiterung kann

### 1. Empfänger bearbeiten (Kernfunktion)

Für jede geladene Nachricht wird die `To:`-Zeile in **Name** und
**E-Mail-Adresse** zerlegt und einzeln editierbar angeboten. Erkannt und
gemeldet werden:

| Fall | Meldung |
|---|---|
| Nur Adresse, kein Name | `no-name` — Vorschlag aus dem Profil |
| Name passt nicht zur Adresse | `name-mismatch` (Fehler) |
| Abweichende Schreibweise („Mustermann, Max“) | `name-variant` (nur Hinweis) |
| „Name“ ist bloß die Adresse (`max.mustermann`) | `name-is-email` |
| Adresse fehlt ganz | `no-email` — Nachschlag über den Namen |
| Adresse syntaktisch kaputt | `bad-email` |
| Vertippte Domain (`gmial.com`) | `typo-domain` mit Korrekturvorschlag |

Grundlage sind **Profile**: „Zu dieser Adresse gehört dieser Name“, mit
beliebig vielen Schreibweisen und Adressen je Person. Profile lassen sich von
Hand pflegen oder aus dem Adressbuch übernehmen (häufigster Name je Adresse
gewinnt).

**Wie das Speichern technisch funktioniert (wichtig):** Thunderbird bietet
keine API, um Kopfzeilen einer *gespeicherten* Nachricht in-place zu ändern.
Der einzige unterstützte Weg — und der, den diese Erweiterung geht:

1. Roh-Nachricht byte-genau lesen (`messages.getRaw`),
2. **nur** die betroffene Header-Zeile im Byte-Strom ersetzen
   (`lib/rawmail.js`, RFC-5322-konformes Falten, Umlaute als RFC-2047-
   encoded-word),
3. Ergebnis als neue Nachricht in **denselben Ordner** importieren
   (`messages.import`) — gelesen/markiert/Tags werden übernommen,
4. Original in den Papierkorb (optional endgültig löschen).

Der Nachrichtenkörper wird dabei **nicht angefasst** — Anhänge, Kodierung und
alle übrigen Header bleiben Byte für Byte identisch. Nebenwirkung des Weges:
Die Nachricht bekommt eine neue interne ID; bei einem IMAP-Ordner wird sie neu
hochgeladen. Signierte/verschlüsselte Mails verlieren beim Ändern der
Kopfzeilen naturgemäß ihre Signaturprüfung — das gilt für jede
Header-Bearbeitung, nicht nur für diese.

### 2. Anhänge prüfen

Pro Anhang: Name, Typ, Größe — plus Plausibilitätsprüfung des Dateinamens:

- nichtssagende Namen (`ATT00001.pdf`, `Dokument1.pdf`, `scan_0001.pdf`, `image001.png`),
- Endung passt nicht zum MIME-Typ,
- doppelte Endung (`Rechnung.pdf.js`) und ausführbare/makrofähige Endungen,
- 0-Byte-Anhänge, unzulässige Zeichen, überlange Namen,
- **Bezug zum Inhalt**: Steht die im Text genannte Rechnungs-/Belegnummer auch
  im Dateinamen? Passt der Name zum Betreff?
- Text kündigt einen Anhang an („anbei“, „beigefügt“) — es hängt aber keiner dran.

Zu jedem unplausiblen Namen gibt es einen **Vorschlag** im Muster
`2024-04-03_Rechnung-2024-0815.pdf` (Datum · Betreff · Belegnummer).

### 3. Inhalte vergleichen

Alle geladenen Nachrichten werden paarweise verglichen (Wort- und
Bigramm-Ähnlichkeit, Zitate und Signaturen fliegen vorher raus, HTML wird zu
Text). Ausgabe: Prozentwert und Einstufung (*inhaltlich identisch · nahezu
gleich · ähnlich · unterschiedlich*), die Wörter, die nur auf einer Seite
vorkommen — und ein Faktenabgleich über **Beträge, IBAN, Daten und
Belegnummern**. Genau das ist der Fall „Text ist identisch, nur der Empfänger
war falsch“ — und der gefährliche Gegenfall „sieht gleich aus, aber der Betrag
weicht ab“.

---

## Installation

**Fertiges Paket bauen**

```bash
npm run build      # → dist/supadupa-mailcheck-1.0.0.xpi
```

In Thunderbird: *Extras → Add-ons → Zahnrad → Add-on aus Datei installieren*.
(Das Paket ist nicht bei addons.thunderbird.net signiert; zum dauerhaften
Installieren entweder über *Debug-Add-ons → Temporär laden* testen oder eine
Thunderbird-Version nutzen, die unsignierte Add-ons zulässt.)

**Zum Entwickeln**

*Extras → Entwicklerwerkzeuge → Debug-Add-ons → Temporäres Add-on laden* →
`manifest.json` auswählen.

Voraussetzung: **Thunderbird 128+** (wegen `messages.import`).

## Benutzung

1. Mails im Hauptfenster markieren → Symbolleisten-Knopf **E-Mail-Prüfung**
   (oder in der Nachrichtenansicht der gleiche Knopf für die offene Mail).
2. Unter *Meine Namen & Adressen* mindestens ein Profil anlegen und speichern.
3. Pro Nachricht: Befunde lesen, Vorschlag antippen oder Felder von Hand
   ändern, **Empfänger speichern**.

## Tests

```bash
npm test      # node:test, keine Abhängigkeiten
```

43 Tests decken Header-Kodierung, das Byte-genaue Umschreiben der
Roh-Nachricht, die Empfängerprüfung samt Vorschlägen, die
Dateinamen-Plausibilität und den Textvergleich ab.

## Aufbau

| Datei | Zweck |
|---|---|
| `manifest.json` | MV2-Manifest, Thunderbird 128+ |
| `background.js` | Einstiegspunkte, merkt sich die Auswahl |
| `lib/mime.js` | RFC 2047/5322: Adressen parsen, kodieren, formatieren |
| `lib/rawmail.js` | Header im Byte-Strom lesen/ersetzen/falten |
| `lib/recipients.js` | Profile, Empfängerprüfung, Korrekturvorschläge |
| `lib/attachments.js` | Anhang- und Dateinamen-Plausibilität |
| `lib/similarity.js` | Textnormalisierung, Ähnlichkeit, Faktenabgleich |
| `lib/messageStore.js` | Thunderbird-APIs (lesen, importieren, löschen) |
| `ui/tool.*` | Oberfläche (Design-Tokens nach SupaDupa-Design-Guide) |

Die `lib/`-Module sind frei von Browser- und Thunderbird-APIs — deshalb sind
sie einzeln testbar und ließen sich unverändert in eine andere Erweiterung
übernehmen (etwa als Ergänzung zu
[removedupes](https://github.com/eyalroz/removedupes), das Duplikate findet,
aber weder Empfänger bearbeiten noch Anhänge/Inhalte bewerten kann).
