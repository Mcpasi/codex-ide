# Streaming- und Editor-Performance

```bash
npm run test:performance
```

Der Befehl führt acht Regressionstests aus und gibt die Messwerte als JSON aus.
Dieselben Tests laufen mit `npm test` und damit auch im Release-Check. Für
Messwerte bei einem normalen Testlauf kann `CODEX_IDE_PERF_REPORT=1` gesetzt
werden. Es sind keine Anmeldung, Modellaufrufe oder externen Dienste nötig.

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

Die CPU-Zeiten verwenden `performance.now()`. Der Editor verwendet die
kontrollierte Jest-Uhr, damit Netzwerkpausen und Animationsintervalle
reproduzierbar sind. Die Dateilisten-Gegenstelle benötigt im letzten Test
absichtlich 250 ms: Eine unnötige Abfrage würde jede der fünf Aktionen bremsen.
Für den Skalierungstest wird nach einem Warm-up jeweils der kleinere von zwei
Durchläufen ausgewertet. Die Budgets lassen Spielraum für geteilte CI-Rechner;
sie sind Testgrenzen und führen keine Laufzeitlimits in die Anwendung ein.

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
