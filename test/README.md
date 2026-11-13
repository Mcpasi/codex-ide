# Testsuite

Die Tests liegen vollständig unter `test/` und verwenden das bereits im Projekt
vorgesehene Jest 29. Node.js ab 18.18.0 wird unterstützt.

## Installation und Start

Im Projektverzeichnis:

```bash
npm ci
npm test
```

`npm test` führt die Suite seriell aus. Auch der bestehende Befehl
`npm test -- --runInBand` funktioniert weiterhin.

## GitHub Actions

Der Workflow [Tests](../.github/workflows/tests.yml) läuft bei Pushes auf alle
Branches und bei Pull Requests unabhängig vom Zielbranch. Er verwendet
Ubuntu 24.04, Node.js 24 und `npm ci`. `npm run verify:release` prüft Syntax,
PWA, die gesamte Jest-Suite und das npm-Paket. Der Browserpfad wird ausdrücklich
auf den vorinstallierten Google Chrome gesetzt; auch der sonst optionale
Agent-Browsertest wird mit `CODEX_IDE_AGENT_BROWSER_BENCHMARK=1` aktiviert.
Alle Tests laufen seriell.

Sobald die Workflow-Datei im Standardbranch vorhanden ist, lässt sich unter
**Actions → Tests → Run workflow** auch ein anderer Branch auswählen.
Mit der Option `run_soak` läuft anschließend zusätzlich der 15-minütige
Agent-Browser-Dauertest. Das entspricht den
[GitHub-Vorgaben für manuelle Workflow-Starts](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatch).
Der Workflow benötigt keine Anmeldedaten für Modelle oder CLI-Backends und
hat ausschließlich lesende Repository-Berechtigungen.

## Einzelne Tests und Berichte

Einzelne Tests oder eine Datei ausführen:

```bash
npm test -- test/workspace.test.js
npm test -- --testNamePattern="symlink"
npm run test:coverage
npm run test:performance
npm run test:performance:agent -- --output /tmp/codex-ide-agent.json
```

Der Coverage-Bericht liegt anschließend unter `coverage/`. Die Browsermodule
werden isoliert in einer Node-VM ausgeführt; ihre Ausführung wird von der
standardmäßigen Jest-Instrumentierung nicht als Coverage erfasst.

## Abgedeckte Bereiche

| Datei | Geprüftes Verhalten |
| --- | --- |
| `performance.test.js` | Streaming-Skalierung, stark fragmentiertes SSE, Planer-/Editor-Übergabe, persistenter App Server, erste sichtbare Änderung und Speichern ohne Workspace-Rundreise; Messwerte und Budgets in [PERFORMANCE.md](PERFORMANCE.md) |
| `performance-editor.test.js` | 120 Änderungen einer großen Datei, Streaming-Schübe und 30 Abbrüche ohne wachsende Timer/Puffer; 5.000 unveränderte Aktualisierungen ohne erneute Tokenisierung |
| `performance-editor-browser.test.js` | Echter Chromium-Dauerlauf mit 100 Speicherungen und 20 Abbrüchen, Heap nach GC, DOM-/Pufferbestände und Callback-Zeiten; vollständige Unicode-Schreib-/Löschanimation und Syntax-Äquivalenz für alle sieben unterstützten Sprachen |
| `performance-agent-activity.test.js` | 512 vollständig erhaltene Werkzeugaktivitäten; begrenzte Aktualisierungsarbeit unabhängig von der Länge des Agent-Verlaufs, ohne Browser |
| `performance-agent-session-browser.test.js` | Opt-in: vollständiger Agent-Turn mit nativen Frames, wachsenden Denkschritten und Werkzeugkarten, sichtbaren Speicherungen, verworfenen Entwürfen, Konsole und Speicher-Roundtrip; geschützter Einzelbrowser |
| `benchmark-resources.test.js`, `chromium-session.test.js` | Prozessbaum-RSS, exklusiver Browserstart und Ressourcen-/Zeitabbruch mit vollständiger Prozessbereinigung; Tests verwenden simuliertes Chromium |
| `workspace-access.test.js` | Modell-Home-Reads, Live-Editor-Persistenz, interne Symlinks, Binaer-Reads, isolierte Pruefkonsole und grosse/tiefe Workspaces |
| `workspace-buffers.test.js` | Aktualisierung sauberer Puffer nach nativen Aenderungen und Erhalt ungespeicherter Eingaben |
| `workspace.test.js` | Lesen, Schreiben, Editieren, Verzeichnislisten, Pfadschutz, geschützte Dateien, Symlinks und PDF-Bytes |
| `gateway-http.test.js` | Echte HTTP-Routen, Host-/Origin-Prüfung, Berechtigungen, statische Dateien, Vorschau, Sessions, Chat und SSE |
| `editor-scroll.test.js` | Sofortige Nachfuehrung, lange Zeilen, grosse Schrift, verzoegertes Rendering, native Scrollleisten, Resize und Viewport nach Stop |
| `editor-scroll-browser.test.js` | Echte Chromium-Textpositionen in jedem Lösch-/Einfügeschritt, entfernte Arbeitsstellen, lange Zeilen, Speichern, mobile Ansichten und große Schrift |
| `live-editor.test.js` | Lokale Unterschiede in jedem Animationsschritt, alle Editor-Dateitypen, Einzeiler, Unicode, Abbruch, Viewport und Persistenz |
| `editor-typing.test.js` | Einzelne Tastendrücke und Rückschritte, gleichmäßiges Tempo großer Änderungen, Streaming-Schübe, verzögertes Rendering vor Persistenz, CRLF und sofortiger Abbruch |
| `editor-diff.test.js` | Getrennte Änderungen, unveränderter Kontext, große Dateien und deterministische Unicode-Eingaben |
| `editor-stream.test.js` | Späte replaceAll-/Zeilenhinweise, unvollständige Unicode-Escapes und Modell-Requests über den sichtbaren Editor bis zur echten Datei; verzögerte Mehrfachblöcke ohne Schließen oder Neuschreiben vor dem Speichern, auch mit Folgeturn |
| `editor-permissions.test.js` | Echtes EACCES aus einer schreibgeschuetzten npm-Installation, dauerhafter Nutzer-Workspace, sichere Datenuebernahme und manuelles/Codex-Speichern ueber HTTP nach sichtbarer Editoranimation |
| `model-home-platform.test.js` | Plattformpfade fuer Linux, Android/Termux, macOS und Windows mit POSIX-/Windows-Pfadregeln; Windows-Fallbacks, UNC-Pfade und Uebernahme von Verzeichnis-Junctions |
| `chat.test.js` | Sofortiger Nutzerbeitrag, freie Eingabe, Entwurfserhalt, Tastatur/IME, Editoraktionen, Kartenspeicherung, Migration, Neustart, Fehler und Abbruch |
| `chat-browser.test.js` | Echte Chromium-Darstellung von Chat, aufklappbaren Denk-/Toolkarten, Konsole, Verlauf, wachsender Eingabe und Scrollverhalten auf Desktop und schmalen Ansichten |
| `agent-activity.test.js` | Native Denkkarten ohne synthetische Duplikate, stabile DOM-Knoten und Aufklappzustände, Mehrteiligkeit, parallele Werkzeuge und Recovery-Identität |
| `app-server-client.test.js` | JSONL, Initialisierung, parallele Anfragen, Session-Wiederaufnahme, Abbruch, Timeouts, Werkzeugfreigaben und UTF-8 |
| `antigravity.test.js` | Offizielle Auth-Probe und Login, CLI-Modellformat, persistente NDJSON-Prozesse, fragmentiertes UTF-8, Sitzungswarteschlangen, Abbruch/Reset, Fehlerstatus und Workspace-/Editor-Dispatch |
| `antigravity-gateway.test.js` | Echter HTTP-/SSE-Weg vom simulierten CLI-Prozess ueber Workspace-Lesen und Wegwerf-Pruefkonsole bis zum sichtbaren Editor, echter Speicherung und Folgeturn; Host-/Origin-Schutz und unabhaengige Auth-/Modell-/Reset-Routen |
| `bridge-protocol.test.js` | Nachrichten, Prompts, Antwortformat, Limits, Memory und expliziter Dateikontext |
| `cli.test.js` | Argumente, Befehle und Aliase, Login, Health-Probe und Gateway-Konfiguration |
| `update.test.js` | Versionen, verifizierte Sicherungen, Symlink-Erhalt und Wiederherstellung nach Updatefehlern |
| `skill-package.test.js` | Manifeste, Rechteverweise, Einstiegspunkte, Symlinks und Paketexport |
| `backend-profile.test.js` | Browserprofile, API-Aufrufe, Konfiguration, Workspace-Vertrag und SSE-Dekodierung |
| `local-model.test.js` | Modellzustand, Tokenbudgets, veraltete Ladevorgänge, Abbruch und Ausgabefilter |
| `agent-response.test.js` | Antwort-/Zusammenfassungsblöcke, unvollständige Streams und interne Verweise |
| `safety-filter.test.js` | Wortgrenzen, Maskierung, eigene Begriffe und Modellfilter |
| `syntax-highlighter.test.js` | Spracherkennung, Escaping und unveränderte Quelltexte einschließlich Unicode |
| `service-worker.test.js` | PWA-Dateien, Shell-Cache, kontrollierte Updates und ungecachte Gateway-Routen |

Datei- und Updateoperationen verwenden ausschließlich temporäre Verzeichnisse
unter dem temporären Systempfad, die nach den Tests entfernt werden. Das echte
`model-home/` wird nicht verändert. Modelle, npm-Updates und Codex-Prozesse
werden simuliert; gezielte Konsolentests starten lokale Node-Prozesse in temporaeren Workspaces; die Suite benötigt weder Anmeldedaten noch
externe Dienste oder Modelldownloads. Auch Antigravity-CLI-Prozesse und deren Anmeldung werden simuliert. `editor-stream.test.js`, `editor-permissions.test.js` und der Planer-Performance-Test laufen mit Codex und Antigravity gegen dieselben sichtbaren Editor- und Speicherfunktionen. Die HTTP-Integrationstests öffnen kurz
einen zufällig vergebenen Port auf `127.0.0.1`; die Laufumgebung muss das erlauben.

Die Plattformtests verwenden `path.posix` und `path.win32` mit simulierten
Plattformwerten. Sie ersetzen keinen nativen Lauf auf Android, Windows oder
macOS. Die Junction-Migration wird mit der Windows-Policy auf dem Dateisystem
des Testhosts geprueft. Das echte Unix-EACCES wird unter Windows und bei Root
uebersprungen. Der Dateisymlink-Migrationstest wird unter Windows wegen der
zusaetzlichen Symlink-Rechte uebersprungen; Verzeichnislinks verwenden dort
Junctions.

Die Scroll- und Editor-Performance-Regressionen starten einen isolierten Headless-Chromium, wenn
`chromium`, `chromium-browser` oder `google-chrome` im PATH vorhanden ist.
Sie verwenden das echte HTML, CSS und Syntaxrendering; `Range`-Messungen prüfen
die Sichtbarkeit des bearbeiteten Textes in jedem Animationsschritt. Ohne
installierten Browser werden die jeweiligen Browsertests übersprungen. Für einen
verpflichtenden Lauf, etwa in CI, einen Browserpfad explizit setzen:

```bash
CODEX_IDE_TEST_BROWSER=/usr/bin/chromium npm test -- test/editor-scroll-browser.test.js
CODEX_IDE_TEST_BROWSER=/usr/bin/chromium npm run test:performance
```

Ein ungültiger expliziter Browserpfad lässt den Test fehlschlagen. Die Tests
verwenden keine echte Modellanmeldung und prüfen keine echten Modellantworten
oder plattformspezifischen Sandbox-/PTY-Prozesse.

Der neue native Agent-Benchmark läuft ausdrücklich separat und mit Ressourcen-
schutz. `npm run test:performance:agent` startet einen schonenden Ein-Minuten-Lauf;
`npm run test:performance:agent:soak` einen echten 15-Minuten-Lauf mit 180 Änderungen.
Nur einen Lauf gleichzeitig ausführen. Details, Speichergrenzen und Interpretation
der Frame-Messungen stehen in [PERFORMANCE.md](PERFORMANCE.md).

Der bestehende Release-Check bindet die Tests ein:

```bash
npm run verify:release
```

Neue Testdateien verwenden den Namen `test/**/*.test.js`. Wiederverwendbare
Testhelfer stehen unter `test/helpers/`.
