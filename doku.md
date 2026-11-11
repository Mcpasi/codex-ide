# Codex IDE: technische Kurzdokumentation

## Zweck

Codex IDE ist eine eigenstaendige, PWA-faehige Entwicklungsumgebung. Die Root-Seite startet unmittelbar den Workspace, den Mehrpuffer-Editor und den Agenten. Backends, Sprache und Skills werden im selben IDE-Fenster konfiguriert. Es gibt keine vorgeschaltete Anwendung und keinen Ladebildschirm.

Die App-Shell folgt der lokalisierten Leitzeile **Dein Agent bei der Arbeit — jede Aenderung live.** Ihr dunkles Markenbild verwendet Crimson und Koralle fuer interaktive Akzente, waehrend Erfolg, laufende Arbeit und Fehler weiterhin durch Text, Zustandssymbole und eigene Statusfarben unterscheidbar bleiben. Die bestehenden Desktop-, Tablet- und Mobilanordnungen werden bei 1050, 700 und 420 Pixeln abgestuft.

## Start

```bash
npm install -g codex-ide
codex-ide start
```

Die IDE ist danach unter `http://localhost:8787/` erreichbar. `start` oeffnet sie standardmaessig im Browser.

Im Quellordner bleiben fuer die Entwicklung `npm install` und `./codex-ide start` verfuegbar.

Weitere Befehle:

```bash
codex-ide start --no-open
codex-ide gateway
codex-ide gateway --open
codex-ide clean
codex-ide version
codex-ide update
codex-ide update --yes
codex-ide codex login
codex-ide codex login --device-auth
codex-ide codex status
codex-ide bridge
codex-ide codex gateway
codex-ide codex bridge
codex-ide codex login-device
codex-ide skill validate <skill-ordner>
codex-ide skill pack <skill-ordner> [paket.codexskill]
```

## Drei Backend-Modi

| Modus | Generierung | Konfiguration |
|---|---|---|
| `local` | Transformers.js-Modell im Browser | Modell-ID, Aktivierung, max. neue Tokens |
| `api` | OpenAI-kompatibler Chat-Completions-Endpunkt | URL, API-Key, Modell, Tokenlimit |
| `codex` | lokale offizielle Codex-CLI ueber den persistenten App Server | Gateway-URL, Modell, Reasoning-Stufe, Tokenlimit |

Der Modus kann in der Kopfzeile oder unter **Einstellungen → Generatives Backend** gewechselt werden. Ein Wechsel setzt nur die Agentensitzung zurueck; der Workspace, offene lokale Daten und die Skill-Konfiguration bleiben erhalten.

### Lokal

Transformers.js wird nicht beim normalen Start geladen. Erst **Einstellungen → Lokales Browser-Modell → Modell laden** importiert die Laufzeit und laedt das gewaehlte Hugging-Face-Textgenerierungsmodell. Nach dem Modelldownload kann die Laufzeit aus dem Browsercache arbeiten.

Das gespeicherte Maximum neuer Tokens wird ausschließlich durch die sichtbare Einstellung geaendert. Ein internes Audit oder ein anderer einzelner `chatCompletion`-Aufruf darf ein kleineres Budget verwenden, ohne dieses Nutzerlimit fuer spaetere Antworten zu ueberschreiben.

### API

Die URL wird zu einem Chat-Completions-Pfad normalisiert. Der Key bleibt in `localStorage`. Fuer oeffentlich ausgelieferte Installationen ist ein eigener Proxy empfehlenswert. Mit **Verbindung testen** wird eine kurze reale Completion ausgefuehrt.

### Codex Auth-Bridge

```bash
# Desktop: oeffnet die offizielle Browser-Anmeldung
codex-ide codex login

# Termux/headless: zeigt URL und Einmalcode im Terminal
codex-ide codex login --device-auth

# persistente Anmeldung pruefen
codex-ide codex status

# danach Gateway und IDE starten
codex-ide start
```

Die Browser-App erhaelt keine Auth-Datei und keine Tokens. Die Befehle stehen auch unter **Einstellungen → Codex Auth-Bridge** und koennen dort kopiert werden. Dort liest `/codex/usage` ueber den persistenten App Server ausschließlich `account/rateLimits/read`, normalisiert verbrauchte in verbleibende Prozent und liefert keine Credentials an den Browser. Zwei lokalisierte Balken zeigen Tages-/Kurzzeit- und Wochenkontingent blau; verbleiben hoechstens 20 Prozent, wechselt der Balken zu Rot und erhaelt zusaetzlich die Textmarkierung „niedrig“. Fehlt ein Zeitfenster in der Codex-Antwort, bleibt sein Balken sichtbar als nicht verfuegbar, statt einen Wert zu schaetzen. **Status prüfen** ruft Gateway- und Loginstatus ab und aktualisiert die Limits. **Gateway testen** fuehrt eine kurze reale Completion ueber denselben Codex-Pfad aus, den der Agent verwendet. Das Gateway fragt Loginstatus und Modellkatalog ueber die lokale Codex-CLI ab. Jede benannte Browser-Konversation verwendet standardmaessig eine nicht-ephemere App-Server-Sitzung und behaelt Verlauf sowie Thread-ID ueber Folgeprompts, Browser- und Gatewayneustarts.

Der Modellkatalog transportiert `low`, `medium`, `high`, `xhigh`, `max` und `ultra` unverfaelscht. Die IDE filtert die Reasoning-Auswahl pro Modell anhand seiner live gemeldeten `supported_reasoning_efforts`.

`codex-ide gateway` startet nur den Dienst; `--open` oeffnet zusaetzlich die IDE. Die vorhandenen Funktionswege `codex-ide bridge`, `codex-ide codex gateway` und `codex-ide codex bridge` starten dasselbe Gateway. `codex-ide codex login-device` entspricht dem Login mit `--device-auth`; `signin`, `sign-in` und `device-login` bleiben ebenfalls verfuegbar.

## npm-Paket und Selbstupdate

Das Paket `codex-ide` installiert ueber den `bin`-Eintrag den globalen Befehl `codex-ide`. Die veroeffentlichte Dateiliste ist eine ausdrueckliche Allowlist; eine zusaetzliche `model-home/.npmignore` blockiert npm-Sonderfaelle fuer Dokumentationsdateien in eingeschlossenen Unterordnern. Das Tarball enthaelt App-Shell, Gateway, Bridge, CLI, integrierte Skills, Skill-Pakete, Uebersetzungen, Dokumentation und aus dem Workspace ausschließlich `model-home/.gitkeep`. Tests, Abhaengigkeitsordner, interne Agentendateien, Buildquellen und vorhandene Nutzerdateien aus `model-home` gelangen nicht hinein. Bei der manuellen Workspace-Bereinigung bleiben `.gitkeep` und `.npmignore` erhalten; `.npmignore` selbst wird von npm nicht veroeffentlicht.

`codex-ide version` liest die installierte semantische Paketversion. `codex-ide update` fragt npm direkt nach dem stabilen `latest`-Dist-Tag, toleriert langsamere Registry-Antworten bis 20 Sekunden und verlangt vor dem Download eine interaktive Bestaetigung; `--yes` bestaetigt nichtinteraktiv. Ein interaktiver global installierter `codex-ide start` bietet eine neuere Version vor dem Gatewaystart ebenfalls an. `--no-update-check` oder `CODEX_IDE_NO_UPDATE_CHECK=1` ueberspringt nur diese automatische Pruefung.

Quellkopien behalten `<projekt>/model-home`. npm-Installationen speichern den aktiven Workspace im Datenverzeichnis des aktuellen Nutzers, außerhalb des Pakets. Vorhandene paketlokale Dateien werden beim ersten Start ueber eine temporaere Kopie uebernommen; die Originale bleiben erhalten. Kopierte Dateien und Ordner erhalten Schreibrechte fuer ihren Besitzer, interne absolute Symlinks werden auf den neuen Workspace umgestellt. Ein vorhandener Nutzer-Workspace wird bei spaeteren Starts beibehalten. Explizite Modell-Home-Konfigurationen behalten ihren Pfad.

Das Selbstupdate ist nur zulaessig, wenn die laufende CLI exakt aus dem von `npm root --global` gemeldeten Paketpfad stammt. Der aktive Nutzer-Workspace uebersteht den Paketwechsel außerhalb des npm-Verzeichnisses. Vor `npm install --global codex-ide@<version>` wird zusaetzlich das alte paketlokale `model-home` in ein neutral benanntes temporaeres Verzeichnis kopiert und per SHA-256 ueber Dateien, Verzeichnisse und Symlinkziele verifiziert. Danach wird dieses Altverzeichnis aus der Sicherung am selben Projektpfad rekonstruiert und erneut geprueft, auch bei einem npm-Fehler. Erst nach bestaetigter Wiederherstellung wird die temporaere Sicherung entfernt; bei einem Wiederherstellungsfehler bleibt sie mit einem ausgegebenen Recovery-Pfad erhalten.

## Sprache

Deutsch, Englisch und Franzoesisch lassen sich direkt in der Kopfzeile ueber Flaggen-Buttons umschalten. Die Auswahl wird lokal gespeichert und schon beim Start der Einstellungsruntime angewendet, auch wenn die Haupt-IDE ihre Sprachinitialisierung erst danach abschließt. UI, Fortschrittsnotizen, Skill-Bezeichnungen und Backend-Hinweise werden sofort aktualisiert. Die Antwortsprache richtet sich zusaetzlich nach der aktuellen Nutzeranweisung. Im Codex-Modus ist diese normalisierte Sprache Teil der App-Server-Thread-Identität: Ändert sie sich, wird beim nächsten Turn automatisch ein neuer sprachpassender Thread gestartet, sodass auch die knappen modellverfassten Arbeitszusammenfassungen nicht in der Sprache der vorherigen Sitzung verbleiben.

## Workspace und Editor

Bei Quellkopien liegt der Workspace in:

```text
<projekt>/model-home
```

npm-Installationen verwenden unter Linux/Termux `$XDG_DATA_HOME/codex-ide/model-home` oder `~/.local/share/codex-ide/model-home`, unter macOS `~/Library/Application Support/codex-ide/model-home` und unter Windows `%LOCALAPPDATA%/codex-ide/model-home`. Das Gateway zeigt den aktiven Pfad beim Start an und verwendet ihn einheitlich fuer Lesen, Vorschau, Nutzerkonsole und Editor-Persistenz.

Die IDE bietet:

- sicheren Dateibaum und Ordneranlage
- mehrere offene Puffer und Dirty-Markierung
- Syntaxdarstellung fuer unterstuetzte Text-/Codeformate
- Speichern per Button oder `Ctrl/Cmd+S`
- kleinen Play-Button in der Editor-Kopfzeile, sobald eine gespeicherte `.html`-Datei aktiv ist
- beschleunigt zeichenweise Echtzeit-Edits: Löschungen erscheinen in kleinen adaptiven Unicode-Paketen rot, Einfügungen grün und Caret, Viewport sowie Syntax-Overlay folgen jedem sichtbaren Zwischenstand direkt am echten Fundort
- strukturierte `open`-, `edit`-, `write`- und `mkdir`-Aktionen; `write` ist neuen Dateien vorbehalten
- Markdown als vollwertiges Editorformat: `.md` verwendet denselben sichtbaren Live-, Rollback- und Speicherpfad wie Code
- bedarfsgerechte Tabs statt pauschalem Projektimport
- native Live-Konsole fuer Modellbefehle, stdout/stderr, weitere Modelleingaben und Exit-Status
- lokal mit `/console start` und `/console close` gesteuerte Nutzerkonsole fuer direkte Workspace-Befehle ohne Modellturn
- Stop und benannte Sitzungsverwaltung
- nummerierte Denk-, Skill- und Finalschritte

In der Agentenkopfzeile lassen sich Sitzungen neu anlegen, wechseln, umbenennen und gezielt löschen. Die IDE zeigt beim Wechsel das vollständige gespeicherte Transkript. Verlauf, stabiler Sitzungsname, letzter Turnstatus und App-Server-Thread-ID werden ohne anwendungsseitige Nachrichten- oder Zeichengrenze in IndexedDB gespeichert. Bis zum jeweils neuesten serialisierten Datenbank-Commit liegt synchron eine revisionsmarkierte `localStorage`-Sicherung vor. Ein Turn wird vor dem Modellaufruf als `running` und danach als `completed`, `stopped` oder `failed` gespeichert; nach einem Browserneustart wird ein zurückgebliebener laufender Datensatz sichtbar als `interrupted` abgeschlossen. Ein neuer Prompt bleibt deshalb in derselben Unterhaltung, eine neue Sitzung setzt bestehende Sitzungen nicht zurück, und nach einem Gatewayneustart setzt `thread/resume` den gespeicherten nicht-ephemeren Thread fort. Ausdrücklich dauerhaft gemerkte Nutzerinformationen liegen zusätzlich global in `memory.md` und stehen sitzungsübergreifend ohne anwendungsseitige Kürzung bereit.

Der Editor liest und speichert `.md`, `.js`, `.css`, `.html` und `.py` ueber `/codex-ide/ide-files` und den Header `X-Codex-IDE-Workspace: model-home`. Der Gateway-Handler normalisiert Pfade, blockiert absolute Formen, Traversal, Steuerzeichen, geschuetzte Verzeichnisse, das reservierte `memory.md` und ausbrechende Symlinks. Nicht aufloesbare Symlinks gelten beim automatischen Waehlen eines Ausweichnamens als belegt und werden nie als Schreibziel verfolgt. Agentische `write`-Aufrufe duerfen am Gateway atomar nur neue Pfade anlegen; `edit` setzt atomar eine bestehende Datei voraus. Eine Aenderung gilt erst nach Gateway-Antwort als gespeichert. Markdown wird in diesem Kanal nicht getrimmt oder als HTML-Ersatz behandelt, sondern exakt aus dem sichtbaren Puffer persistiert. Dafuer ist weder `writeCode` noch ein anderes optionales Datei-Skillrecht erforderlich. Modell-Prompts verwenden fuer den Arbeitsbereich nur den neutralen Namen `model-home` und legen keinen absoluten Hostpfad offen.

Ist der aktive Puffer eine gespeicherte `.html`-Datei, erscheint rechts oben der Play-Button. Er oeffnet die gespeicherte Fassung unter `/codex-ide/preview/<relativer-pfad>` in einem neuen Browser-Tab; bei anderen Dateitypen, einem unbenannten neuen Puffer oder waehrend einer laufenden Datei-/Agentenoperation bleibt er verborgen beziehungsweise gesperrt. Relative klassische CSS-/JavaScript-, Bild-, Schrift- und Medienpfade werden aus demselben Vorschau-Unterordner geladen. Der Preview-Kanal ist read-only, verwendet `Cache-Control: no-store` und dieselben Modell-Home-, Traversal-, Verzeichnis- und Symlink-Grenzen. Eine CSP-Sandbox erlaubt die Seitendarstellung und klassische Skripte, vergibt aber bewusst kein `allow-same-origin`; Vorschaucode erhaelt dadurch keinen Zugriff auf den IDE-Ursprung oder dessen Speicher. Editor-, Skill- und Schreibrechte bleiben unveraendert.

Bei einer vorhandenen Datei verwendet der Agent weiterhin ausschließlich `edit`; `write` bleibt neuen Dateien vorbehalten und kann dies auch bei einem unvollstaendigen Browser-Dateibaum wegen des atomaren Gateway-Schutzes nicht umgehen. Fuer den tatsaechlich geaenderten zusammenhaengenden Bereich gibt es keine kuenstliche Zeichen- oder Zeilengrenze. Eine bestehende Datei darf aber nicht durch das Ersetzen des gesamten oder praktisch gesamten Puffers neu erzeugt werden: Unveraenderte Bereiche bleiben ausserhalb von `oldText`, getrennte Arbeitsstellen erhalten getrennte Edits. Nur eine am selben Ziel exakt bereits vorhandene Ersetzung ist ein erfolgreiches idempotentes No-op. Ähnlicher, erweiterter oder in einem Folgeprompt neu verlangter Inhalt – ausdrücklich auch CSS – bleibt auszuführen. Nach einem erfolgreichen Codex-Edit beginnt direkt der strukturierte Vollständigkeitsabgleich, statt dem Modell Gelegenheit zu geben, denselben Block nochmals als nächste Aktion auszugeben. Sichtbare Modelltexte sprechen dabei nur ueber Aufgabe und Ergebnis, nicht ueber Editorprotokolle, Steuerbloecke oder interne Audits. Damit sind auch sehr grosse lokale Aenderungen effizient moeglich, ohne den Puffer wie eine neue Datei zu behandeln.

`oldText` muss nicht mehr exakt und eindeutig zum inzwischen fortgeschriebenen Browserpuffer passen. Die Laufzeit bevorzugt einen exakten Treffer, akzeptiert anschließend äquivalente Whitespace-Formatierung und ordnet leicht veraltete Bereiche anhand ihrer Zeilenähnlichkeit neu zu. Bei mehrfach vorkommenden oder driftenden Abschnitten kann der Agent `startLine` und optional `endLine` als einbasierte Positionshinweise senden. Erst wenn keine ausreichend sichere Zuordnung gelingt, beginnt die bestehende Snapshot-Recovery. Der Editor-Request startet weiterhin ohne vorgeschalteten Denkblock. Der alte Bereich verschwindet in kleinen, adaptiv beschleunigten Unicode-Paketen mit roter Markierung wie bei schneller wiederholter Ruecktaste; danach wächst `newText` in solchen Paketen mit gruener Markierung und kollabiertem, nachlaufendem Caret wie die Tastatureingabe eines Menschen am anderen Ende. Der 16-ms-Darstellungstakt bleibt erhalten; je nach Rückstand verarbeitet jeder animierte Zielbereich höchstens 256 Unicode-Zeichen pro Frame. Modellinhalt wird nie als vollständiger Ersatzblock eingesetzt, und die Persistenz beginnt erst nach dem sichtbar erreichten Endstand. Viewport und Syntax-Overlay folgen dieser Stelle, während unberührte Pufferbereiche stehen bleiben. Wird ein Entwurf abgebrochen oder verworfen, kehren Inhalt, Auswahl und Scrollposition zur vorherigen Ansicht zurück.

Im Codex-Modus erhaelt der App Server das dynamische Werkzeug `codex_ide_workspace` fuer `list` und `read`. `list` liefert standardmaessig nur eine flache Ebene und kann per `path` und `depth` auf den relevanten Projektzweig begrenzt werden. Ein Read mit `purpose:"inspect"` stellt Abhaengigkeitskontext ohne neuen Tab bereit; nur `purpose:"edit"` oeffnet und fokussiert die Datei im Editor. Der Browser behaelt aber auch einen Inspect-Inhalt als exakten Editor-Ausgangsstand. Folgt spaeter ein `edit`, wird dieser Stand in einen sichtbaren Tab ueberfuehrt, statt den Request faelschlich gegen einen leeren Puffer zu pruefen. Fehlt jeder lokale Snapshot, liest die Editor-Laufzeit die Datei autonom ueber den begrenzten IDE-Lesekanal und aktiviert sie vor der Aenderung; geschrieben wird weiterhin erst sichtbar im Editor. Nach jedem Oeffnen oder Aendern gibt der Browser den tatsaechlich sichtbaren Puffer als turnlokalen Snapshot an den Agentenloop zurueck. Folge- und Recovery-Paesse verwenden ihn vor aelteren App-Server-Reads; fuer denselben Pfad wird ein alter Read entfernt, sobald ein neuer Browserpuffer vorliegt. Veraltetes `oldText` wird zunächst direkt gegen diesen neuesten sichtbaren Puffer neu zugeordnet und benötigt im Normalfall keinen weiteren Modellpass. Nur bei einer nicht zuverlässig auflösbaren Abweichung wird derselbe unveränderte aktuelle Puffer zur Reparaturbasis und der nächste Pass beginnt in einem frischen App-Server-Thread. Dieser Rückkanal liest ausschließlich den echten Editorzustand und erweitert keine Schreibrechte. Fuer Dateiinhalt und Projektstruktur bleibt `codex_ide_workspace` der einzige modellseitige Lesekanal. In `local` und `api` werden ausschließlich konkret benötigte vorhandene Dateien ueber `open` gelesen.

Vor jedem neuen Nutzerprompt synchronisiert die IDE den sichtbaren DOM-Inhalt in den Tabpuffer und uebergibt alle offenen Browserpuffer als autoritative Start-Snapshots. Ein Folgeauftrag erhaelt damit auch den neuen Inhalt nicht aktiver Tabs, ohne die persistente App-Server-Sitzung oder die Gespraechsfortsetzung aufzugeben.

Ein per `path` begrenztes Workspace-Listing beginnt direkt am angeforderten Ordner und traversiert nur die verlangte Tiefe. Dateien in anderen Projektzweigen verbrauchen dabei weder Scanzeit noch das Eintragslimit des Zielzweigs.

Der Workspace wird beim IDE-Start und nach Dateioperationen synchronisiert. Beim Absenden eines Turns verwendet die IDE diesen aktuellen Snapshot direkt und startet keinen zweiten blockierenden Komplettabgleich. Policy-Version 19 verlangt `workspaceTraversal: direct-scoped-bounded` und behaelt `editorStreaming: character-paced-real-time`, `editorCreate: atomic-new-file-only` sowie die bisherigen Editor- und Konsolenwerte bei. Aufgabenbestandteile werden semantisch der vorhandenen Projektebene zugeordnet: Darstellung und Layout der Markup-/Style-Struktur, Verhalten der Programmlogik und Dokumentation Markdown; eine Keyword-basierte CSS-Sonderbehandlung oder ein erzwungener Dateityp existiert nicht. Die Nutzernachricht enthaelt nur Kontextdaten und die aktuelle Aufgabe, waehrend Sprach-, Werkzeug- und Editorregeln einmal in der Systemrolle bleiben. Die Policy wird ueber den leichten `/gateway/status`-Endpunkt geprüft; dieser startet keinen `codex login status`-Prozess. Der ausdrückliche Auth-Button und `/codex/status` prüfen weiterhin die echte Anmeldung. Der native Codex-Prozess ist bei IDE-Turns schreibgeschützt: Auch unbegrenzt grosse oder neu zugeordnete lokale Änderungen müssen als strukturierte Aktion durch den sichtbaren Live-Editor laufen und werden erst danach über dessen Modell-Home-Kanal gespeichert. Native `apply_patch`- oder File-Change-Freigaben werden ohne Turnabbruch abgelehnt. Ein Schreiben per Shell oder Dateisystem am Editor vorbei bleibt auch in Recovery-Sitzungen ausgeschlossen.

Beispiele:

```json
{"operation":"list","path":"Repos/app","depth":1}
{"operation":"read","path":"Repos/app/src/config.js","purpose":"inspect"}
{"operation":"read","path":"Repos/app/src/main.js","purpose":"edit"}
```

### Native Live-Konsole

#### Nutzerkonsole

Die exakten Direktiven `/console start` und `/console close` werden bereits im Browser abgefangen und weder an ein Backendmodell gesendet noch im Agentenverlauf gespeichert. Nach `/console start` fuehrt das gewohnte Eingabefeld den ersten Text als Nutzerbefehl aus; **Senden** heisst dann **Ausfuehren**. Solange dieser Prozess laeuft, wechselt dasselbe Feld auf **Eingabe senden** und schreibt jede folgende Zeile einschließlich einer leeren Zeile an das aktive PTY. **Eingabe senden** und **Stoppen** bleiben gleichzeitig erreichbar. `/console close` bricht einen noch laufenden Prozess ab, beendet den Modus und blendet die Karte aus, ohne ihren sichtbaren Laufnachweis zu loeschen. Es laeuft jeweils hoechstens ein Nutzerbefehl. Ausgabe, eingegebene Zeilen, Arbeitsbereich, Exit-Code und Dauer erscheinen gestreamt in derselben Live-Konsole, aber mit der sichtbaren Herkunft **Nutzer** statt **Modell**. Nach einem Lauf wird der Dateibaum neu geladen.

Die Nutzerkonsole startet Befehle ueber `POST /codex-ide/console`; Programmeingaben gehen danach mit derselben Lauf-ID ueber `POST /codex-ide/console/input`. Beide Routen verlangen `X-Codex-IDE-Workspace: model-home` und `X-Codex-IDE-Console: user`. Sie arbeitet absichtlich im echten `model-home`: Der Runner verbindet stdin, stdout und stderr mit einem echten PTY und setzt zusaetzlich `PYTHONUNBUFFERED=1`. Dadurch erkennt Python eine interaktive Konsole, zeigt bereits ausgefuehrte Ausgaben vor dem jeweiligen `input()` in normaler Reihenfolge und setzt erst nach der eingegebenen Zeile fort. Nur in dieser Nutzer-Shell aktiviert `rm` rekursives Loeschen automatisch, sodass `rm alter-ordner` einen normalen verschachtelten Ordner entfernt; Optionen wie `-f` bleiben nutzbar. Der lokal gebaute Seccomp-Runner prueft trotzdem jede einzelne Schreib-, Loesch-, Umbenennungs- und Linkoperation und laesst Ziele nur innerhalb von `model-home` zu. `.git`, `node_modules`, `.env*`, das reservierte `memory.md`, Ziele außerhalb des Workspace sowie neue, ausbrechende oder dangling Symlinks bleiben gesperrt; Nicht-Unix-Netzwerksockets und Privilegwege sind weiterhin deaktiviert. Dieser ausdrueckliche Nutzerkanal veraendert die Rechte der Modellkonsole nicht.

```text
/console start
python3 script.py
Ada
rm alter-ordner
/console close
```

#### Modellkonsole

Im Codex-Profil darf das Modell in der nativen, netzwerkfreien Read-only-Sandbox eigenstaendig Syntaxchecks, Tests, Linter, Typpruefungen, Builds und weitere lokale Diagnosebefehle starten. Die IDE zeigt den vom Modell gestarteten Befehl, jede laufende stdout/stderr-Ausgabe, nachgereichtes stdin, Arbeitsbereich, Status, Exit-Code und Dauer in einer eigenen Konsole im sichtbaren Agenten-/Denkbereich. Ohne echten Konsolenlauf ist diese Karte vollstaendig verborgen; das erste Start-Event blendet sie zwischen Arbeitsnotizen und finaler Antwort ein und fuehrt sie in den sichtbaren Ausschnitt. Hostpfade werden fuer die Anzeige auf `model-home` normalisiert.

App-Server-JSONL sowie stdout/stderr verwenden zustandsbehaftete UTF-8-Decoder. Mehrbyteige Zeichen bleiben ueber Chunkgrenzen erhalten; ein Neustart verwirft unvollstaendige Daten des alten Prozesses. Lange Antwort- und Konsolendeltas werden linear in Chunks gesammelt. Die UI erweitert nur den vorhandenen Textknoten, und nach bereits gestreamter Ausgabe sendet das Abschlussereignis den Gesamttext nicht ein zweites Mal; ohne vorherige Deltas bleibt das Aggregat als Fallback erhalten.

Auf regulaeren Plattformen kommen Befehl und Ereignisstrom direkt aus der nativen Codex-App-Server-Konsole. Termux/PRoot kann die von Codex benoetigte `bubblewrap`-Sandbox nicht bereitstellen. Dort registriert der gleiche App-Server-Thread automatisch `codex_ide_terminal`: Die Bridge erstellt fuer jeden Pruefbefehl eine verworfene Kopie des Workspace. Jest, npm und andere Testwerkzeuge duerfen ausschließlich in einem laufbezogenen Temp-Verzeichnis Cache- und Arbeitsdateien schreiben; veraendert der Befehl die Workspace-Kopie, wird der Lauf als fehlgeschlagen markiert und die Kopie entfernt. Ein lokal gebauter Seccomp-Runner blockiert weiterhin Nicht-Unix-Netzwerksockets und Privilegwege. Start, Ausgabe und Abschluss verwenden dasselbe Live-Protokoll; `dangerFullAccess` wird nicht eingesetzt.

Jest folgt einem festen Projektweg. Das Modell liest zuerst eine vorhandene `package.json` ueber `codex_ide_workspace`: Ein dort deklariertes Jest-Testscript wird mit `npm test -- --runInBand`, ein anderes Testscript mit `npm test` ausgefuehrt. Nur wenn kein Testscript, aber eine lokale Jest-Abhaengigkeit deklariert ist, wird `npm exec --offline -- jest --runInBand` verwendet. Ohne deklarierte Testsuite meldet der Agent genau diesen Projektzustand und verwendet den passenden vorhandenen Syntaxcheck. `npx`, Paketinstallationen, absolute Hostpfade und das blinde Durchprobieren mehrerer Jest-Varianten sind ausgeschlossen.

Modellkonsolenlaeufe haben keine kuenstliche Laufzeit-, Aktions- oder Ausgabebegrenzung; auch ein 24-Stunden-Turn bleibt aktiv. Die Ausgabe wird nicht gekuerzt. Ein Befehl laeuft bis zu seinem echten Prozessende oder bis der Nutzer ausdruecklich **Stoppen** waehlt. Die Modellkonsole darf den echten Workspace nicht schreiben, loeschen oder verschieben und weder installieren, herunterladen noch das deaktivierte Netzwerk umgehen; ausschließlich laufbezogene Temp-Dateien sind erlaubt. Fehler werden ueber die vorhandenen sichtbaren Editoraktionen korrigiert und koennen danach erneut in derselben Konsole geprueft werden.

## Agentenloop

Die Modellantwort verwendet diese Steuerbloecke:

```text
<codex_ide_thought>kurze Arbeitsnotiz</codex_ide_thought>
<codex_ide_skill_request>{...}</codex_ide_skill_request>
<codex_ide_editor_request>{...}</codex_ide_editor_request>
<codex_ide_workspace_complete>{"complete":true}</codex_ide_workspace_complete>
<codex_ide_final>Antwort</codex_ide_final>
```

API-, Codex- und strukturierte lokale Workspace-Aufgaben werden nicht nach einer festen Aktions-, Reparatur- oder Laufzeitgrenze beendet. Unvollständige Editorblöcke, ungültiges JSON oder Audit-Schema, unsichere Pfade, mehrdeutige beziehungsweise zu große Edits und technische Editorfehler erhalten eine konkrete Reparaturdiagnose. Bleibt derselbe Schritt hängen, synchronisiert die Laufzeit den Workspace erneut, baut die Modellsitzung frisch auf und setzt denselben Turn ohne Limit über den sichtbaren Editor-Kanal fort. Aufeinanderfolgende Reparaturversuche aktualisieren eine einzige laufende Denk-Karte, statt identische Meldungen anzuhäufen.

Der Codex App Server streamt zusätzlich seine knappen modellverfassten Arbeitszusammenfassungen. Sie beschreiben aufgabenbezogen, was das Modell gerade untersucht, ändert oder prüft und warum; private Chain-of-Thought, interne Pfade und Rohinhalte bleiben verborgen. Strukturierte `codex_ide_thought`-Texte und native Zusammenfassungen werden innerhalb des Turns als bereits sichtbar registriert und den folgenden Modellpässen als nicht zu wiederholende Ausgabedaten mitgegeben. Identische beziehungsweise nahezu identische große „Ich …“-Blöcke werden nicht erneut angehängt. Solange noch kein materiell neuer Modelltext vorliegt, aktualisiert die IDE stattdessen dieselbe aktuelle Phasenkarte oder zeigt den konkreten protokoll- beziehungsweise laufzeitseitigen Reparaturgrund.

Nach Aktionen und Reparaturen folgt ein Vollstaendigkeitsaudit gegen Originalaufgabe, Workspace-Index und Aktionsledger. Konsolenlaeufe mit Exit-Code und Ergebnis gehoeren zu diesem Ledger; ein fehlgeschlagener Check muss korrigiert und erneut ausgefuehrt werden. Erst eine bestaetigte Vollstaendigkeit erlaubt die finale Antwort. Im lokalen Modus wird eine normale Modellausgabe in den Final-Steuerblock eingeordnet; echte strukturierte Skill- und Editoraktionen laufen weiterhin durch denselben unbegrenzten Recovery-Loop. Nur der ausdrueckliche Nutzerbefehl **Stoppen** beendet den gemeinsamen aktiven Turn.

## Skill-System

Unter **Einstellungen → Skills** stehen Installation, Deinstallation, Aktivierung, Backend-Profile, Rechte, Setup und Runtime-Pruefung zur Verfuegung. Das System gilt fuer `local`, `api` und `codex`.

Quellen:

- integrierte Manifeste aus `skills/`
- HTTPS-Manifest-URL
- lokales `.codexskill`-Paket
- lokales `manifest.json` plus deklarierter JavaScript-Einstiegspunkt

Externer Code wird nur nach sichtbarer Vertrauensbestaetigung installiert. Profile, Rechte, Konfiguration und Laufstatus werden lokal gespeichert. Skills erhalten nur die explizit erteilten Rechte. Der sichtbare IDE-Persistenzkanal ist kein vorgetaeschtes Skill-Ereignis.

Paketbefehle:

```bash
codex-ide skill validate skill_packages/PDF_Skill
codex-ide skill pack skill_packages/PDF_Skill
```

## Gateway-Routen

| Route | Aufgabe |
|---|---|
| `/health` | Dienststatus |
| `/gateway/status` | IDE-, Endpoint- und Workspace-Policy-Uebersicht ohne CLI-Logincheck |
| `/v1/models` | Codex-Modellkatalog |
| `/v1/chat/completions` | Completion/SSE |
| `/codex/status` | lokaler Loginstatus |
| `/codex/usage` | normalisierte verbleibende Codex-Tages-/Kurzzeit- und Wochenlimits |
| `/codex/sessions` | App-Server-Sitzungsdiagnose |
| `/codex/session/reset` | ausgewaehlte Sitzung zuruecksetzen |
| `/codex-ide/context` | begrenzter Kontext |
| `/codex-ide/memory` | reservierte Memory-Operationen |
| `/codex-ide/files` | Basis-Textdateien |
| `/codex-ide/workspace` | sicherer Workspace-Index |
| `/codex-ide/extended-files` | rechtegebundene Code-Skill-Dateien |
| `/codex-ide/ide-files` | sichtbare Editor-Lese-/Schreib-/Mkdir-Aktionen |
| `/codex-ide/pdf-files` | rechtegebundener PDF-Transport |

Alle API-Antworten sind `no-store`. Ohne explizite Origin-Allowlist akzeptiert das Gateway als Browser-Host nur `localhost` oder ein IP-Literal; ein fremder DNS-Name kann daher nicht mit einem passend gefaelschten Same-Origin-Paar auf Loopback zugreifen. HTTP-JSON behaelt mehrbyteige UTF-8-Zeichen auch dann korrekt, wenn deren Bytes auf mehrere Transport-Chunks verteilt sind. Die statische Allowlist enthaelt nur die fuer den IDE-Start benoetigten Dateien und prueft ihr aufgeloestes Ziel erneut gegen die App-Shell-Wurzel. `model-home`, Scripts, Tests und Projektdokumente werden nicht statisch ausgeliefert.

## PWA

`sw.js` cached die Standalone-App-Shell unter `codex-ide-v47`. Gateway-Routen umgehen den Cache. Die Worker-Pruefung verwendet `updateViaCache: none`; bei einem Update bleibt der neue Worker wartend, bis der Nutzer die Installation bestaetigt. Danach werden die Shell-Dateien mit `cache: reload` geladen und die Seite beim Controller-Wechsel einmal neu geladen. Ein noch mit altem JavaScript laufender Client ohne diesen Listener wird vom neuen Worker nach der bestaetigten Aktivierung einmal selbst neu navigiert. `codex-ide clean` oeffnet eine Bereinigungs-URL, die Worker abmeldet und Cache Storage leert, ohne Browser-Einstellungen, Skill-Zustand oder Workspace-Daten zu loeschen. Der PWA-Download und das npm-Paketupdate bleiben getrennte, jeweils bestaetigte Vorgaenge: npm ersetzt die installierten Quelldateien, der Service Worker aktiviert danach die neu ausgelieferte Browser-Shell.

## Tests

Die Jest-Release-Suite ignoriert `model-home/`, weil dessen Inhalte Nutzerdaten und keine Tests der Codex-IDE-App sind. Eigene dort abgelegte Testdateien bleiben unveraendert und koennen mit den Werkzeugen ihres jeweiligen Projekts separat ausgefuehrt werden.

```bash
npm run pwa:validate
npm test -- --runInBand
node --test skill_packages/GitHub_Repo_Skill/runtime-checks.js
```

Syntaxpruefungen und die vollstaendige Liste stehen in `agents.md`.
