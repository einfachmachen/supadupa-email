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

### 3. Duplikate finden und aufräumen

Ganze Ordner werden nur über die Kopfdaten gruppiert (kein Body-Abruf) und
nach Duplikat-Gruppen sortiert. Pro Gruppe wird die beste Kopie
vorausgewählt, der Rest lässt sich in einem Rutsch entfernen. Details unter
*Benutzung → Ganzen Ordner deduplizieren*.

### 4. Inhalte vergleichen

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

Das Paket ist nicht signiert (es liegt nicht auf addons.thunderbird.net).
Damit Thunderbird es dauerhaft installiert:

1. *Einstellungen → Allgemein → ganz unten „Konfiguration bearbeiten“*,
2. `xpinstall.signatures.required` auf **false** setzen,
3. *Extras → Add-ons und Themes → Zahnrad → Add-on aus Datei installieren* →
   die `.xpi` auswählen.

Zum reinen Ausprobieren geht es auch ohne diesen Schalter über
*Extras → Entwicklerwerkzeuge → Debug-Add-ons → Temporäres Add-on laden*
(`manifest.json` auswählen) — das hält aber nur bis zum nächsten Neustart.

**Zum Entwickeln**

*Extras → Entwicklerwerkzeuge → Debug-Add-ons → Temporäres Add-on laden* →
`manifest.json` auswählen.

Voraussetzung: **Thunderbird 128+** (wegen `messages.import`).

## Benutzung

### Einzelne Mails prüfen

1. Mails im Hauptfenster markieren → Symbolleisten-Knopf **E-Mail-Prüfung**
   (oder in der Nachrichtenansicht der gleiche Knopf für die offene Mail).
2. Unter *Meine Namen & Adressen* mindestens ein Profil anlegen und speichern.
3. Pro Nachricht: Befunde lesen, Vorschlag antippen oder Felder von Hand
   ändern, **Empfänger speichern**.

### Ganzen Ordner deduplizieren (Massenlauf)

Oben **Ordner wählen** — der Ordner wird vollständig eingelesen (nur
Kopfdaten, seitenweise; das verkraftet auch zehntausende Nachrichten) und in
**Duplikat-Gruppen** einsortiert. Der Maßstab daneben ist einstellbar:

| Modus | Gruppiert nach |
|---|---|
| **streng** | gleiche `Message-ID` — echte Kopien derselben Nachricht |
| **normal** (Vorgabe) | `Message-ID`, sonst Absender + Betreff + Minute |
| **locker** | Absender + Betreff + Tag — findet auch neu zugestellte Kopien |

In jeder Gruppe ist die **beste Kopie vorausgewählt**: Es gewinnt die mit der
vollständigsten Empfänger-Angabe (Name *und* Adresse, passend zum Profil).
Ein *falscher* Name zählt dabei schlechter als ein fehlender — er sieht
richtig aus und würde beim Aufräumen unbemerkt durchrutschen. Danach zählen
Markierung, Tags und Größe. Die Vorauswahl lässt sich pro Gruppe per Radio-
Knopf ändern.

Drei Massen-Aktionen:

- **Alle Duplikate in den Papierkorb** — löscht in jeder Gruppe alles außer
  der behaltenen Kopie (in Blöcken, mit Rückfrage; auf Wunsch endgültig statt
  Papierkorb).
- **Behaltene Kopien prüfen** — lädt die Behalten-Kopien (bis 50 auf einmal)
  mit Text und Anhängen in die Einzelansicht.
- **Empfänger in N Nachrichten korrigieren** — wendet auf alle geladenen
  Nachrichten die Profil-Vorschläge an (nur dort, wo es überhaupt etwas zu
  ändern gibt), mit Rückfrage und Fortschrittsanzeige.

**Empfohlene Reihenfolge bei vielen Duplikaten:** erst Duplikate löschen,
dann die verbliebenen Kopien korrigieren — sonst korrigierst du Mails, die
danach ohnehin wegfallen.

> Vorsicht beim Modus **locker**: Er gruppiert allein über Absender, Betreff
> und Tag. Zwei echte, verschiedene Mails desselben Absenders mit gleichem
> Betreff am selben Tag (etwa zwei Belege einer Serie) landen dann in einer
> Gruppe. Vor dem Löschen die Gruppen durchsehen — und zunächst in den
> Papierkorb löschen, nicht endgültig.

## Tests

```bash
npm test      # node:test, keine Abhängigkeiten
```

53 Tests decken Header-Kodierung, das Byte-genaue Umschreiben der
Roh-Nachricht, die Empfängerprüfung samt Vorschlägen, die
Dateinamen-Plausibilität, den Textvergleich sowie Gruppierung und
Kopie-Bewertung der Duplikatsuche ab (inklusive eines Laufs über 10.000
Kopfdatensätze).

## Aufbau

| Datei | Zweck |
|---|---|
| `manifest.json` | MV2-Manifest, Thunderbird 128+ |
| `background.js` | Einstiegspunkte, merkt sich die Auswahl |
| `lib/mime.js` | RFC 2047/5322: Adressen parsen, kodieren, formatieren |
| `lib/rawmail.js` | Header im Byte-Strom lesen/ersetzen/falten |
| `lib/recipients.js` | Profile, Empfängerprüfung, Korrekturvorschläge |
| `lib/attachments.js` | Anhang- und Dateinamen-Plausibilität |
| `lib/dedupe.js` | Duplikat-Gruppen, Bewertung „welche Kopie bleibt“ |
| `lib/similarity.js` | Textnormalisierung, Ähnlichkeit, Faktenabgleich |
| `lib/messageStore.js` | Thunderbird-APIs (lesen, importieren, löschen) |
| `ui/tool.*` | Oberfläche (Design-Tokens nach SupaDupa-Design-Guide) |

Die `lib/`-Module sind frei von Browser- und Thunderbird-APIs — deshalb sind
sie einzeln testbar und ließen sich unverändert in eine andere Erweiterung
übernehmen (etwa als Ergänzung zu
[removedupes](https://github.com/eyalroz/removedupes)). Beide Erweiterungen
lassen sich parallel betreiben: removedupes findet Duplikate, diese hier
entscheidet zusätzlich, **welche** Kopie die bessere ist, und repariert die
Empfänger-Zeile.
