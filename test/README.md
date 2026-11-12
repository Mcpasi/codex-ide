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

Einzelne Tests oder eine Datei ausführen:

```bash
npm test -- test/workspace.test.js
npm test -- --testNamePattern="symlink"
npm run test:coverage
npm run test:performance
```

Der Coverage-Bericht liegt anschließend unter `coverage/`. Die Browsermodule
werden isoliert in einer Node-VM ausgeführt; ihre Ausführung wird von der
standardmäßigen Jest-Instrumentierung nicht als Coverage erfasst.

## Abgedeckte Bereiche

| Datei | Geprüftes Verhalten |
| --- | --- |
| `performance.test.js` | Streaming-Skalierung, stark fragmentiertes SSE, Planer-/Editor-Übergabe, persistenter App Server, erste sichtbare Änderung und Speichern ohne Workspace-Rundreise; Messwerte und Budgets in [PERFORMANCE.md](PERFORMANCE.md) |
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

Die Scroll-Regression startet einen isolierten Headless-Chromium, wenn
`chromium`, `chromium-browser` oder `google-chrome` im PATH vorhanden ist.
Sie verwendet das echte HTML, CSS und Syntaxrendering; `Range`-Messungen prüfen
die Sichtbarkeit des bearbeiteten Textes in jedem Animationsschritt. Ohne
installierten Browser wird nur diese Testdatei übersprungen. Für einen
verpflichtenden Lauf, etwa in CI, einen Browserpfad explizit setzen:

```bash
CODEX_IDE_TEST_BROWSER=/usr/bin/chromium npm test -- test/editor-scroll-browser.test.js
```

Ein ungültiger expliziter Browserpfad lässt den Test fehlschlagen. Die Tests
verwenden keine echte Modellanmeldung und prüfen keine echten Modellantworten
oder plattformspezifischen Sandbox-/PTY-Prozesse.

Der bestehende Release-Check bindet die Tests ein:

```bash
npm run verify:release
```

Neue Testdateien verwenden den Namen `test/**/*.test.js`. Wiederverwendbare
Testhelfer stehen unter `test/helpers/`.
