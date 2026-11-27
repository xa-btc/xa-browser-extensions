# Diagnostics and operation

## Browser errors and unexpected reloads (0.2.0)

If already installed from this project folder, click **Reload** for XA Extension Observation at `brave://extensions`, then reopen its window. Do not uninstall it: existing inventory history, imports, and runtime settings are retained. Diagnostics start off. Enabling navigation monitoring requests its optional permissions. If the native companion is connected, disconnect and reconnect Runtime calls so its updated source can also report browser-process warnings and errors; registration does not need to change when its location and extension ID are unchanged.

1. Open **Browser diagnostics** and click **Enable diagnostics**. Grant the optional `tabs` and `webNavigation` permissions. This records top-level document navigation, browser-classified reloads, navigation failures, and tab discard/restore signals across ordinary HTTP/HTTPS tabs in this profile.
2. Select the problem tab and click **Capture selected tab**. Brave displays its debugging banner when the extension attaches. Capture records JavaScript exceptions, console errors/warnings, browser log entries, HTTP errors, failed requests, document request initiators, navigation reasons, and WebSocket errors/closures. Up to five tabs can be captured. No native helper or diagnostic browser restart is needed for these tab features.
3. Reproduce the issue, then expand a record to see its evidence, the preceding ten seconds of events in that tab, and nearby extension calls if the runtime companion was collecting them. Records survive page reloads. Use search/category/tab filters and **Export JSON** to keep the full retained history.

Some script refreshes appear as `link` navigations in the basic browser API. Detailed capture additionally matches `Page.frameStartedNavigating` with the committed document’s loader ID. When available, this distinguishes `reload` from `reloadBypassingCache` using the browser’s explicit classification. A requested navigation can be canceled, so it is not counted as a completed reload until the matching document commits. A normal navigation, chart reconnect or WebSocket closure is not automatically counted as a reload. Older Brave versions or events outside the capture interval may lack these signals.

**Reload selected tab** and **Reload bypassing cache** are explicit user actions that immediately reload that tab and can discard unsaved page input. They are tagged as Observatory requests in the evidence. The monitor never reloads pages automatically. Cache bypass does not mean cookies, storage or service workers are cleared, and absence of a cache hit does not prove a hard reload.

Evidence is deliberately qualified. `ERR_BLOCKED_BY_CLIENT` suggests a client-side block but does not identify an extension or distinguish Shields. DNS, connection, certificate, HTTP 429 and server-error hints describe the observed failure class. Console warnings alone do not establish a reload cause. An extension URL in a document initiator stack is direct source evidence for that request. Nearby `tabs.reload`, `tabs.update`, `tabs.discard` or `tabs.remove` calls are labeled correlations; explicit other-tab calls are excluded when readable arguments provide a target. Matching tab IDs establish a request, not success or causation. Native receipt times may be buffered and the process log can span profiles.

Enable diagnostics and connect **Runtime calls** to additionally stream WARNING/ERROR/FATAL entries from the companion’s configured browser log. These process-level messages retain their component and severity but are not assigned to a tab or extension. The source log can contain unrelated diagnostics and sensitive message text. Native logging remains subject to its existing setup and shutdown rules below.

Detailed capture may affect timing. DevTools, another debugger, permission revocation, target closure or leaving HTTP/HTTPS can interrupt it; detach status is recorded. Pause/disable stops captures, and resuming does not silently reattach them. Captures can be recovered across worker suspension within the same browser session when the attachment still exists; tab selections are not reused across a full browser restart. Separately running cross-origin frame/worker targets, browser UI, full-browser crashes and OS faults are not fully covered. A crash record appears only if the attached target emits a supported crash event.

Diagnostics are stored separately, bounded to 1,000 records / 1 MB; the view renders the newest 150 matches. High-frequency tab events are batched every 250 ms, with a 200-event buffer and an explicit overflow record if a burst exceeds it. Structured URLs and stack URLs omit credentials, query strings and fragments. Console text, exceptions and process-log messages may still contain private data. No response bodies, request bodies, cookies or headers are collected. Existing source logs and retained runtime arguments follow their separate controls. Export includes retained diagnostics.

## Enable live API records

The companion requires Node.js 20.11+ on Windows. Keep the extracted project folder in a stable location. Open **Runtime calls** in Observatory; it displays a registration command containing the correct monitor extension ID. In PowerShell, from the project folder, run that command:

```powershell
# Run from the project folder.
.\native\Register-Host.ps1 -ExtensionId 'PASTE_THE_32_CHARACTER_MONITOR_ID_HERE'
```

Exit Brave fully, including background processes, and start a diagnostic session:

```powershell
.\native\Start-BraveLogging.ps1
```

The launcher refuses to proceed while Brave is already running because an existing process ignores newly supplied logging flags. It does not kill browser processes. For another profile, use `-ProfileDirectory 'Profile 1'`; obtain the directory name from **Profile Path** at `brave://version`. For a different executable location, pass `-BravePath 'D:\path\to\brave.exe'`. The launcher uses Brave’s normal user-data directory.

Reopen Observatory, go to **Runtime calls**, and click **Connect runtime log**. Accept the optional native messaging permission. After the status reads **Connected to diagnostic log**, use another extension; supported records appear as Brave writes them. Filter by extension name, ID, API, category, or captured details, and expand a record for its source fields. `commands.onCommand` records can appear when Brave logs command events; declarations and execution records are separate views.

By default, Observatory retains API names, categories, extension IDs, browser timestamp text and receipt timestamps. Enable **Include API arguments & URLs**, then click **Reconnect runtime log** to retain additional details for future records. This checkbox does not delete details already retained. Arguments are raw diagnostic text, capped at 8,192 characters per record with a truncation flag; they are not return values or proof of success.

**Brave’s source diagnostic log may contain sensitive URLs and API arguments even when Observatory’s details checkbox is off.** The flags also enable Chromium’s extension activity database. Both can grow while the diagnostic session runs. The monitor’s bounded retention does not cap these source files, and the project does not automatically delete browser-owned data or logs.

**Pause monitoring** or **Disconnect** stops this collector; it does not stop Brave’s diagnostic logging. To stop browser logging, exit Brave fully and launch it normally. Diagnostic files remain under `native\runtime-logs`; the browser-owned `Extension Activity` database resides in the profile. Review or remove unneeded diagnostic files only after Brave has exited. To unregister the companion, run `native\Unregister-Host.ps1`; it preserves logs and configuration. Revoking the optional permission also prevents native connections.

Registration writes this host’s two current-user native-messaging registry keys for Brave and Chromium-compatible discovery, with an allowlist containing only the supplied extension origin. The host checks that origin again, reads only its configured log, and accepts no arbitrary file path, shell command or SQL input. It uses no network listener. Development tests use temporary profiles and unique host registrations removed afterward; the normal browser profile is not modified or restarted.

## Runtime coverage and limits

- Records come from Chromium’s `activity_log.cc` stream, with categories such as `api_call`, `api_event_callback`, `content_script`, `dom_access`, `dom_event` and `webrequest`, when emitted. This internal diagnostic format can change with Brave versions. Unknown-format lines are ignored; no records does not prove inactivity.
- Each connection starts at the end of the file. Earlier sessions, pauses, disconnects and inventory-triggered reconnections are not replayed. Starts and rotations appear in the lifecycle log. Truncation or replacement is detected, after which reading resumes at the new file’s beginning.
- Runtime logs belong to a Brave process, not a single profile. IDs match the current inventory, but an identical extension ID in another open profile cannot be distinguished. Keep other profiles closed for clear attribution. Hidden/internal extensions absent from public inventory are excluded.
- The reader polls once per second, reads up to 256 KiB per poll, and returns up to 100 events / 200 KB of event JSON per batch. Unread backlog is retained and queued bytes are reported. Lines over 256 KiB are skipped with a lifecycle notice. High rates can create a backlog; capture is not guaranteed lossless.
- Browser timestamps preserve the original month/day and time because the prefix omits timezone and year. `receivedAt` is receipt time. Up to 1,000 runtime records or 2 MB are retained, with a discarded-record counter. The view shows the newest 250 matches; exports contain the complete retained log.
- Request bodies/responses, every DOM access, arbitrary native code, command success, CPU/memory and definitive runtime-active state are not provided. Brave can omit, redact or transform records. Incognito operation is not supported by this extension, but source diagnostic logs may contain browser-emitted incognito markers if such windows are used.

## Import declared commands and scripts

Use **Coverage & imports → Choose Extensions folder** and select the current profile’s `Extensions` folder. The default Windows location is `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Extensions`. For another profile or custom user-data directory, find **Profile Path** at `brave://version` and append `Extensions`.

Only matching `manifest.json` files are read. The importer does not read script source, preferences, cookies, history or extension storage. IDs and versions must match live inventory; old version folders are skipped. A batch is limited to 1,000 manifests / 2 MB, and stored projected imports have a separate 2 MB cap. Use smaller subfolders if needed.

For an unpacked extension, select it, open **Commands**, and choose **Import manifest**. This associates the selected file with that extension; matching versions do not authenticate it. Imported code is never executed. Localized `__MSG_...__` strings stay literal because locale catalogs are not read.

Imports show commands, suggested Windows shortcuts, content-script matches/exclusions, background files, optional permissions and external-connection declarations. Reimport after updates or same-version source edits; version mismatches are labeled outdated. Suggested keys may differ from current assignments at `brave://extensions/shortcuts`. Static manifests do not show dynamically registered scripts or every programmatic injection.

## Access and change monitoring

The management API supplies installed extensions, versions, enabled state, install type, API permissions and host patterns in this profile. Themes, apps and Observatory itself are excluded. Permissions describe capabilities, not evidence of use. Site-level withholding and incognito/file-access switches are not resolved. **Notable access** highlights selected sensitive capabilities as an inspection aid, not a maliciousness score.

Listeners record install, enable, disable and uninstall events while monitoring is on. Snapshots detect version and access differences approximately every minute, on worker activation and on refresh. Snapshot times indicate observation, not exact execution. After gaps the latest state is reconciled; intermediate actions cannot be recovered. Inventory searches match names, IDs, descriptions, permissions and hosts; history rows expand to exact before/after details.

Lifecycle history retains up to 2,000 records / 3 MB, independently of runtime records. Oldest records are discarded at either limit. Saved state has an 8 MB guard below normal local-storage quota. Failed scans preserve the last successful inventory. Writes are serialized to prevent overlapping events and imports overwriting each other. Browser scheduling can delay scans.

## Console commands

| Command | Action |
| --- | --- |
| `help` | List commands. |
| `list`, `list enabled`, `list disabled` | Print inventory. |
| `inspect <name or id>` | Select one extension and print its inventory. |
| `search <text>` | Filter inventory. |
| `events <text>` | Filter lifecycle/change history. |
| `runtime <text>` | Filter browser-logged runtime records. |
| `diagnostics <text>` | Open and filter browser errors, navigation, and reload evidence. |
| `refresh` | Reconcile inventory while monitoring is enabled. |
| `pause`, `resume` | Stop or start monitoring and runtime collection. |
| `coverage` | Open coverage and imports. |
| `export` | Download inventory, imports, coverage and retained logs as JSON. |
| `clear` | Clear console output only. |

The console does not evaluate JavaScript, execute OS commands or invoke other extensions’ commands. Up/Down recall up to 50 commands. Dedicated clear-history, clear-runtime and remove-imports controls confirm before removing monitor data; they do not clear source diagnostic files.

## Permissions and local data

The base extension requests `management`, `storage`, `alarms` and `debugger`. The management permission also permits disabling or uninstalling extensions, but this application never calls those mutation APIs. The companion requests native messaging on demand. Navigation diagnostics request tabs and webNavigation on demand. Brave requires debugger permission at installation. Detailed capture starts when you select a tab and click **Capture selected tab**. No host permissions, injected content scripts or remote debugging port are used. Capture does not evaluate page JavaScript or change page network settings. Content Security Policy blocks the monitor page’s network connections and remote scripts.

Inventory, imports and retained logs stay in this profile’s `chrome.storage.local`; companion configuration and diagnostics stay on disk. There are no uploads, analytics or remote runtime dependencies. Exports include retained arguments when enabled. Uninstalling the extension clears its storage but leaves the companion and diagnostic files. Generated host configuration, launchers and logs are Git-ignored and excluded from packages.

## Development and validation

Use Node.js 20.11+, then run `npm ci`, `npm test`, `npm run check`, and `npm run test:browser`. Browser tests use installed Brave with temporary profiles and synthetic extensions. They cover inventory, lifecycle, imports, window launch, export, responsive layout and restart persistence; real diagnostic API calls through a unique temporary native host; and an HTTP fixture with actual console/JavaScript errors, failed requests, script reloads, and cache-bypassing reloads. Browser-process log forwarding is checked with an explicitly synthetic warning appended to the test log. Test copies pre-grant optional permissions for automation; production retains the browser prompts the user approves. Set `BRAVE_EXECUTABLE` for another installation path.

`npm run package` creates `dist/XA-Extension-Observation-0.2.0.zip` containing the extension, companion source/setup scripts and README. Tests, profiles, dependencies, generated configuration and diagnostic logs are excluded. No build is needed to load the unpacked extension. The package is not installed into the normal Brave profile automatically.

## API references

- [Management API](https://developer.chrome.com/docs/extensions/reference/api/management) supplies inventory and lifecycle events.
- [Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands) exposes registered commands to the calling extension itself.
- [Web navigation API](https://developer.chrome.com/docs/extensions/reference/api/webNavigation) supplies the top-level navigation timeline, while the [debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) exposes selected-tab protocol events. [Page protocol definitions](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json) describe navigation-start types and committed loader IDs.
- [Chromium activity logging](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/activity_log/activity_log.cc) enables diagnostic activity and prints records in testing mode; [record formatting](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/activity_log/activity_actions.cc) defines the stream parsed by the companion.
- [API feature definitions](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/extensions/api/_api_features.json) and [private permissions](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/extensions/api/_permission_features.json) restrict direct activity-log API access.
