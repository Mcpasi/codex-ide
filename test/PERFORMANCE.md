# Streaming- und Editor-Performance

```bash
npm run test:performance
```

Der Befehl führt die Performance-Regressionstests aus und gibt die Messwerte als JSON aus.
Dieselben Tests laufen mit `npm test` und damit auch im Release-Check. Für
Messwerte bei einem normalen Testlauf kann `CODEX_IDE_PERF_REPORT=1` gesetzt
werden. Es sind keine Anmeldung, Modellaufrufe oder externen Dienste nötig.

Die bestehenden Browsertests verwenden echten Headless-Chromium mit dem HTML, CSS und
Syntaxrenderer der Anwendung. Sie werden ohne installierten Browser
übersprungen; die Tests ohne Browser laufen weiterhin. Einen Browserlauf
verbindlich machen (ein ungültiger expliziter Pfad schlägt fehl):

```bash
CODEX_IDE_TEST_BROWSER=/usr/bin/chromium npm run test:performance
```

## Wachsender Agent-Verlauf und native Browserframes

Die bisherigen beschleunigten Editor-Dauertests rufen einzelne Editorfunktionen
auf. Sie enthalten keinen wachsenden Verlauf eines vollständigen Agent-Turns.
`performance-agent-activity.test.js` ergänzt deshalb 512 Werkzeugaktivitäten
mit jeweils Start und Abschluss. Alle Ergebnisse bleiben vorhanden. Die
Attributänderungen werden in vier gleich großen Fenstern gezählt: Die Arbeit
an den Karten darf mit dem bisherigen Verlauf nicht zunehmen. Dieser kleine
Test läuft automatisch und startet keinen Browser.

Mit `CODEX_IDE_PERF_REPORT=1` berichtet dieser Test zusätzlich die Laufzeit pro
Fenster. `CODEX_IDE_PERF_EDITOR_SOURCE=/pfad/vorher.js` lädt eine zuvor gesicherte
Editorquelle in dieselbe Node-Fixture, um den Regressionstest ohne Browserlast
gegen den ursprünglichen Code zu prüfen. Ein fehlschlagendes Budget ist beim
Vorherlauf beabsichtigt; für den korrigierten Stand die Variable weglassen.

Der zusätzliche Browser-Benchmark durchläuft `runAgent` und dessen echte
Callbacks: mehrteilige Denkschritte, Skills, Werkzeuge, sichtbare Änderungen an
einer JavaScript-Datei mit Unicode, Prüfungsausgaben sowie verworfene Entwürfe.
Er speichert jede Änderung erst nach Syntax- und Präsentationsframe, prüft die
Editor-Workspace-Rechte und stellt am Ende alle Karten aus dem Sitzungsspeicher
wieder her. Nur Modellantworten und Datei-Endpunkt sind simuliert; es werden
keine Modelle, Anmeldedaten oder Projektdateien verwendet.

Ein schonender Standardlauf dauert eine Minute und enthält 24 Änderungen:

```bash
npm run test:performance:agent -- --output /tmp/codex-ide-agent.json
```

Der Langzeitlauf dauert echte 15 Minuten. Er enthält 180 Änderungen im Abstand
von fünf Sekunden, 15 Entwurfsabbrüche und 735 vollständig erhaltene Karten.
Messfenster werden nach jeweils zwölf Änderungen abgeschlossen:

```bash
npm run test:performance:agent:soak -- --output /tmp/codex-ide-agent-soak.json
```

Diese Läufe seriell ausführen, ohne weitere Browsertests parallel zu starten.
Der Runner erlaubt nur einen eigenen Browser-Benchmark gleichzeitig. Er senkt
die Prozesspriorität, begrenzt den Renderer-Heap auf 96 MiB und den Node-Heap
auf 128 MiB. Unter Linux überwacht er alle 500 ms den gesamten Browserprozessbaum:
über 384 MiB summiertem RSS oder unter 768 MiB verfügbarem Systemspeicher wird
der Lauf abgebrochen. Auf anderen Plattformen wird der verfügbare Systemspeicher
überwacht; die Prozessbaum-RSS-Messung ist Linux-spezifisch. Zeitlimit, Signal-
und Fehlerpfade beenden die eigene Prozessgruppe einschließlich Renderer und
Hilfsprozessen. Ein Ressourcenabbruch ist kein bestandener Performance-Test;
der Bericht enthält `status: "aborted"` und der Prozess endet mit Fehlerstatus.
Diese Grenzen betreffen ausschließlich die Testfixture und beschränken keine
Produktfunktion oder Historie der Anwendung.

`performance-agent-session-browser.test.js` ist ausdrücklich opt-in, damit ein
normaler Testlauf keinen zusätzlichen nativen Dauerlauf startet:

```bash
CODEX_IDE_AGENT_BROWSER_BENCHMARK=1 npm test -- test/performance-agent-session-browser.test.js
```

Der Bericht enthält native `requestAnimationFrame`-Abstände, gesonderte
Frame-Abstände während aktiver Editorarbeit, Callback-Zeiten, sichtbare
Bearbeitungsdauer, Long Tasks, DOM-Mutationen, Heap, Prozessbaum-RSS und
verfügbaren Systemspeicher. Die gesonderten aktiven Frames verhindern, dass
Wartepausen zwischen Aktionen stockende Bearbeitung verdecken. Es gibt keine
beschleunigte Uhr und keine erzwungene GC. Das sind Headless-Browsermessungen,
keine Messung der physischen Bildschirm-Bildrate. SHA-256 von Editor-JavaScript
und CSS sowie Node-/Browserversion machen den verwendeten Stand überprüfbar.

Budgets: unveränderte abgeschlossene Karten bleiben unberührt; maximal 180
DOM-Mutationen je Aktion in jedem Fenster; letzte p95-Ereigniszeit unter 25 ms
und höchstens `3 × erste p95 + 5 ms`; letzte p95-Framezeit höchstens
`max(50 ms, 2 × erste p95)`, aktive Frames höchstens
`max(75 ms, 2 × erste aktive p95)`; letzte p95-Bearbeitungszeit höchstens
`2 × erste p95 + 100 ms`. Ressourcenlimits und vollständige Inhalte werden
zusätzlich geprüft. Unterschiede der bewussten Tippanimation werden dadurch
nicht als reine CPU-Zeit ausgegeben.

Für einen Vorhervergleich lassen sich zuvor gesicherte, unveränderte Quellen
über `--source /pfad/codex-ide.js --styles /pfad/codex-ide.css` an dieselbe
Fixture übergeben. Alle übrigen Parameter müssen dabei identisch bleiben.

Ein großer Verlauf lässt sich außerdem vorladen, ohne hunderte Editoranimationen
abzuspielen. So beginnt die kurze Reproduktion bereits mit 686 abgeschlossenen
Karten und prüft anschließend 24 echte sichtbare Änderungen, zwei verworfene
Entwürfe und die Wiederherstellung aller 784 Karten:

```bash
npm run test:performance:agent -- --duration-ms 0 --cycles 24 --checkpoint-cycles 12 --preload-cycles 168 --output /tmp/codex-ide-agent-late.json
```

Die vorgeladenen Schritte werden über dieselben Agent-Callbacks angezeigt;
sie zählen nicht als Editor-Speicherungen. Ihre Aufbaukosten werden aus den
Messfenstern entfernt. Für vergleichbare Fenster sollten die Intervalle
Vielfache von zwölf Aktionen sein, damit jedes Fenster dieselbe Zahl von
Konsolen- und Abbruchfällen enthält. `--cpu-profile /tmp/editor.cpuprofile`
erlaubt zusätzlich CPU-Sampling; dieses ist auf kurze Läufe bis 60 Sekunden
begrenzt und verändert die Laufzeit gegenüber einer uninstrumentierten Messung.

Nachgewiesene Ursachen: Jede neue Aktivität aktualisierte alle bisherigen
Karten erneut. Die Scrollnachführung las vor und nach jedem Stream-Ereignis
Layoutmaße und erzwang dadurch wiederholt das Layout des wachsenden Chats.
Jetzt wird nur die betroffene Karte aktualisiert, unveränderte Felder bleiben
unangetastet und die Nachführung wird pro Frame gebündelt. CSS-Containment
isoliert die Scrollbereiche vom Editorlayout; offscreen liegende Karten
behalten ihren Inhalt und werden beim Zurückscrollen wieder dargestellt.
Sprachwechsel, Abschluss-/Fehlerzustände, manuelles Scrollen, Aufklappen und
Sitzungswiederherstellung bleiben geprüft.

Die Cursorvermessung hält einen einzigen unsichtbaren, isolierten Messbereich
mit der aktuellen Zeile. Identischer Text und identische Schriftparameter
verwenden dieselbe Geometrie; Schrift-, Tab-, Zeilen- und Font-Ladeänderungen
invalidieren sie. Dadurch entfallen wiederholtes Erzeugen/Entfernen des
Mess-DOMs und doppelte Layoutmessungen vor und nach demselben Syntaxframe.
Status-, Pfad- und Syntaxanzeigen werden bei unverändertem Wert ebenfalls nicht
erneut geschrieben. Die Scrollsuite prüft die echten Glyphpositionen auch
nach einem Schrift-/Tabwechsel in derselben Sitzung.

## Nachprüfbare Reproduktion vom 13. November 2026

Der ursprüngliche Stand ist `ffc251b48bcecca153ce66ab8b588f6221184db9`.
Bei identischen 512 Aktivitäten steigen seine Attributänderungen pro Fenster
mit je 128 Aktivitäten von 16.640 über 49.408 und 82.176 auf 114.944. Der
korrigierte Stand benötigt viermal genau 384 Änderungen. Alle 512 Ergebnisse
bleiben erhalten; der Vorherlauf verletzt gezielt das neue Budget.
Die Messdaten einschließlich CPU-Zeiten stehen in
[`benchmarks/agent-activity-comparison.json`](benchmarks/agent-activity-comparison.json).

Die kleine native Browser-Reproduktion mit 24 sichtbaren Speicherungen,
zwei Abbrüchen und 98 erhaltenen Karten wurde ebenfalls gegen beide Stände
ausgeführt. Der ursprüngliche Code verletzt die Budgets für unveränderte
Karten, Ereigniszeit und wachsende DOM-Arbeit; der korrigierte Stand besteht.
Die vollständigen, einschließlich schwankender Framezeiten unveränderten
Berichte liegen unter
[`benchmarks/agent-session-original.json`](benchmarks/agent-session-original.json)
und [`benchmarks/agent-session-fixed-short.json`](benchmarks/agent-session-fixed-short.json).
Diese Daten sind keine Garantie für eine feste Bildrate: Systemlast und die
bewusst niedrige Priorität des Testbrowsers beeinflussen die nativen Framezeiten.
Die funktionalen Prüfungen und DOM-Budgets hängen davon nicht ab.

Der abschließende echte 15-Minuten-Lauf des korrigierten Stands bestand alle
Budgets: 180 sichtbare Speicherungen, 15 verworfene Entwürfe, 735 vollständig
erhaltene und aus dem Sitzungsspeicher wiederhergestellte Aktivitäten. Vergleich
des ersten und letzten gleich großen Fensters mit jeweils zwölf Aktionen:

| Messung | Erstes Fenster | Letztes Fenster |
| --- | ---: | ---: |
| p95 Agent-Ereignis | 4,8 ms | 2,1 ms |
| p95 aktive Editor-Frameabstände | 183,2 ms | 216,7 ms |
| p95 vollständige sichtbare Bearbeitung | 797,6 ms | 554,4 ms |
| Aktivitäts-DOM-Mutationen | 603 | 601 |
| JavaScript-Heap ohne erzwungene GC | 1,83 MB | 1,97 MB |

Der gesamte Browserprozessbaum erreichte maximal 265 MiB RSS; mindestens
1.323 MiB Systemspeicher blieben verfügbar. Die aktiven Frames schwanken auf
diesem Rechner deutlich und erlauben keine Aussage über eine feste physische
Bildrate. Ihre p95 blieb im unveränderten Verhältnisbudget, während die
Ereignis- und DOM-Arbeit über den wachsenden Verlauf begrenzt blieb. Alle
15 Fenster, Ressourcenwerte, Quelltext-Hashes und Versionen stehen unverändert
in [`benchmarks/agent-session-fixed-soak.json`](benchmarks/agent-session-fixed-soak.json).

## Messungen und Budgets

| Test | Last und geprüftes Budget |
| --- | --- |
| Editor-JSON | 32.768 und 131.072 Inhaltszeichen, Vorschau alle 64 JSON-Zeichen; großer Fall unter 750 ms, bei vierfacher Eingabe weniger als `8 × kleine Laufzeit + 20 ms` |
| Fragmentiertes SSE | 420.064 UTF-8-Bytes eines großen Events in 31-Byte-Netzwerkstücken; unter 750 ms, vollständiger Unicode-Inhalt und genau ein Token-Callback |
| Planer → Editor | Echter Browser-Backendpfad mit 87.000 Inhaltszeichen und 1.502 Token-Events, anschließend Editorübergabe, Audit und Finalantwort; erste Vorschau unter 250 ms, Verarbeitung insgesamt unter 1.000 ms |
| Persistenter App Server | Zehn simulierte Turns; Tokens kommen vor Turn-Ende, nur ein Prozess, eine Initialisierung und ein Thread-Start, keine erneute Thread-Wiederaufnahme; alle Starts und Turns behalten die Live-Editor-Berechtigungen |
| Persistente Antigravity CLI | Zehn simulierte Planer-/Audit-/Folgeschritte in weniger als 1.000 ms; genau ein Prozess trotz wechselnder Audit-Anforderungen, NDJSON-Streaming und keine doppelte finale Ausgabe |
| Sichtbare Bearbeitung | 16 Zeichen je simuliertem Token im Abstand von 17 ms; erste Syntaxanzeige spätestens nach 119 ms, vollständige kleine Datei mit Speicherung unter 650 ms; kein Schreiben vor der letzten sichtbaren Syntaxanzeige |
| Fünf Speicherungen | Fünf kleine Dateien in verschachtelten Ordnern; keine vollständige Workspace-Abfrage pro Speicherung, Dateibaum und Elternordner sofort aktuell; unter 1.800 ms simulierter Zeit |
| Große Datei im Dauereinsatz | 120 gespeicherte Änderungen einer Datei mit 112.020 UTF-16-Codeeinheiten, dazu 30 abgebrochene Entwürfe mit je 30 Streaming-Schüben; höchstens zwei ausstehende Timer, nach jeder Aktion keine Timer/Entwürfe, genau ein Puffer und ein Dateicache; vier Fenster à 30 Änderungen unter je 5.000 ms, letztes Fenster unter `4 × erstes Fenster + 250 ms` |
| Unveränderte Syntax | 5.000 Aktualisierungsanforderungen in 100 Frames; genau ein geplanter Callback pro Frame und keine erneute Tokenisierung; Inhalt, Pfad/Sprache und gewechselter Highlighter lösen weiter eine Aktualisierung aus |
| Chromium-Dauersitzung und Animation | 100 gespeicherte Änderungen einer Datei mit 2.170 UTF-16-Codeeinheiten, 20 Abbrüche während ausstehender Syntax-Paints, anschließend Schreiben und vollständiges Löschen von 4.030 Codeeinheiten mit Emoji; über 500 Syntax-Callbacks, p95 unter 100 ms, summierte Scheduler-Arbeit unter 25.000 ms; Schreib-/Löschanimation unter 5.000 ms simulierter Zeit |
| Syntax-Äquivalenz im Browser | Acht Fälle für JavaScript, Python, HTML mit CSS/JS, CSS, JSON, Markdown und Text; inkrementelle Darstellung entspricht nach jeder Änderung dem vollständigen Syntaxrendering, einschließlich mehrzeiliger Zustandswechsel, leerer Puffer und Sprachwechsel |

Die CPU-Zeiten verwenden `performance.now()`. Der Editor verwendet die
kontrollierte Jest-Uhr, damit Netzwerkpausen und Animationsintervalle
reproduzierbar sind. Die Dateilisten-Gegenstelle benötigt im letzten Test
absichtlich 250 ms: Eine unnötige Abfrage würde jede der fünf Aktionen bremsen.
Für den Skalierungstest wird nach einem Warm-up jeweils der kleinere von zwei
Durchläufen ausgewertet. Die Budgets lassen Spielraum für geteilte CI-Rechner;
sie sind Testgrenzen und führen keine Laufzeitlimits in die Anwendung ein.

`performance-editor.test.js` prüft den großen Dauereinsatz in der Node-VM.
`performance-editor-browser.test.js` misst zusätzlich reales DOM, Schriftlayout
und Syntaxrendering. Die Browser-Animationsuhr wird kontrolliert vorgerückt;
`performance.now()` misst die tatsächlich benötigte Verarbeitungszeit.
Median, p95, Maximum und die Zahl der Callbacks über 16,7 ms erscheinen im
JSON-Bericht. Das sind Callback-Kosten, keine gemessene Bildschirm-Bildrate.
Unveränderte Syntaxknoten müssen bei lokalen Änderungen erhalten bleiben.

Im Browser-Dauerlauf wird nach 20, 40, 60, 80 und 100 Änderungen eine volle
Test-Garbage-Collection ausgelöst. Chromium läuft dafür mit
`--js-flags=--expose-gc` und `--enable-precise-memory-info`. Der verbleibende
JavaScript-Heap darf gegenüber dem ersten Messpunkt höchstens 2 MiB wachsen.
Zusätzlich bleiben DOM-Elementbestand, genau ein offener Puffer und ein
Dateicache konstant; Timer, Paints und Live-Entwürfe müssen nach jeder Aktion
abgebaut sein. Abbrüche dürfen weder Dateien speichern noch Entwurfspuffer
zurücklassen. Der Speicher-Stub kontrolliert bei jeder Speicherung den sichtbaren
Quelltext und den abgeschlossenen Präsentationsframe.

Die Messung beschleunigt wiederholte Aktionen, simuliert aber keine Stunden
Wartezeit. Heapwerte nach GC erfassen behaltene JavaScript-Daten; Prozess-RSS,
GPU-Speicher und der kurzfristige native Layout-Speicher werden nicht erfasst.
Das zusätzlich berichtete Textvolumen der temporären Cursor-Mess-DOMs ist
ein Arbeits-/Allokationsindikator in Codeeinheiten, keine Byte-Messung des Heaps.

## Vergleich vor und nach der Optimierung

Lokaler Lauf vom 11. November 2026, Node.js v24.22.2. Identische Testdaten und
derselbe Rechner; die Werte sind gerundet und hängen von der Maschine ab.

| Messung | Vorher | Nachher |
| --- | ---: | ---: |
| Editor-JSON, 131.072 Inhaltszeichen | 6.532 ms | 30 ms |
| Laufzeitfaktor bei vierfacher JSON-Eingabe | 16,8 × | 3,7 × |
| Fragmentiertes SSE | 5.135 ms | 130 ms |
| Fünf Speicherungen, simulierte Zeit | 2.775 ms | 1.525 ms |
| Vollständige Workspace-Abfragen für diese Speicherungen | 5 | 0 |

Die erste sichtbare Syntaxanzeige blieb im kontrollierten Streaming-Test bei
85 ms, die Speicherung bei 560 ms. Die Optimierung beschleunigt die Verarbeitung
und entfernt Wartezeiten zwischen Aktionen; sie überspringt keine sichtbaren
Zeichen oder Präsentationsframes. Der zusätzliche Planer-Test benötigte nachher
171 ms, davon 7 ms bis zur ersten Vorschau. Für diesen zusätzlichen Test wurde
kein Vorherwert erhoben.

Das sind lokale Verarbeitungs- und Ablaufmessungen mit simuliertem Codex.
Sie messen weder die echte Modellantwortzeit noch Netzwerklatenz zu OpenAI.
Browserdarstellung und Scrollpositionen prüft ergänzend die bestehende echte
Chromium-Suite `editor-scroll-browser.test.js`.

## Ursachen und Änderungen

- Editor-JSON wurde bei jedem Token vollständig erneut dekodiert. Ein Cache pro
  Modellantwort merkt sich Feldpositionen und den Dekodierfortschritt. Geteilte
  Escapes und Surrogatpaare bleiben bis zu ihrer Vervollständigung zurückgehalten.
  Unvollständige Edit-Objekte werden nicht bei jedem Token erneut geparst.
- Die SSE-Trennersuche durchlief bei jedem Netzwerkstück das gesamte noch offene
  Event. Sie untersucht jetzt nur das neue Stück und höchstens drei zuvor
  empfangene Zeichen; Eventteile werden einmal beim vollständigen Event verbunden.
- Nach jeder bestätigten Speicherung wartete der Editor auf eine vollständige
  Workspace-Liste. Er aktualisiert jetzt den bestätigten Dateieintrag und seine
  Elternordner direkt. Manuelles Aktualisieren und der Abgleich nach dem Turn
  bleiben erhalten.

Projektdateien werden weiterhin ausschließlich nach der sichtbaren Bearbeitung
gespeichert. Der App Server behält seine nativen Read-only-Rechte; das
Workspace-Werkzeug bleibt auf Lesen und Auflisten begrenzt. Prüfkommandos laufen
weiter in der isolierten Wegwerfkopie. Die vorhandenen Abbruch-, Pfad-,
Symlink- und Schreibschutztests gehören zur vollständigen Suite. Zusätzlich
prüft `editor-stream.test.js` mehrere echte Planerantworten über fragmentiertes
SSE, den sichtbaren Editor, die Persistenz in temporäre Dateien und den
Vollständigkeits-Audit in einem zusammenhängenden Ablauf.

Der Planer-Test und die verzögerten Editor-Streaming-Reproduktionen laufen fuer Codex und Antigravity. `antigravity.test.js` prueft zusaetzlich einen grossen NDJSON-Datensatz mit byteweise fragmentiertem UTF-8 (Budget 3.000 ms). `antigravity-gateway.test.js` verbindet den echten Provideradapter, HTTP/SSE, Editorframes und temporaere Dateien. Dabei bleibt nur der CLI-Prozess simuliert; Auth und Modellantwortzeit sind kein Bestandteil der deterministischen Budgets.

## Editor-Dauerlauf und Renderoptimierung vom 12. November 2026

Lokaler Vergleich mit Node.js v24.22.2 und Chromium 156.0.8078.79 unter Linux.
Der ursprüngliche Editor wurde für den Vergleich nur mit `git show` gelesen
und als Quelltext an dieselbe temporäre Browserfixture übergeben. Beide Läufe
verwenden dieselben 100 Änderungen, 20 Abbrüche und die abschließende
Schreib-/Löschanimation; gemessen wurden jeweils 1.911 Scheduler-Schritte und
1.022 Syntax-Callbacks. Werte eines einzelnen Vergleichspaars, gerundet:

| Messung | Vorher | Nachher |
| --- | ---: | ---: |
| Summierte Scheduler-Arbeit | 24.077 ms | 13.385 ms |
| p95 der Syntax-Callbacks | 24,2 ms | 13,5 ms |
| Syntax-Callbacks über 16,7 ms | 265 | 10 |
| Tokenisierungen bei 30 unveränderten Aktualisierungen | 30 | 0 |
| Tokenisierungen im gesamten Ablauf | 1.022 | 789 |
| Summiertes Textvolumen der Cursor-Mess-DOMs | 4.296.498 Codeeinheiten | 32.204 Codeeinheiten |
| Größter Cursor-Mess-DOM, Textlänge | 4.031 Codeeinheiten | 23 Codeeinheiten |
| Dauer der Schreib-/Löschanimation, simuliert | 2.384 ms | 2.384 ms |
| Heap nach GC, Messpunkte 20 bis 100 | 1,20–1,33 MB | 1,25–1,37 MB |

Die gemessene Verarbeitungszeit sinkt um rund 44 %. Die behaltenen Heapdaten
liegen in beiden Varianten in einem ähnlichen Bereich; dieser Lauf weist
keinen dauerhaften Speicherverlust nach. Die größten Einsparungen betreffen
temporäre Layoutarbeit und Textvolumen. DOM-Elementbestand, Puffer, Dateicache
und ausstehende Timer bleiben in beiden Läufen konstant.

Die drei gezielten Änderungen:

- Unveränderte Inhalte werden bei identischem Pfad und Highlighter nicht erneut
  tokenisiert. Ein einzelner Snapshot hält nur die aktuelle Quelle und
  Sprachmetadaten; Pfad-, Inhalts- und Highlighterwechsel invalidieren ihn.
  Scrollnachführung, Übersetzungen und Paint-Wartende werden weiterhin bedient.
- Nach vollständiger Tokenisierung werden identische DOM-Knoten am Anfang und
  Ende erhalten und nur die dazwischen veränderten Knoten ersetzt. Mehrzeilige
  Syntaxzustände werden weiter aus dem vollständigen Inhalt berechnet. Ein
  separater Browsertest vergleicht das Ergebnis mit einer kompletten
  Neudarstellung für alle sieben unterstützten Sprachen.
- Die Cursorvermessung formt nur die aktuelle ungebrochene Textzeile mit den
  echten Schrift-/Tab-Einstellungen. Frühere Zeilen liefern ihren festen
  vertikalen Abstand ohne zusätzliche DOM-Zeilen oder `split`-Arrays. Die
  Scrollsuite prüft zusätzlich Emoji in früheren Zeilen, Tabs, kombinierte
  Zeichen und CJK auf Desktop, Tablet, Mobilansicht und bei großer Schrift.

Unicode-Schritte, Lösch-/Einfügetempo, Abbruch und Wiederherstellung bleiben
erhalten. Jede Speicherung wartet weiter auf die vollständige sichtbare
Änderung und ihren Präsentationsframe. Agenten ändern Projektdateien weiterhin
über den Editor; native Read-only-Rechte und isolierte Prüfkommandos wurden
nicht verändert. Der vollständige Lauf bestand mit 712 Tests; Syntax- und
PWA-Prüfung bestanden ebenfalls.
