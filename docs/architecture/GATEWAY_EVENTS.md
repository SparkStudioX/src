# Gateway events workshop

Gateway events execute Python on the gateway without an operator browser. Open **Designer → Scripting → Gateway events** to add an event or select one from the resource tree. Every new event starts disabled. Select its trigger, configure its properties, review the code, enable it deliberately, then **Save resources → Publish scripts**. Saving a draft does not replace the active script publication. Publishing screens is a separate operation and does not publish script resources.

This feature requires the companion SparkStudio **0.2.0-preview.9** release or a newer compatible gateway; preview.8 and earlier do not contain these additions. Scripts use CPython 3, with no Java or Jython scripting dependency. They run with the gateway account's OS access. Python workers, deadlines and execution lanes are reliability controls, not a sandbox for untrusted code.

## Event types

| Type | Trigger and properties |
| --- | --- |
| Startup | Activating a script publication, including gateway restart or project restoration. Startup handlers run in declaration order before recurring work is accepted. Repeating publication of an unchanged revision does not restart it. |
| Update | The currently published handler observes successful script, project and query saves, asset additions, and changed screen/project publications. Its context identifies the actor and resource changes. A draft save never executes that draft's code. Script publication activates a new generation and is not a separate Update notification. |
| Shutdown | Best-effort work for the old publication during orderly gateway stop, project archive or script-publication replacement. The aggregate shutdown budget is ten seconds; each resource's own timeout may be shorter. A forced process kill or power loss cannot execute this handler. |
| Timer | An interval from 100 to 86,400,000 milliseconds. **Fixed delay** waits the interval after completion. **Fixed rate** follows its interval schedule, skipping missed opportunities when work is late; it never catches up with a burst of queued timer runs. |
| Tag change | One to 64 unique absolute tag paths, such as `[default]Workshop/GatewayEvents/Counter`. A terminal `folder/*` watches that folder. Select value, quality and/or timestamp changes. The initial sample sets `initialChange`; later runs include previous and current qualified values. |
| Message handler | A named published handler with JSON payload. The resource's name is the handler name. Its required permission is **Project Operate** or **Gateway administrator**. Disabled or unpublished handlers cannot receive requests. |
| Scheduled | Five numeric cron fields: minute, hour, day of month, month, day of week. Choose a gateway-supported time zone. New schedules in Designer start with UTC; an omitted zone in the saved format defaults to the gateway's local zone. `0 2 * * *` runs at 02:00 in that zone; `*/5 * * * *` runs every five minutes. |

Cron accepts numeric lists, ranges and positive steps; Sunday can be 0 or 7. If neither day-of-month nor day-of-week starts with `*`, either match selects the day; otherwise both fields must match. Schedules skip occurrences missed during gateway downtime. A nonexistent local minute at daylight-saving transition does not run; a repeated local minute runs once, at its earlier UTC occurrence. There is no durable queue that replays missed schedules after restart.

Each gateway event has a timeout from **100 to 300,000 milliseconds**, default **10,000**. **Dedicated** execution, the default, allows separate resources to run independently. **Shared** places resources on the project's shared FIFO execution lane. A single resource never overlaps itself. Tag-change work is bounded and may be dropped while a handler is busy; inspect `missedEvents` instead of assuming every intermediate value was delivered. The count includes conservative upstream notification-loss estimates shared across the project's tag handlers, so it is not an exact count of changes to one watched tag. Do not use these scripts as a deterministic control loop.

## Python context

Gateway scripts receive `parameters` for their declared scalar defaults and `event` for the trigger context. The event supports both dictionary lookup and attribute access. Context fields include:

| Field | Meaning |
| --- | --- |
| `type`, `reason`, `timestamp` | Event kind, activation/update reason and timestamp |
| `actor` | The triggering user or gateway identity |
| `projectId` | The project that owns the running handler |
| `resources` | Update details such as added, removed and modified resources |
| `executionCount` | Zero-based execution index for the active resource generation; the first run receives 0 |
| `tagPath`, `initialChange` | Changed tag and whether this is its initial sample |
| `previousValue`, `newValue` | Qualified values including value, quality and timestamp |
| `changes`, `missedEvents` | Changed tag attributes and missed-event information |
| `payload` | The message request's JSON object |

The `payload` variable is also available directly for messages. Tag-change aliases include `tagPath`, `initialChange`, `previousValue`, `newValue`, `changes` and `missedEvents`. Qualified values expose `.value`, `.quality` and `.timestamp`, or `getValue()`, `getQuality()` and `getTimestamp()`. Extract their JSON-compatible fields before returning a result: for example, `newValue.value`, `str(newValue.quality)` and `newValue.timestamp.isoformat()`. Fields specific to another trigger may be absent; use `event.get("field")` when writing code shared by several triggers. Assign `result` to return a JSON-compatible value, or write diagnostics with `print` or `system.util.getLogger`.

```python
logger = system.util.getLogger("workshop.events")
logger.info("Event: " + event.type)
result = {"reason": event.reason, "timestamp": event.timestamp}
```

Each invocation uses a fresh Python worker. Module globals do not persist between runs. Use explicitly configured memory tags or a database when persistent application state is required; the included examples only print, log and return values.

## Message testing and diagnostics

Gateway message resources use the Python `system.util` API. Browser components use the separate local `app.sendMessage(...)` API and the shared Actions & Events editor. That local bus does not deliver to gateway resources or other browser tabs. For gateway-to-operator notifications, Python also provides `system.ui.sendMessage(messageType, payload={}, sessionId=None)` and `system.ui.getSessionInfo()`. Sends address connected operator tabs of the executing project, or one selected server-issued tab identity, and invoke session-scoped component handlers. Receipts count queued recipients rather than handler execution; delivery is transient and bounded. See [component messaging](COMPONENT_MESSAGING.md) for the complete contract and examples.

Select a message handler as an engineering administrator. Save and publish its enabled revision, enter a JSON object under **Test published handler**, then choose **Send test request**. The tester calls the published handler and displays its output and result. It is unavailable while there are unsaved changes, when the publication differs from the saved draft, or when the handler is disabled. It never sends the code in the editor.

The corresponding project-scoped endpoint is `POST /api/projects/<project-id>/scripts/messages/<encoded-handler-name>/request`, with `{ "payload": { "message": "hello" }, "revision": <published-script-revision> }`. Designer testing requires an engineering administrator. The handler's configured permission also governs authorized runtime dispatch; a View grant alone does not authorize Operate handlers. Payload values are application data, not trusted code.

Gateway Python also provides these helpers:

| Helper | Result |
| --- | --- |
| `system.util.sendMessage(project=None, messageHandler=None, payload=None)` | Submits a message without waiting for its handler result. Acceptance is not proof of completion. |
| `system.util.sendRequest(project=None, messageHandler=None, payload=None, timeoutSec=10)` | Waits for the published handler and returns its `result`; handler failure raises a Python error. |
| `system.util.sendRequestAsync(project=None, messageHandler=None, payload=None, timeoutSec=10)` | Returns a `concurrent.futures.Future`; call `.result()` to await its value or error within the script's overall deadline. |

Omit `project` to target the current project, or provide another project ID on the **same gateway**. Authored Python executes with trusted gateway authority, including these calls; it does not inherit or enforce an operator's project grants. HTTP message endpoints enforce their engineering or operator audience and the configured handler permission. Payload must be a dictionary. Cross-gateway delivery is outside this feature. These are bounded in-process dispatch paths, not durable message delivery; shutdown or timeout can prevent completion. Do not use fire-and-forget acceptance as proof that an action ran.

After publishing the workshop echo handler, an administrator can run this from that project's Python console:

```python
result = system.util.sendRequest(
    messageHandler="Workshop echo",
    payload={"message": "Hello from Python"},
    timeoutSec=5,
)
```

The **Gateway events** output tab polls every five seconds. It shows the active revision, execution count, enabled/running/queued state, last and next runs, and recent outputs/results. An administrator can choose **Cancel run** for active work. Cancellation stops remaining execution where possible; it does not roll back completed tag or database changes.

The latest **100 run records survive gateway restart** when their journal can be written. They are a bounded diagnostic history, not a durable job queue or the security audit journal. A storage problem appears in Gateway events. An unreadable or corrupt journal is preserved; new history remains in memory until storage is repaired and the project's scheduler restarts. Other write failures are reported and retried on the next journal write. Standard output and error are each limited to 8,192 characters in a log; logged results are limited to 8,192 serialized characters. Runs interrupted by gateway exit remain distinguishable from successful completion.

Normal queues stop before an old publication's shutdown handlers. Same-project messaging is therefore unavailable inside shutdown handlers; direct tag/query APIs may still be used within the shutdown budget. A message already accepted by another project belongs to that destination's active generation: replacing the sender does not retract it, while replacing the destination cancels its queued delivery.

## Import and exercise the workshop

The independently authored `gateway-events.sparkproj` contains a read-only checklist screen and seven **disabled** gateway resources. It contains no accounts, credentials, device connections, gateway tag definitions or databases. Import creates an unpublished draft; neither import nor screen publication starts the scripts. The package is portable. The optional tag-observation exercise needs one separately configured memory tag.

1. Import the package into a disposable gateway. Open **Scripting** and confirm all seven resources are disabled. Publish the screen separately if you want its checklist in the operator application.
2. Review **Workshop startup**, **Workshop update** and **Workshop timer**. Enable them, save, then publish scripts. Observe the startup result and ten-second timer runs. Make a harmless saved resource change and inspect the published Update handler's actor and changed-resource list.
3. Enable **Workshop echo**, save and publish. Send `{ "message": "Workshop request" }` through **Test published handler** and inspect the echoed Result. This example requires a gateway administrator. Make an unsaved edit and confirm the tester is disabled until you save and publish again.
4. For tag changes, create a numeric memory tag at `[default]Workshop/GatewayEvents/Counter` through tag engineering. The package intentionally does not create it. Enable the observer and publish, change that test tag through its normal editor, and inspect `initialChange`, previous/current qualified values and changed attributes. The script itself never writes a tag.
5. Enable **Workshop scheduled** and publish. It uses `*/5 * * * *` in UTC. Check its next-run time and resulting log. Try a fixed-rate timer on this disposable gateway; late intervals are skipped, not replayed.
6. Enable **Workshop shutdown** and publish. Stop the disposable gateway gracefully, restart it, then inspect the retained shutdown/startup records. Forced termination is not an equivalent test. Shutdown completion remains best effort.
7. Disable the example events, save and publish when finished. Remove the optional memory tag separately if it is no longer needed. Archiving the workshop stops its scheduler.

Run `node tools/build-workshops.mjs --version gateway-events-dev` to build from authored sources; choose a fresh version label for each build. The maintained package is `artifacts/sparkproj/gateway-events.sparkproj`. Immutable ZIPs and release metadata stay under `artifacts/workshops/`. The source catalog records feature compatibility and the optional memory-tag prerequisite. See [Scripting](SCRIPTING.md) for reusable libraries, browser events and resource limits.
