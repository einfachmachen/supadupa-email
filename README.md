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
beliebig vielen Schreibweisen und Adressen je Person. Sie gelten für **jede**
Person — Absender wie Empfänger, nicht nur für die eigenen Adressen.

## Download

Der jeweils aktuelle Stand liegt versioniert im Ordner `releases/`; jede
ausgelieferte Fassung bekommt eine eigene Nummer, damit klar ist, welcher Stand
gerade installiert ist:

[releases/supadupa-mailcheck-1.0.16.xpi](releases/supadupa-mailcheck-1.0.16.xpi)

**Adressen in diesem Ordner** (Klappe über den Profilen) ist der schnelle Weg
dorthin: Nach dem Einlesen stehen dort alle Namen und Adressen aus Absender-,
Empfänger- und Kopie-Zeilen — aus dem geladenen **Ordner**, und wenn keiner
geladen ist, aus der **markierten Auswahl**. Die Kopfzeile sagt, woher sie
stammen. Öffnet man die Prüfung mit einem markierten Ordner im Hauptfenster,
wird dieser Ordner automatisch übernommen; ein zweites Auswählen von Hand
entfällt.

Je Adresse stehen **alle gefundenen
Schreibweisen samt Häufigkeit** („Bernd Muster (12)", „Muster, Bernd (3)",
„ohne Namen (5)") und der Zahl der abweichenden Vorkommen. Ein Feld je
Adresse, einmal die richtige Schreibweise festlegen (oder einen der Chips
anklicken), *Festlegungen speichern* — und ab da zeigt der Leuchttisch überall
gleich den richtigen Namen, ohne dass dort noch etwas anzupassen wäre.

- *Leere Felder mit der häufigsten Schreibweise füllen* trägt in jedes noch
  leere Feld die Variante ein, die bei dieser Adresse am häufigsten vorkommt
  und wie ein echter Name aussieht (ein „Name", der bloß die Adresse
  wiederholt, zählt nicht). Bereits ausgefüllte Felder bleiben unangetastet,
  und gespeichert wird dabei nichts — es ist eine Vorbefüllung zum Durchsehen.
- Der Schiebeschalter über der Liste zeigt beide Zustände nebeneinander:
  *alle 9* ⇄ *nur 8 uneinheitliche*. Vorgabe ist „nur uneinheitliche".
- Die Knöpfe stehen unter der Liste — dort, wo man nach dem Durchsehen
  ankommt.

**Nicht nur der Name, auch die Adresse.** Unter dem Namensfeld steht ein
zweites Feld für die *richtige Adresse*. Gebraucht wird es, wenn die in den
Mails gespeicherte Adresse selbst nicht mehr taugt — der häufigste Fall sind
Exchange-/Microsoft-365-Ersatzkennungen (`IMCEAEX-…@…prod.outlook.com`,
`X500:`, `*.onmicrosoft.com`), die Outlook einsetzt, sobald ein Firmenpostfach
umgezogen oder abgeschaltet ist. Solche Einträge werden als Ersatzadresse
markiert; steckt der Klarname in der Kennung, sucht die Erweiterung im selben
Ordner nach einer echten Adresse derselben Person und trägt sie als Vorschlag
ein. Beim Speichern landen alte und richtige Adresse in **einem** Profil
(`preferredEmail`), und die Prüfung meldet ab dann `old-address` mit der
richtigen Adresse als Vorschlag — beim Zusammenfassen wird sie eingesetzt.

In der Oberfläche heißen diese Einträge **Festlegungen** („zu dieser Adresse
gehört dieser Name"); im Code und im Speicher heißen sie weiterhin `profiles`.

Alternativ von Hand pflegen oder aus dem Thunderbird-Adressbuch übernehmen.

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

**Was als Anhang gilt** (die Regel hat es in sich): Ein ausdrückliches
`Content-Disposition: attachment` schlägt alles. Outlook packt echte Anhänge
in ein `multipart/related` und gibt ihnen zusätzlich eine `Content-ID` —
werden die als „eingebettete Bilder" abgetan, verschwinden komplette PDFs
aus der Liste. Ein Teil mit Content-ID zählt nur dann zum Text, wenn das HTML
ihn auch wirklich per `cid:` einbindet; ein *verwaister* cid-Teil landet in
der Anhangsliste. **Leitsatz: Nichts darf lautlos verschwinden** — lieber ein
Eintrag zu viel als eine verlorene Datei.

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

### 4. Fragmente zu einer vollständigen Mail zusammenführen

Der Fall, für den es diese Erweiterung eigentlich gibt: Von derselben
Nachricht liegen mehrere unvollständige Kopien herum — eine hat alle Anhänge,
aber nur die nackte Adresse ohne Namen; eine andere hat den sauberen
Empfänger und einen sprechenden Dateinamen, aber nur einen Teil der Anhänge.

**Zu einer vollständigen Mail zusammenführen** baut daraus eine neue,
vollständige Nachricht:

1. **Grundlage** ist die Kopie mit den meisten/größten Anhängen — nur dort
   liegen die Nutzdaten wirklich vor.
2. Von den Geschwister-Kopien werden **ausschließlich Kopfdaten** übernommen:
   die beste `To:`/`Cc:`-Zeile (danach noch gegen die Profile korrigiert) und
   die besseren **Dateinamen** — ein Anhang wird über Größe + MIME-Typ in der
   anderen Kopie wiedererkannt.
3. Fehlt überall ein brauchbarer Dateiname, wird einer aus Datum, Betreff und
   Belegnummer gebildet.
4. Das Ergebnis wird als neue Nachricht in denselben Ordner gelegt, die alten
   Kopien wandern in den Papierkorb.

**Was dabei bewusst NICHT passiert:** Es wird nichts erfunden und nichts
zusammengeschnitten, was nicht zusammengehört. Anhang-Nutzdaten werden nie
zwischen Kopien verschoben — nur Kopfzeilen. Der Rumpf der Grundlage bleibt
Byte für Byte erhalten, Base64-Nutzlast wird nicht angefasst. Vor dem
Ausführen zeigt ein Dialog den kompletten Plan (welche Kopie liefert was,
welcher Anhang wird wie umbenannt) zum Bestätigen oder Überspringen.

> Grenze: Wenn eine Kopie einen Anhang hat, den die Grundlage **gar nicht**
> enthält, wird er nicht hinüberkopiert — dafür müsste die MIME-Struktur neu
> gebaut werden, und ein falsch zusammengesetztes Multipart ist schlimmer als
> eine Kopie zu viel. Der Plan nennt in dem Fall die Grundlage mit ihrer
> Anhangszahl, sodass du es siehst.

### 5. Leuchttisch: Bestandteile auswählen, neue Mail bauen

Die Gegenüberstellung. Gestaltungsregel: **Die lesbare E-Mail steht im
Mittelpunkt** — alles andere ist zugeklappt, bis es gebraucht wird.

**Von oben nach unten:**

1. **Fassungen** — je ein Knopf pro Kopie, beschriftet mit dem **Datum** und
   einer Kurzlage („2 Anh. · Empfänger unklar · Zeichenmüll"). Ein Klick
   schaltet die **ganze Ansicht** auf diese Fassung um: Text, Betreff,
   Absender, Empfänger, Cc, Datum und die bevorzugten Anhang-Namen. Der erste
   Knopf, *beste Fassung*, stellt die automatische Auswahl aus allen Kopien
   wieder her.
2. **Betreff** — groß und direkt bearbeitbar; abweichende Fassungen als Chips
   darunter.
3. **Der Text** — nimmt den größten Teil des Fensters ein, mit vier Modi:
   - **Formatiert** (Vorgabe bei HTML-Mails): die Mail so, wie sie gemeint
     war. Word-/Outlook-Ballast (`mso-*`, `<o:p>`, `MsoNormal`, bedingte
     Kommentare, Bilder mit `width="1154"`) fliegt raus, der zitierte Verlauf
     steckt zusammengeklappt in einem `<details>`, Inline-Bilder (`cid:`)
     kommen aus der Nachricht selbst. Angezeigt wird in einem **iframe ohne
     Skriptrechte** mit eigener `default-src 'none'`-CSP; externe Bilder
     werden blockiert und als Platzhalter markiert (keine Zählpixel).
   - **Text**: der gesäuberte Klartext, ohne jede Markierung, direkt
     bearbeitbar — genau das, was gespeichert wird.
   - **Vergleich**: alle Fassungen überlagert, Unterschiede farbig (weiß = in
     allen, gold = in mehreren, grau = nur in einer).
   - **Original**: der Rohtext der aktiven Fassung mit **sichtbar gemachten**
     Steuerzeichen (`⌷` Zero-Width, `␣` geschütztes Leerzeichen, `¬`
     bedingter Trennstrich, `␦` Steuerzeichen, `⇄` Schreibrichtung, `◆`
     Ersatzzeichen).
4. **Eingebettete Bilder** (zugeklappt): Bestandsaufnahme aller `cid:`-Verweise
   im HTML — *vorhanden*, *aus Kopie N ergänzt* oder *fehlt in allen Kopien*,
   jeweils mit Vorschaubild. Fehlt ein Bild in der angezeigten Fassung, wird
   es **aus einer Geschwister-Kopie ergänzt**: Outlook vergibt beim
   Weiterleiten neue Content-IDs, behält aber den Namensteil
   (`image001.png@…`) — darüber findet sich dasselbe Bild wieder. Gibt es
   mehrere Fassungen, gewinnt die größere Datei. Die Klappe wird gold, sobald
   etwas endgültig fehlt. Ein Bild, das **zugleich im Text eingebunden und als
   Anhang deklariert** ist (Outlook-Muster), erscheint in der Anhangsliste
   markiert und **abgewählt** — es steckt ja schon im Rumpf. Schaltet man
   *Formatierung behalten* ab, wird es automatisch wieder angehakt, damit es
   nicht verlorengeht.
5. **Anhänge** (zugeklappt): jede Zeile mit **Miniatur-Vorschau** (Bilder als
   echtes Vorschaubild, andere Typen als Kachel) — Klick auf die Miniatur
   vergrößert. **Winzige Teile unter 100 Byte** (0-Byte-Reste, 2/4-Byte-
   Fragmente, Zählpixel) sind eingeklappt und nicht vorausgewählt; ein Klick
   auf „N winzige Teile einblenden" zeigt sie trotzdem — weggeräumt, nicht
   weggeworfen. Ansonsten über ihren **Inhalt** zusammengefasst — SHA-256
   über die dekodierten Dateibytes. 10 Kopien mit je 5 Anhängen ergeben genau
   **5 Einträge**, jeder mit allen vorkommenden Namensvarianten als Chips und
   einem frei editierbaren Dateinamen. Zeile anklicken und **Leertaste**
   drücken öffnet die **Vorschau** (PDF, Bilder und Text direkt im Fenster,
   Esc schließt, alles andere über „Speichern"). Der Typ wird aus den Bytes
   erkannt — ein PDF, das sich als `application/octet-stream` ausgibt, wird
   trotzdem angezeigt.
6. **Weiter zugeklappt**: *Empfänger & Absender*, *Datum*. Die Zeile
   *Empfänger & Absender* zeigt schon zugeklappt **Von, An und — falls
   vorhanden — Kopie** im Klartext; aufklappen muss man nur zum Ändern. Jede
   Klappe trägt ihre Kurzfassung („2 von 2 ausgewählt, 3 winzige
   ausgeblendet") und wird gold umrandet, wenn dort etwas zu prüfen ist — so
   siehst du zugeklappt, ob du hineinsehen musst. Erst beim Aufklappen werden
   die Varianten gebaut.
7. **Fußleiste**: *Formatierung & eingebettete Bilder behalten*,
   *Ausgangs-Mails behalten* (Vorgabe an) und *Neue Nachricht
   erzeugen*.

Ganz oben warnt eine goldene Zeile, wenn der Text einen Anhang **ankündigt**
(„anbei", „in der pdf-Datei"), aber keiner vorhanden ist — mit dem Hinweis,
die anderen Fassungen zu prüfen.

Die neue Nachricht wird **frisch aufgebaut**, in der Verschachtelung, die
Mailprogramme erwarten:

```
multipart/mixed
  multipart/alternative
    text/plain                  ← Rückfallebene
    multipart/related
      text/html                 ← die formatierte Mail
      image/png  [cid:bild@1]   ← eingebettetes Bild
  application/pdf  "Rechnung.pdf"  ← Dateianhang
```

Die Bilder werden dabei **unter der Content-ID eingesetzt, die das HTML
benutzt** — auch wenn sie aus einer Kopie mit anderer ID stammen. Damit
funktionieren sie in der neuen Nachricht wieder. Jeder gewählte Anhang bleibt
ein **byte-genau übernommener MIME-Block** aus seiner Quell-Mail; nur die
Dateinamen-Kopfzeile wird neu geschrieben, die kodierte Nutzlast nie.
Ohne HTML entsteht wie bisher eine reine Textnachricht.
Anders als beim automatischen Zusammenführen dürfen die Anhänge dabei aus
**verschiedenen** Kopien stammen. Ein `X-SupaDupa-Merged-From`-Header hält
fest, aus welchen Nachrichten sie gebaut wurde.

### 6. Inhalte vergleichen

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
npm run build      # → dist/supadupa-mailcheck-<version>.xpi
npm run release    # Version +1, packen, nach releases/ kopieren
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

### Der Durchgang: einmal ansehen, vormerken, am Ende entscheiden

Die Seite ist von oben nach unten in der Reihenfolge aufgebaut, in der man sie
abarbeitet: ganz oben der **Startknopf**, der den Leuchttisch bei der ersten
offenen Dublette öffnet, darunter **Schritt 1: Adressen in diesem Ordner**,
**Schritt 2: Festlegungen (welcher Name gehört zu welcher Adresse)**, **Schritt 3: Übersicht** und
**Schritt 4: Vormerkungen**. Erst die Adressen klären, dann die Profile prüfen,
dann die Dubletten ansehen — Schritt 1 und 2 klappen sich nach dem Speichern
von selbst zu, damit die Übersicht den ganzen Platz bekommt. Der Startknopf
sitzt oben in Schritt 3, gleich neben dem Schärfegrad, mit dem die Gruppen
gebildet wurden; Schritt 1 und 2 sind davon unabhängig.

Der Ablauf im Einzelnen:

1. **Ordner wählen.** Er wird vollständig eingelesen (nur Kopfdaten,
   seitenweise) und nach Dubletten gruppiert.
2. **Schärfegrad.** Wie genau müssen zwei Mails übereinstimmen, damit sie als
   Dublette gelten? Jeder Ordner beginnt beim **sichersten** Grad; erst wenn
   dort nichts gefunden wird, geht es automatisch eine Stufe weiter — sichtbar
   protokolliert („Übersprungen, weil dort nichts gefunden wurde: streng"). Von
   Hand wechseln geht über den Knopf *Schärfegrad* in Schritt 3 oder per
   Rechtsklick auf die Übersicht.

   | Schärfegrad | Zwei Mails gelten als dieselbe, wenn … |
   |---|---|
   | **streng** (Start) | die `Message-ID` gleich ist — zweifelsfrei dieselbe Nachricht |
   | **normal** | `Message-ID`, sonst Absender + Betreff + dieselbe Minute |
   | **locker** | Absender + Betreff + derselbe Tag — findet auch neu zugestellte Kopien |

   Jede gefundene Gruppe trägt eine farbige Marke, **woran** sie erkannt wurde
   — auch im Leuchttisch. Im Grad *normal* können einzelne Gruppen trotzdem
   über die Message-ID gefunden worden sein; die tragen dann die grüne Marke
   *streng*, weil der Fund sicherer ist als der eingestellte Grad verspricht.

3. **Übersicht lesen (Schritt 3).** „1.482 Nachrichten · 1.190 eindeutige · 214
   Gruppen mit Dubletten (506 Kopien, 292 entfernbar)". Aufgeführt sind hier nur
   die Gruppen, die noch Arbeit machen: unentschiedene und die, die auf *später
   nochmal prüfen* liegen. Gestartet wird über den Knopf ganz oben.
4. **Durchgang.** Der Leuchttisch zeigt die erste Gruppe. Unten gibt es genau
   vier Möglichkeiten:

   - **Zusammenfassen vormerken**
   - **Löschen vormerken**
   - **Später nochmal prüfen**
   - **Weiter →** (ohne Vormerkung)

   Jede Entscheidung springt zur nächsten Gruppe. **Verändert wird dabei
   nichts** — es entstehen nur Vormerkungen, die auch einen Neustart
   überleben (`storage.local`).

5. **Abschluss (Schritt 4).** Vorgemerkte Gruppen verschwinden aus der
   Übersicht und sammeln sich unten unter **Vormerkungen**, getrennt nach
   *Zusammenfassen (n)* und *Löschen (n)*. Jede Gruppe lässt sich per „ansehen"
   nochmal öffnen. Erst die Knöpfe
   **„n Sätze jetzt zusammenfassen"** und **„n Sätze jetzt bereinigen"** führen etwas aus — mit einer Rückfrage, die im Klartext sagt,
   was passiert. *Später prüfen* und *Ohne Vormerkung* bleiben unberührt.
   Während der Ausführung liegt ein Fortschrittsfenster über der Seite:
   Balken, Zähler, der gerade bearbeitete Betreff, verstrichene Zeit und eine
   Schätzung, wie lange es noch dauert. *Abbrechen* wirkt nach dem laufenden
   Satz — angefangene Arbeit wird nie halb liegen gelassen, der Rest bleibt
   vorgemerkt.

Zusammengefasst wird dabei über denselben Baustein (`lib/rebuild.js`), den auch
der Leuchttisch benutzt: gleiche Vorauswahl, gleiche MIME-Struktur, gleiches
Ergebnis — „im Stapel" kann nichts anderes herauskommen als „von Hand
bestätigt".

### Der zuverlässige Weg (statt Kriterien-Raten)

Klassische Duplikat-Werkzeuge lassen dich Vergleichskriterien ankreuzen —
Absender, Betreff, Zeilenzahl, Größe, Versandzeit — und jede Kombination ist
ein Kompromiss: zu streng findet nichts, zu locker löscht Falsches. Genau
deshalb arbeitet diese Erweiterung **zweistufig**, ohne dass du Kriterien
abwägen musst:

1. **Grob gruppieren** (billig, nur Kopfdaten): findet *Kandidaten*. Hier darf
   der Maßstab ruhig locker sein — es wird ja noch nichts gelöscht.
2. **Inhalte prüfen** (pro Gruppe, ein Klick): lädt die Rümpfe und bildet eine
   **Inhalts-Prüfsumme** aus dem normalisierten Text plus Größe und Typ jedes
   Anhangs. Bewusst *nicht* eingerechnet: Empfänger-Zeile, Dateinamen,
   Zeitstempel, Reihenfolge der Kopfzeilen, Leerraum — also genau die Dinge,
   die bei deinen Fragmenten abweichen. Wer nicht dieselbe Prüfsumme hat,
   fliegt aus der Gruppe.

### Steuer- und Sonderzeichen im Text

Kommt häufig vor und ist genau deshalb eingeplant: Gateways streuen
Zero-Width-Zeichen ein, Konverter setzen geschützte Leerzeichen statt
normaler, Exporte lassen C0-Steuerzeichen oder Quoted-Printable-Reste (`=20`,
weiche `=`-Umbrüche) stehen, manche Systeme legen Trennlinien-Rahmen um den
Text. Zwei Kopien derselben Mail hätten dadurch **verschiedene** Prüfsummen
und würden nie zueinander finden.

Deshalb läuft jeder Vergleich über `lib/textclean.js`: C0/C1-Steuerzeichen,
Zero-Width-Zeichen, Bidi-Marken, bedingte Trennstriche, Ersatzzeichen (`�`),
Quoted-Printable-Reste und Rahmenzeilen fliegen **vor** dem Vergleich raus;
geschützte Leerzeichen werden zu normalen. Der Leuchttisch meldet oben, in
welcher Kopie wie viel davon steckte — und der neu gebaute Text ist die
gesäuberte Fassung.

Bleibt der Text trotzdem unbrauchbar (kaputte Kodierung), greift die zweite
Stufe: ein **Fakten-Fingerabdruck** aus Beträgen, IBAN, Belegnummern und Daten
plus Größe/Typ der Anhänge. Eine Kopie, deren Text auseinanderläuft, findet
darüber zu ihren Geschwistern zurück.

Erst danach ist „das ist wirklich dieselbe Nachricht“ eine belastbare Aussage
— und zwar unabhängig davon, ob die Kopie einen Empfängernamen hatte oder wie
ihr Anhang hieß. Eine geprüfte Gruppe trägt die Marke *Inhalt identisch
(geprüft)*; ungeprüfte sagen das ebenso deutlich.

**Empfohlene Reihenfolge bei vielen Duplikaten:** erst Duplikate löschen,
dann die verbliebenen Kopien korrigieren — sonst korrigierst du Mails, die
danach ohnehin wegfallen. Wo es Fragmente sind (Anhänge in der einen Kopie,
sauberer Empfänger in der anderen), statt „löschen“ lieber
**zusammenführen** — das erledigt beides in einem Schritt.

> Vorsicht beim Modus **locker**: Er gruppiert allein über Absender, Betreff
> und Tag. Zwei echte, verschiedene Mails desselben Absenders mit gleichem
> Betreff am selben Tag (etwa zwei Belege einer Serie) landen dann in einer
> Gruppe. Vor dem Löschen die Gruppen durchsehen — und zunächst in den
> Papierkorb löschen, nicht endgültig.

## Tests

```bash
npm test      # node:test, keine Abhängigkeiten
```

150 Tests decken Header-Kodierung, das Byte-genaue Umschreiben der
Roh-Nachricht, die Empfängerprüfung samt Vorschlägen, die
Dateinamen-Plausibilität, den Textvergleich sowie Gruppierung und
Kopie-Bewertung der Duplikatsuche, die MIME-Teil-Umbenennung und den
Zusammenführungs-Plan, die Zeichen-Säuberung, das Kandidaten-Modell und den
Neubau vollständiger Nachrichten sowie das Dekodieren und Hashen von
Anhängen ab (inklusive eines Laufs über 10.000 Kopfdatensätze und des Falls
„10 Kopien × 5 Anhänge → 5 Einträge") sowie das Aufbereiten einer echten
Word-Mail (Testdaten anonymisiert) sowie das Ergänzen fehlender
Inline-Bilder, den Neubau mit `multipart/related` und die Anhang-Erkennung in
einer echten Outlook-Nachricht (Anhänge mit Content-ID, gefaltete
RFC-2047-Dateinamen, verwaistes cid-Bild). Vier davon sind
**Integrationstests**: Sie fahren den echten Weg über eine Attrappe der
Thunderbird-API (`test/helpers/fakeMessenger.js`) — genau dort steckten die
Fehler, die den Einzelteil-Tests entgangen sind.

## Aufbau

| Datei | Zweck |
|---|---|
| `manifest.json` | MV2-Manifest, Thunderbird 128+ |
| `background.js` | Einstiegspunkte, merkt sich die Auswahl |
| `lib/mime.js` | RFC 2047/5322: Adressen parsen, kodieren, formatieren |
| `lib/rawmail.js` | Header im Byte-Strom lesen/ersetzen/falten |
| `lib/recipients.js` | Profile, Empfängerprüfung, Korrekturvorschläge |
| `lib/attachments.js` | Anhang- und Dateinamen-Plausibilität |
| `lib/attachcontent.js` | Inhalts-Hash, Typ-Erkennung aus Bytes, Vorschau-Eignung |
| `lib/addressbook.js` | alle Namen/Adressen eines Ordners, Schreibweisen, Profile daraus |
| `lib/review.js` | Vormerkungen des Durchgangs, Übersichtszahlen, Klartext-Plan |
| `lib/rebuild.js` | gemeinsamer Neubau für Leuchttisch und Stapel |
| `lib/dedupe.js` | Duplikat-Gruppen, Inhalts-Prüfsumme, Bewertung „welche Kopie bleibt“ |
| `lib/mimeparts.js` | MIME-Teile begehen, herausschneiden, Dateinamen setzen |
| `lib/textclean.js` | Steuer-/Sonderzeichen erkennen und entfernen |
| `lib/htmlmail.js` | Word-HTML aufräumen, Verlauf trennen, Lesedokument bauen |
| `lib/inlineparts.js` | eingebettete Bilder über alle Kopien sammeln und Lücken füllen |
| `lib/candidates.js` | Leuchttisch-Modell: Varianten je Bestandteil, Vorauswahl |
| `lib/assemble.js` | neue RFC-5322/MIME-Nachricht aus gewählten Teilen bauen |
| `lib/merge.js` | Zusammenführungs-Plan: Grundlage, beste Empfänger, Umbenennungen |
| `lib/similarity.js` | Textnormalisierung, Ähnlichkeit, Faktenabgleich |
| `lib/messageStore.js` | Thunderbird-APIs (lesen, importieren, löschen) |
| `ui/lighttable.js` | Leuchttisch-Oberfläche |
| `ui/tool.*` | Oberfläche (Design-Tokens nach SupaDupa-Design-Guide) |

Die `lib/`-Module sind frei von Browser- und Thunderbird-APIs — deshalb sind
sie einzeln testbar und ließen sich unverändert in eine andere Erweiterung
übernehmen (etwa als Ergänzung zu
[removedupes](https://github.com/eyalroz/removedupes)). Beide Erweiterungen
lassen sich parallel betreiben: removedupes findet Duplikate, diese hier
entscheidet zusätzlich, **welche** Kopie die bessere ist, und repariert die
Empfänger-Zeile.
