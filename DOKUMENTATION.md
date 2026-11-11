# Codex IDE: Architektur und Betrieb

## Systemuebersicht

Codex IDE wird als eine einzige Browseranwendung ausgeliefert. `index.html` laedt direkt die IDE, ihre Einstellungen und die drei Backend-Adapter. Das lokale Gateway stellt die statische App-Shell, den Modell-Home-Zugriff und die Codex-App-Server-Bridge auf demselben Loopback-Ursprung bereit.

## Oberflaeche und Markenbild

Die Kopfzeile traegt die lokalisierte Leitzeile **Dein Agent bei der Arbeit — jede Aenderung live.** Die dunkle Oberflaeche verwendet Crimson und Koralle als Marken- und Interaktionsakzente; Erfolgs-, Lauf-, Warn- und Fehlerzustaende behalten zusaetzliche Texte, Symbole und unterscheidbare Statusfarben. Das dreispaltige Desktop-Layout wechselt bei 1050 Pixeln auf zwei Spalten und bei 700 Pixeln auf eine mobile Reihenfolge. Unter 420 Pixeln werden Wortmarke, Slogan und Metadaten nochmals kompakter dargestellt, ohne Editor- oder Agentenfunktionen auszublenden.

```text
Browser
  index.html
  codex_ide/codex-ide.js
  codex_ide/settings.js
  backendProfile.js
  skillSystem.js
        |
        | HTTP / SSE auf localhost
        v
Codex IDE Gateway
  statische Allowlist
  Modell-Home-Policy
  Codex App Server
        |
        v
model-home/
```

## Start- und Befehlsmodell

Jeder Projektbefehl beginnt mit der Codex-IDE-CLI:

```bash
codex-ide start
codex-ide gateway
codex-ide gateway --open
codex-ide clean
codex-ide version
codex-ide update
codex-ide update --yes
codex-ide codex login
codex-ide codex login --device-auth
codex-ide codex status
codex-ide skill validate <ordner>
codex-ide skill pack <ordner> [ausgabe.codexskill]
```

`start` kombiniert Gateway und Browserstart. `gateway` laesst den Browser geschlossen, sofern `--open` fehlt. `bridge`, `codex gateway` und `codex bridge` sind gleichwertige Gateway-Funktionswege im Codex-IDE-Namensraum. `codex signin`/`sign-in` sowie `codex login-device`/`device-login` bleiben als Auth-Aliase erhalten. Host und Port koennen mit `--host` und `--port` gesetzt werden; Standard sind `127.0.0.1:8787`.

Die offizielle Anmeldung erfolgt auf einem Desktop mit `codex-ide codex login`, auf Termux/headless mit `codex-ide codex login --device-auth`. Der Einstellungsdialog zeigt diese Befehle kopierbar an. Seine Usage-Anzeige liest ueber `/codex/usage` die App-Server-Methode `account/rateLimits/read` und zeigt das verbleibende Tages-/Kurzzeit- sowie Wochenkontingent in zwei blauen Prozentbalken. Bei hoechstens 20 Prozent wird ein Balken rot und zugleich textlich als niedrig gekennzeichnet; ein von Codex nicht gelieferter Zeitraum bleibt sichtbar als nicht verfuegbar. Auth-Dateien und Tokens verlassen die lokale CLI nicht. **Status prüfen** liest Gateway und Auth-Status und aktualisiert die Limits; **Gateway testen** sendet eine kurze reale Completion. Aus dem Quellordner bleibt der lokale Entwicklungsaufruf `./codex-ide` erhalten.

### npm-Paket und CLI-Update

`package.json` veroeffentlicht ueber eine positive `files`-Allowlist ausschließlich die ausfuehrbare App, Bridge-/Gateway-/Skill-Laufzeit, integrierte Skills und Skill-Pakete, Uebersetzungen, Dokumentation sowie `model-home/.gitkeep`. Eine untergeordnete `model-home/.npmignore` verhindert, dass npm Dokumentationsdateien aus dem eingeschlossenen Workspace-Unterordner automatisch ergaenzt; sie wird selbst nicht veroeffentlicht. Abhaengigkeitsordner, Tests, Buildquellen, interne Agentendateien und alle anderen Inhalte von `model-home` bleiben außerhalb des Tarballs. `.gitkeep` und `.npmignore` bleiben bei der manuellen Workspace-Bereinigung erhalten. Der `bin`-Eintrag stellt nach `npm install --global codex-ide` den Befehl `codex-ide` bereit.

`codex-ide version` zeigt die installierte Paketversion. `codex-ide update` liest das `latest`-Dist-Tag ueber die konfigurierte npm-Registry, wartet bei langsamen Antworten bis zu 20 Sekunden, vergleicht die Version semantisch und fragt vor `npm install --global codex-ide@<version>` nach. `--yes` bestaetigt automatisch. Ein interaktiver Start aus der globalen Installation bietet eine gefundene neue Version vor dem Gatewaystart an; `--no-update-check` und `CODEX_IDE_NO_UPDATE_CHECK=1` deaktivieren nur diese Startpruefung. Quellkopien und lokale `node_modules`-Installationen werden niemals selbst ueberschrieben.

Quellkopien verwenden `<projekt>/model-home`. npm-Installationen verwenden einen dauerhaften Workspace im Datenverzeichnis des aktuellen Nutzers: unter Linux/Termux `$XDG_DATA_HOME/codex-ide/model-home` oder `~/.local/share/codex-ide/model-home`, unter macOS `~/Library/Application Support/codex-ide/model-home`, unter Windows `%LOCALAPPDATA%/codex-ide/model-home`. Beim ersten Start wird ein vorhandenes paketlokales `model-home` vollstaendig in eine temporaere Kopie uebernommen und erst nach Abschluss am neuen Pfad bereitgestellt. Die Originaldateien bleiben erhalten; kopierte Dateien und Ordner erhalten Schreibrechte fuer ihren Besitzer, interne absolute Symlinks werden auf die neue Wurzel umgestellt. Ein vorhandener Nutzer-Workspace wird bei spaeteren Starts beibehalten. Explizite Modell-Home-Konfigurationen behalten ihren Pfad. Das Gateway zeigt den aktiven Pfad beim Start an; Lesen, Vorschau, Nutzerkonsole und sichtbare Editor-Persistenz verwenden dieselbe Wurzel.

Der aktive Nutzer-Workspace liegt außerhalb des npm-Pakets und bleibt bei dessen Austausch erhalten. Unmittelbar vor dem Paketwechsel sichert die CLI zusaetzlich das alte paketlokale `model-home` in einem neutral benannten temporaeren Backup, dessen Dateien, Verzeichnisse und Symlinkziele mit SHA-256 erfasst werden. Nach Erfolg oder Fehler des npm-Prozesses wird dieses Altverzeichnis am selben Projektpfad rekonstruiert und erneut gehasht. Die temporaere Kopie wird erst nach identischem Ergebnis entfernt; bei einem Wiederherstellungsfehler bleibt sie fuer Recovery erhalten.

## Backend-Dispatch

`backendProfile.js` verwaltet genau drei Werte:

- `local`: delegiert Chat-Completions an `window.CodexIdeLocalModel`.
- `api`: ruft einen konfigurierten OpenAI-kompatiblen Endpoint auf.
- `codex`: ruft das lokale Gateway auf und uebergibt Sitzungs-, Editor-, Sprach-, Modell- und Reasoning-Metadaten.

Alle drei Backends verwenden denselben Agentenloop, dieselben Steuerbloecke, dieselbe Skill-Registry und dieselben Editor-Callbacks. Nur Transport und modellseitiger Workspace-Leseweg unterscheiden sich.

Beim lokalen Modell gilt ein per Aufruf gesetztes Tokenbudget nur fuer diese Generierung und veraendert das gespeicherte Nutzerlimit nicht. Im Codex-Profil bleiben `low`, `medium`, `high`, `xhigh`, `max` und `ultra` im Modellkatalog erhalten; die IDE bietet fuer das aktuelle Modell nur dessen gemeldete `supported_reasoning_efforts` an.

## IDE-Zustand

`codex_ide/codex-ide.js` verwaltet:

- autoritativen Workspace-Index
- offene Puffer mit `content`, `savedContent` und `dirty`
- turnlokale exakte Read-Snapshots fuer noch nicht als Tab geoeffnete Dateien
- turnlokale bestaetigte Editor-Snapshots als autoritativer Folge- und Recovery-Stand
- aktive Datei und Pfadfeld
- benannte Agentensitzungen mit vollständiger, lokal persistenter Historie
- aktuelle Modell-/Skill-Aktivitaeten
- gemeinsames Nutzersignal fuer **Stoppen**
- native Konsolenlaeufe mit Befehl, vollständiger Ausgabe, weiterem stdin, Status, Exit-Code und Dauer
- lokalisierter Streaming-Editorentwurf mit Rollback-Snapshot fuer Inhalt, Auswahl und Scrollposition
- kontextueller Play-Button fuer die Browser-Vorschau einer aktiven gespeicherten `.html`-Datei

Der Workspace wird beim IDE-Start und nach Dateioperationen synchronisiert. Ein Modellturn verwendet den bereits geladenen Snapshot ohne einen zweiten blockierenden Komplettabgleich; partielle App-Server-Listen werden waehrend des Turns in den Dateibaum gemischt. Dateioperationen und Modellturns sperren konflikttraechtige Controls. Ein Backendwechsel behält die gewählte Agentensitzung, den Workspace und die Einstellungen.

Vorhandene Dateien werden über sichtbare `edit`-Aktionen geändert; `write` bleibt neuen Dateien vorbehalten. Die Laufzeit berechnet aus dem aktuellen Puffer und dem vollständig übertragenen Edit die tatsächlich geänderten Stellen. Unveränderte Zeilen und Wörter innerhalb von `oldText` bleiben durchgehend sichtbar, auch bei vollständigem Dateikontext oder kurzen Einzeilern. Getrennte Unterschiede werden nacheinander rot gelöscht und grün eingefügt; der Caret folgt der jeweiligen Arbeitsstelle und bleibt nach dem Speichern dort. Die Textarea wird mit lokalen `setRangeText`-Änderungen aktualisiert. Es gibt keine künstliche Zeichen-, Zeilen- oder Anteilssperre für Edits. Die bestehende adaptive Unicode-Animation bleibt erhalten; die Persistenz wartet auf ihren Abschluss. Neue Dateien werden weiterhin während der Generierung gestreamt.

Die IDE ordnet den Zielbereich gegen den neuesten sichtbaren Browserpuffer zu. Sie bevorzugt exakte Treffer, akzeptiert Whitespace-äquivalente Formen und kann leicht veraltetes `oldText` anhand der ähnlichsten Zeilenposition neu verankern. Optionale einbasierte Felder `startLine` und `endLine` lösen Drift und Mehrfachtreffer auf. Vor Beginn der Animation muss das vollständige Edit-JSON vorliegen, damit auch hinter `newText` übertragene Optionen berücksichtigt werden und unvollständiger Ersatz keinen Kontext löscht. Das gilt für `.md`, `.js`, `.css`, `.html` und `.py`. `replaceAll:true` ist nur für eine ausdrücklich gewollte Ersetzung aller Treffer zulässig. Beim Verwerfen eines Entwurfs stellt der Snapshot Inhalt, Auswahl, Dirty-Zustand und Viewport wieder her.

Kurze Änderungen erscheinen im 16-ms-Takt als einzelne Tastendrücke und Rückschritte. Bei größerem Rückstand beschleunigt die Animation pro Lösch- oder Einfügephase gleichmäßig auf höchstens 64 Unicode-Einheiten je Schritt; Löschen holt schneller auf als Einfügen. Die Rate sinkt am Ende einer großen Änderung nicht wieder ab. Jeder Schritt wartet auf die sichtbare Syntaxanzeige, und vor dem Speichern erhält der letzte Zustand einen weiteren Darstellungstakt. Ein abweichender Endpuffer wird verworfen statt unsichtbar ersetzt oder gespeichert. Stop und AbortSignal stellen den vorherigen Puffer auch bei ausstehendem Rendering sofort wieder her.

## Workspace-Policy

`scripts/codex-model-home.js` bestimmt die Standardwurzel: `<projekt>/model-home` fuer Quellkopien und das oben beschriebene Nutzer-Datenverzeichnis fuer npm-Installationen. Die Bridge legt diese Wurzel beim Gatewaystart fuer alle Kanaele fest. Workspace-Dateiwerkzeuge normalisieren relative oder absolute Pfade und pruefen, dass das aufgeloeste Ziel einschliesslich Symlinks innerhalb dieser Wurzel bleibt. Alle Dateitypen, versteckte Konfigurationen, Abhaengigkeiten und Memory sind dort erreichbar; interne Symlinks duerfen auch noch nicht vorhandene Ziele haben. Modell-Prompts verwenden die neutrale Bezeichnung `model-home`.

Die HTTP-Grenze akzeptiert ohne explizite Origin-Allowlist nur `localhost` oder IP-Literale als Browser-Host und blockiert dadurch DNS-Rebinding-Anfragen mit einem fremden, zu deren Origin passenden Hostnamen. JSON-Anfragen werden zustandsbehaftet als UTF-8 dekodiert, sodass mehrbyteige Zeichen an Chunkgrenzen nicht beschaedigt werden. Bei statischen Allowlist-Dateien muss auch das per `realpath` aufgeloeste Ziel innerhalb der App-Shell-Wurzel liegen.

Der sichtbare Editor verwendet fuer alle Textdateien einschliesslich Konfiguration und Memory:

```http
GET  /codex-ide/ide-files?path=...
POST /codex-ide/ide-files
X-Codex-IDE-Workspace: model-home
```

POST akzeptiert persistierbare vollstaendige Pufferstaende oder `{"operation":"mkdir"}`. Im sichtbaren Editor bezeichnet `write` eine neue Datei und `edit` ein bestehendes Ziel. Eine Editoraktion wird im Browserpuffer angewendet und der daraus entstandene Stand automatisch gespeichert. Es gibt keine Dateityp- oder Sondernamenssperre innerhalb des Modell-Homes und kein optionales `writeCode`-Recht. Projektdateien werden ausschliesslich ueber sichtbare Editoraktionen geaendert.

Bei einem aktiven gespeicherten `.html`-Puffer blendet die Editor-Kopfzeile einen kleinen Play-Button ein. Er oeffnet `GET /codex-ide/preview/<relativer-pfad>` in einem neuen Tab; andere Dateitypen und unbenannte neue Puffer zeigen ihn nicht. Die Route liefert ausschließlich freigegebene Web-Dateitypen read-only aus `model-home`, unterstuetzt relative klassische CSS-/JavaScript- und Medienressourcen und verwendet `Cache-Control: no-store`. Pfadnormalisierung, geschuetzte Verzeichnisse, reservierte Ziele und Symlink-Grenzen bleiben aktiv. HTML-Antworten erhalten eine CSP-Sandbox mit Skriptausfuehrung, aber ohne `allow-same-origin`, sodass Vorschaucode weder IDE-Speicher noch IDE-Endpunkte als gleicher Ursprung verwenden kann. Der Preview-Kanal veraendert keine Editor-, Skill- oder Schreibrechte.

Der allgemeine Extended-Files-Skill verwendet separat `/codex-ide/extended-files` sowie `X-Codex-IDE-Skill` und `X-Codex-IDE-Permission`.

Die direkte Nutzerkonsole ist ein eigener, lokaler Kanal. Der Browser faengt die exakten Direktiven `/console start` und `/console close` vor Backendauswahl, Modellaufruf und Sitzungspersistenz ab. Ein neuer Befehl geht als `POST /codex-ide/console` mit `X-Codex-IDE-Workspace: model-home` und `X-Codex-IDE-Console: user` an das Gateway; server- und browserseitig laeuft hoechstens ein Nutzerbefehl gleichzeitig. Die Route streamt Start, stdout/stderr und Abschluss als `codexIde.terminal_event` und verwendet dieselbe sichtbare Konsolenkarte mit der Herkunft **Nutzer**. Solange der Prozess laeuft, bleiben das Promptfeld, **Eingabe senden** und **Stoppen** gleichzeitig aktiv. Jede weitere Zeile einschließlich einer leeren Eingabe wird mit der Lauf-ID als `POST /codex-ide/console/input` an dessen aktives PTY weitergereicht; falsche oder abgeschlossene Lauf-IDs werden mit HTTP 409 abgewiesen. **Stoppen** beendet den laufenden Prozess, `/console close` beendet den Modus und blendet die Karte aus, ohne den sichtbaren Laufnachweis zu loeschen. Ein abgeschlossener Lauf schließt den Eingabekanal, entfernt die Laufzuordnung, invalidiert den Workspace-Snapshot und laedt den Dateibaum neu.

Dieser getrennte ausdrueckliche Nutzerkanal arbeitet im echten `model-home`. Die Nutzer-Shell definiert nur fuer diesen Kanal `rm` mit standardmaessig rekursiver Semantik; dadurch entfernt bereits `rm ordner` einen normalen verschachtelten Verzeichnisbaum. Explizite Optionen bleiben moeglich. Der Runner verbindet stdin, stdout und stderr des Nutzerprozesses mit einem echten PTY; `PYTHONUNBUFFERED=1` bleibt zusaetzlich gesetzt. Python und TTY-abhaengige Bibliotheken erkennen damit eine interaktive Konsole. Bereits ausgefuehrte Ausgaben erscheinen vor dem jeweiligen `input()` in normaler Programmreihenfolge, der Prozess wartet nur an diesem Eingabeaufruf und verarbeitet danach beliebig viele weitere Eingaben. `scripts/codex-readonly-runner.c` emuliert und prueft weiterhin jede schreibende oder loeschende Dateioperation einzeln: Schreib-, Loesch-, Umbenennungs- und Linkziele sind nur innerhalb der konfigurierten Workspace-Wurzel zulaessig; `.git`, `node_modules`, `.env*`, das reservierte `memory.md`, Ziele außerhalb des Workspace sowie neue, ausbrechende und dangling Symlinks bleiben blockiert. Nicht-Unix-Netzwerksockets und Privilegwege bleiben deaktiviert. Der getrennte Nutzerkanal aendert den exklusiven Live-Editor-Schreibweg des Modells nicht.

Die Workspace-Policy meldet Version 21 mit `ideSandbox: read-only-native-live-editor` und `terminalExecution: verification-copy-live`. Tool-Protokollversion 3 erneuert alte Threads mit direkten Schreibwerkzeugen anhand des mitgelieferten Gespraechs. Ein fehlender oder alter Policy-Status blockiert keinen Turn. Der Live-Editor bleibt fuer alle Textdateien und versteckten Pfade ohne Skill-Freigabe schreibfaehig.

## Codex App Server

Der Codex-Modus verwendet standardmaessig eine persistente App-Server-Instanz mit nicht-ephemeren Threads. Benannte Browser-Sitzungen werden in der Agentenkopfzeile angelegt, gewechselt, umbenannt oder gezielt gelöscht und mit stabilen IDs auf eigene App-Server-Threads abgebildet. Ihre vollständigen und in der UI erneut sichtbaren Verläufe, letzten Turnzustände und Thread-IDs liegen ohne anwendungsseitige Nachrichten- oder Zeichengrenze in IndexedDB. Serialisierte Writes werden bis zum neuesten bestaetigten Commit synchron als revisionsmarkierter `localStorage`-Crash-Fallback gespiegelt. Laufende Turns werden vor dem Modellaufruf persistiert und nach Erfolg, Stop oder Fehler abgeschlossen; ein Neustart markiert einen zurückgebliebenen laufenden Turn sichtbar als unterbrochen. Folgeprompts bleiben im selben Thread, bestehende Sitzungen werden beim Anlegen einer neuen nicht zurückgesetzt, und nach einem Gatewayneustart setzt `thread/resume` die gespeicherte Thread-ID fort. Ausdrücklich dauerhafte Nutzerinformationen aus `memory.md` stehen zusätzlich sitzungsübergreifend und ohne anwendungsseitige Kürzung bereit. Die normalisierte Antwortsprache gehoert zur Thread-Identitaet; bei einem Sprachwechsel wird der bisherige Thread fuer den naechsten Turn durch einen sprachpassenden ersetzt, damit auch native knappe Arbeitszusammenfassungen der aktuellen Sprache folgen. Das dynamische Werkzeug `codex_ide_workspace` erlaubt nur:

```json
{"operation":"list","path":"optionaler/unterordner","depth":1}
{"operation":"read","path":"relativ/datei.js","purpose":"inspect"}
{"operation":"read","path":"relativ/zu-bearbeiten.js","purpose":"edit"}
```

`list` ist standardmaessig auf eine flache Ebene begrenzt; `path` und `depth` vertiefen ausschließlich einen relevanten Projektzweig. Tool-Lifecycle, partielle Workspace-Indizes, gelesene Dateien, knappe modellverfasste Arbeitszusammenfassungen und native Konsolenereignisse werden als `codexIde`-SSE-Metadaten an die IDE gestreamt. Die Modellkonsole bildet `item/started`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction` und `item/completed` auf einen sichtbaren Lauf ab; der PRoot-Kompatibilitaetsweg erzeugt dieselben normalisierten Start-, Ausgabe- und Abschlussdaten direkt im Handler von `codex_ide_terminal`. Die Modellkonsole ist ohne Lauf verborgen und erscheint beim ersten Start-Event im Agenten-/Denkbereich zwischen Arbeitsnotizen und finaler Antwort. Dadurch bleiben Modellbefehl, stdout/stderr, nachgereichtes stdin, Status, Exit-Code und Dauer unmittelbar sichtbar; private Hostpfade werden nur fuer die Anzeige zu `model-home` normalisiert. Die Ausgabe wird nicht gekuerzt. Die Zusammenfassungen benennen aufgabenbezogen die aktuelle Untersuchung, Aenderung, Pruefung oder ihren Grund, aber keine private Chain-of-Thought, internen Pfade oder Rohinhalte. Native App-Server-Zusammenfassungen werden direkt als unnummerierte Arbeitsnotizen dargestellt. Es gibt keine künstlichen Denkkarten, Phasentexte, Sekundenzähler, Kürzung oder Ähnlichkeitsfilter. Thread-, Turn-, Item- und Summary-Index halten alle Teile getrennt; Abschlussereignisse ergänzen fehlende Teile oder korrigieren vorhandenen Text. Die DOM-Knoten bleiben bei weiteren Skill- und Summary-Ereignissen erhalten. Native Notizen werden turnlokal unverändert gesammelt und Folgepässen mit einer Nicht-Wiederholungsregel übergeben. `purpose:"inspect"` liefert Kontext ohne Tab, sein exakter Dateiinhalt bleibt jedoch als autoritativer Ausgangsstand fuer einen spaeteren Live-Edit erhalten; `purpose:"edit"` öffnet und fokussiert den echten Puffer sofort. Ein anschliessender Edit einer nur inspizierten Datei erzeugt aus dem Snapshot einen sichtbaren Tab. Fehlt ausnahmsweise jeder Snapshot, liest die Editor-Laufzeit das Ziel nochmals ueber den IDE-Kanal und aktiviert den Puffer vor der Aenderung. Nach jedem bestaetigten Oeffnen oder Bearbeiten wird der tatsaechlich sichtbare Browserpuffer als aktueller turnlokaler Stand in alle Folge-, Audit- und Recovery-Paesse uebernommen. Ist der Zielpfad bereits im sichtbaren Editor aktiv, schlaegt dieser aktive DOM-Puffer alte Tab-Caches und vorherige Workspace-Reads; ungespeicherte aktive Inhalte werden durch einen neuen Read nicht ersetzt. Er ersetzt fuer denselben Pfad aeltere App-Server-Reads; ein Recovery-Prompt enthaelt deshalb nie gleichzeitig diesen Puffer und einen aelteren Read desselben Pfads. Bei einem abgewiesenen veralteten `oldText` dient der unveraenderte aktuelle Puffer unmittelbar als Reparaturbasis und der naechste Codex-Pass beginnt sofort in einem frischen App-Server-Thread. Partielle Indizes werden mit dem vollständigen Browser-Dateibaum zusammengeführt und ersetzen ihn nicht. Schreiboperationen bleiben strukturierte IDE-Requests und laufen nicht ueber native Modell-Dateiwerkzeuge.

Vor dem ersten Modelltoken jedes neuen Nutzerprompts schreibt die IDE den sichtbaren DOM-Inhalt in seinen Tabpuffer und uebergibt alle offenen Browserpuffer als autoritative Start-Snapshots. Dadurch kennt ein Folgeauftrag auch die bereits geaenderten Inhalte nicht aktiver Tabs, waehrend die persistente App-Server-Sitzung und die Gespraechsfortsetzung erhalten bleiben.

Ein mit `path` begrenztes `list` beginnt direkt am angeforderten Ordner und traversiert nur die angeforderte Tiefe. Ein anderer Projektzweig kann deshalb weder den Scoped-Scan verlangsamen noch dessen Eintragslimit aufbrauchen. App-Server-JSONL und Konsolenstroeme werden zustandsbehaftet als UTF-8 dekodiert; beim Prozessneustart werden unvollstaendige Bytes und Zeilen des alten stdout-Stroms verworfen. Lange Modell- und Terminaldeltas werden linear gesammelt. Der Browser haengt nur neue Terminalzeichen an; ein Complete-Event uebertraegt einen bereits gestreamten Aggregate-Text nicht nochmals, behaelt ihn ohne vorherige Deltas aber als Fallback.

Codex bearbeitet Projektdateien ausschliesslich sichtbar im Live-Editor. Native Werkzeuge sind zum Lesen und die Pruefkonsole fuer Verifikation vorgesehen. Auch verlangte Memory-Aenderungen laufen im Workspace-Turn ueber den Editor. Das Gateway behaelt keine verpflichtende Versions- oder Login-Pruefung vor dem Turn und keinen Request-/Socket-Timeout bei.

Der App Server waehlt bei Threadstart, Resume und Turnstart `codex-ide-live-editor`. Native Modellwerkzeuge lesen den Workspace, waehrend ausschliesslich die sichtbaren Editoraktionen Projektdateien aendern und speichern. Auch der Legacy-Exec-Pfad verwendet eine native Read-only-Sandbox. `codex_ide_workspace` bietet nur `list` und `read`; direkte `write`, `mkdir`, `move` oder `remove`-Aufrufe werden zum Live-Editor verwiesen. Alle Dateitypen bleiben lesbar, fuer Binaerinhalte gibt es Base64-Reads. Interne Symlinks und bedarfsgerechte Listings ohne feste Tiefen- oder Eintragsgrenze bleiben erhalten.

`codex_ide_terminal` prueft eine separate Workspace-Kopie. Interne Symlinks werden auf Ziele in der Kopie umgebogen. Caches und Build-Ausgaben sind dort erlaubt; es gibt keinen Fehler allein wegen solcher Schreibvorgaenge. Die Kopie wird nach Abschluss oder Stop verworfen und niemals ins Projekt zurueckgeschrieben. Der Modellkanal nutzt `command/exec` im App-Server-Sandboxkontext mit Schreibrechten nur fuer die Pruefwurzel und deaktiviertem Netzwerk. Ein ungeschuetzter Modell-Shell-Fallback existiert nicht. `disableTimeout` und `disableOutputCap` halten Laufzeit und Ausgabe unbegrenzt; ein C-Compiler ist nicht erforderlich.

Vor Jest liest das Modell `package.json` ueber das Workspace-Werkzeug. Ein Jest-Testscript verwendet kanonisch `npm test -- --runInBand`, ein anderes lokales Testscript `npm test`; eine deklarierte lokale Jest-Abhaengigkeit ohne Testscript verwendet `npm exec --offline -- jest --runInBand`. Fehlt eine deklarierte Testsuite, wird das praezise benannt und der passende vorhandene Syntaxcheck ausgefuehrt. `npx`, Installationen, absolute Hostpfade und zufaelliges Variantenprobieren sind ausgeschlossen.

## Agentenloop und Vollstaendigkeit

Das gemeinsame Protokoll besteht aus `codex_ide_thought`, `codex_ide_skill_request`, `codex_ide_editor_request`, `codex_ide_workspace_complete` und `codex_ide_final`. Editor-Requests unterstützen `open`, lokales `edit`, neues `write` und `mkdir`. Editoraktionen werden direkt ausgegeben. Zusätzliche `codex_ide_thought`-Blöcke werden im Workspace nicht mehr verlangt oder als Denkkarten angezeigt; sichtbare Arbeitsnotizen kommen aus den nativen App-Server-Zusammenfassungen.

Der Loop:

1. baut System-, Sprach-, Skill- und Workspace-Kontext;
2. liest/validiert eine strukturierte Aktion;
3. fuehrt sie ueber sichtbare Callbacks aus;
4. schreibt Editor-, Skill-, Workspace- und Konsolenergebnisse in den Aktionsledger;
5. plant weiter oder repariert;
6. fordert eine strukturierte Vollstaendigkeitsbestaetigung;
7. erzeugt erst danach die finale Antwort.

Malformed Requests und ungueltige strukturierte Audit-Antworten werden mit einer konkreten Diagnose repariert. Bleibt eine Editoraktion oder das Audit-Schema wiederholt unvollstaendig beziehungsweise technisch nicht anwendbar, gleicht die IDE den Workspace erneut ab und setzt den Turn in einer frisch aufgebauten Modellsitzung fort. Es gibt dafuer keine Retry-, Aktions- oder Laufzeitgrenze; erfolgreicher Editorfortschritt und der Aktionsledger bleiben erhalten. Vorzeitige Finaltexte und Aufschub werden intern zurueckgewiesen. Nur ein Nutzer-Stop beendet Streaming, Skill und Editorloop ueber dasselbe Signal.

Fuer `api` und `codex` bleibt der strukturierte Vollstaendigkeitsaudit verbindlich. `local` normalisiert eine unmarkierte Textausgabe zu `codex_ide_final` und akzeptiert eine korrekt markierte Finalantwort direkt; dadurch bleiben auch kleinere Browsermodelle fuer normale IDE-Fragen nutzbar. Strukturierte lokale Skill-/Editoraktionen und ihre Protokoll-Recovery werden ohne feste Versuchszahl weitergefuehrt.

## Skills

`skillSystem.js` laedt die drei integrierten Manifeste und lokal installierte Manifeste. Gueltige Profile sind `local`, `api`, `codex`. Der Einstellungsdialog rendert Manifesttexte, Rechte, Profile und Setup dynamisch.

Installationswege:

- HTTPS-Manifest plus Einstiegspunkt
- `.codexskill`-JSON-Paket
- `manifest.json` plus lokaler Einstiegspunkt

Vor Installation werden Schema, IDs, semantische Version, Profilwerte, Einstiegspunkt, Integritaet, Rechte, Setup-Felder, Agentenparameter und Permission-Rules geprueft. Eine Vertrauenscheckbox ist obligatorisch. Runtimes registrieren sich unter `window.CodexIdeSkillSystem`.

## Lokalisierung

`translations/de.js`, `translations/en.js` und `translations/fr.js` exportieren dieselbe UI-Schluesselmenge. Die Kopfzeile bietet Deutsch, Englisch und Franzoesisch als Flaggen-Buttons an; `codexIdeLanguage` speichert die Auswahl und wird bereits von der Einstellungsruntime gelesen, bevor die Haupt-IDE ihre eigene Sprachinitialisierung abgeschlossen haben muss. `codex-ide-language-change` aktualisiert Hauptansicht und Einstellungsdialog ohne Reload.

## PWA und Updates

`sw.js` cached ausschliesslich die aktuelle App-Shell unter `codex-ide-v47`. `/health`, `/gateway/status`, `/codex/*`, `/v1/*` und `/codex-ide/*` umgehen den Cache. Die Registrierung prueft `sw.js` mit `updateViaCache: none`. Ein aktiver alter Worker verhindert weiterhin das ungefragte Vorladen; erst die bestaetigte Nachricht `DOWNLOAD_UPDATE` laedt jede Shell-Datei mit `cache: reload`, aktiviert den Worker und laedt die kontrollierte Seite nach `controllerchange` einmal neu. Kennt ein bereits geladener aelterer Client diesen Listener noch nicht, markiert der neue Worker den bestaetigten Download und navigiert genau diese bestehenden Fenster nach der Aktivierung selbst neu. Die explizite Clean-URL meldet alle Worker ab, leert Cache Storage und startet ohne Clean-Parameter neu; Einstellungen, Skills und Workspace bleiben erhalten. npm-Paketupdate und PWA-Aktivierung bleiben getrennt und jeweils bestaetigungspflichtig.

## Verifikation

Die Jest-Konfiguration schliesst `model-home/` aus: Dortige Tests sind Nutzerdaten und kein Bestandteil der Codex-IDE-Release-Suite.

```bash
npm run verify:syntax
npm run pwa:validate
npm test -- --runInBand
npm pack --dry-run --ignore-scripts
node --test skill_packages/GitHub_Repo_Skill/runtime-checks.js
```

Ergaenzende Syntaxbefehle und Projektregeln stehen in [agents.md](agents.md).
