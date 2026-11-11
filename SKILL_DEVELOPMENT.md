# Skills entwickeln und veröffentlichen

Codex IDE kann zusätzliche Skills direkt über **Einstellungen → Skills** aus einer Manifest-URL, einem portablen `.codexskill`-Paket oder lokalen Entwicklungsdateien installieren. Ein späterer Skill-Hub kann geprüfte Manifest-URLs und Offline-Pakete katalogisieren; die Installations-, Rechte- und Laufzeitlogik bleibt in der App.

Die drei mitgelieferten Skills `internet.research`, `workspace.extended-files` und `learning.codex-ide` sind geschützte Standard-Skills. Sie können deaktiviert und konfiguriert, aber weder deinstalliert noch durch ein fremdes Manifest überschrieben werden.

## Sicherheitsmodell

Ein Skill-Einstiegspunkt ist JavaScript und läuft im selben Browserkontext wie Codex IDE. Rechte im Manifest sind Freigaben für den Agentenloop und für die an `run()` übergebenen Daten; sie sind **keine JavaScript-Sandbox**. Nutzer müssen deshalb vor jeder URL-Installation bestätigen, dass sie der Quelle vertrauen.

- Manifest und Einstiegspunkt benötigen HTTPS. HTTP ist nur für dieselbe Origin sowie `localhost`, `127.0.0.1` oder `[::1]` erlaubt.
- Ein optionales Subresource-Integrity-Feld wie `"integrity": "sha384-…"` schützt den Einstiegspunkt gegen unbemerkte Änderungen.
- Die Manifestantwort benötigt für eine fremde Origin einen passenden CORS-Header. Ein klassisches Einstiegsskript kann originübergreifend geladen werden.
- Secrets gehören nie in Manifest, Quelltext, Übersetzungen oder Hub-Metadaten. Setup-Werte bleiben im Browser.
- Deinstallation entfernt Manifest, Konfiguration, Rechte, Runtime-Registrierung und Script-Element. Bereits ausgeführte Seiteneffekte von Fremdcode lassen sich im Browser nicht zuverlässig rückgängig machen; nach einer Deinstallation ist ein Neuladen sinnvoll.
- Der Service Worker nimmt fremde Origins nicht in die App-Shell auf. Ein gehosteter Skill sollte passende HTTP-Cache-Header liefern. Ein `.codexskill`-Paket ist nach der lokalen Installation ohne Hosting verfügbar, ist derzeit aber nicht signiert und benötigt dieselbe Vertrauensbestätigung wie eine URL-Installation.

## Manifest Version 1

Das folgende Manifest ist vollständig installierbar:

```json
{
  "schemaVersion": 1,
  "id": "example.community-notes",
  "name": "Community Notes",
  "displayName": {
    "de": "Community-Notizen",
    "en": "Community Notes",
    "fr": "Notes communautaires"
  },
  "description": {
    "de": "Lädt freigegebene Notizen als Antwortkontext.",
    "en": "Loads approved notes as answer context.",
    "fr": "Charge des notes approuvées comme contexte de réponse."
  },
  "version": "1.0.0",
  "entrypoint": "./index.js",
  "defaultEnabled": false,
  "profiles": ["local", "api", "codex"],
  "permissions": [
    {
      "id": "network",
      "label": { "de": "Netzwerk", "en": "Network", "fr": "Réseau" },
      "description": {
        "de": "Darf den angegebenen Dienst aufrufen.",
        "en": "May call the configured service.",
        "fr": "Peut appeler le service configuré."
      },
      "required": true,
      "defaultGranted": false
    }
  ],
  "setup": [
    {
      "id": "endpoint",
      "type": "text",
      "label": { "de": "Endpunkt", "en": "Endpoint", "fr": "Point d’accès" },
      "permission": "network"
    }
  ],
  "agent": {
    "description": {
      "de": "Findet Notizen zu einem Thema.",
      "en": "Finds notes about a topic.",
      "fr": "Trouve des notes sur un sujet."
    },
    "instructions": {
      "de": "Nur verwenden, wenn freigegebene Community-Notizen helfen.",
      "en": "Use only when approved community notes would help.",
      "fr": "Utiliser uniquement si des notes communautaires approuvées sont utiles."
    },
    "resultType": "context",
    "parameters": [
      {
        "id": "topic",
        "type": "string",
        "required": true,
        "maxLength": 200,
        "description": { "de": "Thema", "en": "Topic", "fr": "Sujet" }
      }
    ]
  }
}
```

Pflichtfelder sind `schemaVersion`, `id`, `name`, `version`, `entrypoint`, `profiles`, `permissions` und bei installierbaren Fremd-Skills `agent`. Die ID ist dauerhaft, kleingeschrieben und darf Punkt, Bindestrich oder Unterstrich enthalten. Die Version folgt SemVer. Relative Einstiegspunkte werden relativ zur Manifest-URL aufgelöst.

`displayName`, `description`, Beschriftungen, Parameterbeschreibungen sowie `agent.description` und `agent.instructions` können entweder ein String oder ein Objekt mit `de`, `en` und `fr` sein. Für veröffentlichte Skills sollten alle drei Sprachen enthalten sein. Projektinterne Standard-Skills dürfen weiterhin zentrale `*Key`-Übersetzungsschlüssel verwenden.

`setup` unterstützt `text`, `password` und `select`. Ist ein Feld an `permission` gebunden, fehlt es im Laufzeitkontext, solange dieses Recht nicht erteilt wurde. `agent.parameters` unterstützt `string`, `number` und `boolean`, optionale `enum`-Werte und bei Strings `maxLength`. Optionale `agent.permissionRules` ordnen einer Parameterbedingung wie `{ "parameter": "operation", "equals": "read", "permission": "readFile" }` ein manifestdefiniertes Recht zu. Ein passender Aufruf wird dann vor dem Runtime-Start blockiert, solange dieses Recht fehlt. Nicht deklarierte Parameter, falsche Typen, fehlende Pflichtwerte und unbekannte Skills werden vor der Ausführung verworfen.

Externe Skills werden unabhängig von ihren Manifest-Defaults zunächst deaktiviert installiert; alle Rechte sind zunächst entzogen. Erst die ausdrücklichen UI-Freigaben machen sie für den Agentenloop verfügbar. Der Einstiegspunkt wird bereits zur Installation und bei späteren App-Starts geladen, damit er seine Runtime registrieren kann — deshalb ist die Vertrauensbestätigung die eigentliche Code-Vertrauensgrenze.

`resultType` ist entweder:

- `context`: normaler Arbeitskontext; die UI zeigt „Zugriff abgeschlossen“.
- `sources`: Quellenkontext; `resultCount` muss exakt der Zahl der wirklich an das Modell übergebenen Quellen entsprechen. Bei null Quellen verbietet der finale Modellschritt Quellenangaben und geerbte URLs.

Für `sources` muss `resultCount` technisch als endliche, nichtnegative Ganzzahl zurückgegeben werden. `null`, numerische Strings, negative Werte und Dezimalzahlen werden als fehlerhafte Runtime-Antwort abgelehnt.

Zusaetzliche Agenten-Skills koennen in allen drei agentischen Profilen `local`, `api` und `codex` laufen. Das Manifest darf die Verfuegbarkeit auf eine Teilmenge begrenzen; der gemeinsame mehrstufige Tool-Loop und die sichtbaren Rechtepruefungen bleiben in jedem Modus erhalten.

## Einstiegspunkt

Der Einstiegspunkt registriert synchron genau die Manifest-ID:

```js
(function () {
  'use strict';

  window.CodexIdeSkillSystem.registerRuntime('example.community-notes', {
    async run(request, context) {
      const response = await fetch(
        context.config.endpoint + '?topic=' + encodeURIComponent(request.topic),
        { signal: context.signal }
      );
      if (!response.ok) throw new Error('Notizdienst nicht erreichbar');
      const data = await response.json();
      const notes = Array.isArray(data.notes) ? data.notes.slice(0, 10) : [];
      return {
        context: notes.length
          ? notes.map((note, index) => `[${index + 1}] ${String(note).slice(0, 1000)}`).join('\n')
          : 'Keine passenden Community-Notizen gefunden.'
      };
    }
  });
})();
```

`request` enthält nur validierte, deklarierte Parameter. `context` enthält `language`, `profile`, `config`, `permissions` und `signal`. Die Runtime gibt `{ context }` zurück; bei `resultType: "sources"` zusätzlich `{ resultCount }`. Der Kontext ist auf 120.000 Zeichen begrenzt. HTML sollte nicht erzeugt werden, fremde Daten müssen vor der Rückgabe normalisiert werden, und Abbruchsignale sollten an Netzwerk- oder Gateway-Aufrufe weitergereicht werden.

Jede Runtime, die `fetch` oder einen anderen Netzwerkkanal verwendet, muss das erforderliche Manifestrecht mit der stabilen ID `network` deklarieren. Solche Skills bleiben auch im lokalen Codex-IDE-Workspace nach Installation, Aktivierung, Profilfreigabe und ausdruecklicher Nutzerberechtigung agentensichtbar und ausfuehrbar. Jeder tatsaechliche oder blockierte Request wird sichtbar gemeldet; ein blockierter Request darf nicht lautlos verworfen oder wiederholt werden. Die native Codex-Websuche bleibt dort getrennt deaktiviert. Netzwerk-Skills duerfen niemals verwendet werden, um bereits lokale Workspace-Inhalte zu suchen oder zu ersetzen.

Binäre Modell-Home-Dateien sind nicht über den allgemeinen Dateiendpunkt verfügbar. Der reservierte Endpunkt `GET|POST /codex-ide/pdf-files` ist für den separat installierbaren Skill `workspace.pdf` vorgesehen: Er verlangt `X-Codex-IDE-Skill: workspace.pdf`, je nach Methode `X-Codex-IDE-Permission: readPdf` oder `writePdf`, relative `.pdf`-Pfade und Base64-Daten bis standardmäßig 5 MiB. Diese Header sind Teil der vertrauensbasierten JavaScript-Grenze und ersetzen keine Sandbox; die Runtime muss zusätzlich `context.permissions` prüfen. Ein vollständiges Offline-Beispiel steht unter `skill_packages/PDF_Skill`.

## Lokal entwickeln und als Offline-Paket testen

Ein Entwicklungsordner enthält mindestens `manifest.json` und den darin relativ angegebenen JavaScript-Einstiegspunkt. Prüfen und packen:

```bash
codex-ide skill validate ./mein-skill
codex-ide skill pack ./mein-skill
```

`validate` deckt die Manifestformen ab, die auch die Browser-Registry ablehnt. `pack` akzeptiert nur eine `.codexskill`-Ausgabedatei und folgt keinem Einstiegspunkt-Symlink aus dem Skill-Ordner heraus. Schlägt die Runtime-Registrierung bei einem Update fehl, arbeitet die installierte Vorgängerversion mit unverändertem Manifest-, Rechte- und Profilzustand weiter.

`pack` erzeugt standardmäßig `<id>-<version>.codexskill` im Skill-Ordner. Das JSON-Paket besitzt exakt diese Hülle:

```json
{
  "packageVersion": 1,
  "manifest": { "schemaVersion": 1 },
  "entrypointSource": "/* Inhalt des deklarierten Einstiegspunkts */"
}
```

Der Einstiegspunkt muss relativ und traversal-frei sein, auf `.js` enden und darf keine URL, Query oder Fragment enthalten. Das Paket unterstützt einen Einstiegspunkt bis 500.000 Zeichen; weitere per relativer URL importierte Dateien sind nicht eingebettet. Ist `integrity` im Manifest gesetzt, wird die Prüfsumme auch beim lokalen Import vor der Ausführung kontrolliert. Zum schnellen Entwicklungszyklus können statt des Pakets `manifest.json` und der deklarierte `.js`-Einstiegspunkt gemeinsam in der Dateiauswahl gewählt werden.

In **Einstellungen → Skills** Vertrauen bestätigen, lokale Dateien wählen, Skill aktivieren, Profil und Rechte setzen und **Bereitschaft prüfen** wählen. Diese Prüfung kontrolliert Runtime-Registrierung und Sichtbarkeit für das aktive Profil, führt aber `run()` nicht aus und erzeugt deshalb keinen vorgetäuschten Eintrag unter Punkt 2. Erst eine semantisch passende Chat-Anfrage testet den vollständigen generativen Agentenloop.

## Installation, Update und Deinstallation

1. `manifest.json` und Einstiegspunkt auf einer vertrauenswürdigen HTTPS-Origin veröffentlichen oder ein `.codexskill`-Paket erstellen.
2. **Einstellungen → Skills** öffnen und die Manifest-URL einfügen oder die lokale Datei auswählen.
3. Vertrauen bestätigen und **Installieren** wählen.
4. Skill aktivieren, Profile auswählen, nur notwendige Rechte erteilen und Setup speichern.
5. Mit einer semantisch passenden Anfrage testen.

Eine erneute Installation derselben ID aktualisiert Manifest und Einstiegspunkt; Autoren sollten die Version erhöhen. Bei gehosteten Skills sollte sich möglichst auch die Einstiegspunkt-URL ändern. Fremd-Manifeste und der für Offline-Pakete nötige lokale Einstiegspunkt liegen unter `codexIdeInstalledSkillManifestsV1`, Zustände unter `codexIdeSkillStatesV1`. Eine Deinstallation löscht beides für diese ID.

Jeder echte Lauf erscheint im Antwortweg als `1. Denkweise`, `2. Skill-Zugriff` und `3. Finale Antwort`. Punkt 2 entsteht ausschließlich aus Laufzeitereignissen, nie aus Modelltext. Blockierte Aufrufe heißen „nicht gestartet“, technische Ausnahmen „fehlgeschlagen“.

## Veröffentlichung und späterer Hub

Ein Hub-Eintrag sollte mindestens Manifest-URL, ID, Version, Autor, Lizenz, unterstützte Sprachen, Prüfsumme/Signatur, verlangte Rechte und Prüfstatus enthalten. Der Hub darf niemals Rechte automatisch erteilen. Ein Installationslink kann die Manifest-URL in die UI übertragen, die Vertrauensbestätigung und Rechteauswahl bleiben aber beim Nutzer.

Vor Veröffentlichung sollten Manifestvalidierung, erlaubte und abgelehnte Requests, Rechteentzug, fehlende Setup-Werte, Abbruch, Netzwerkfehler, Nulltreffer, korrekte Quellenzahl, Deinstallation und DE/EN/FR-Ausgabe getestet werden.
