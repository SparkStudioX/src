# Scripting workspace

SparkStudio supports reusable Python libraries, gateway automation, gateway-executed Python component events and browser JavaScript events. The Scripting workspace edits persistent resources with a tree, document tabs and a locally bundled CodeMirror editor. Component event editors use the same bundled source editor. Syntax highlighting, line numbers, folding, indentation, find/replace and completion hints work without a CDN. Completion hints are not a language server; a debugger, breakpoints and nested library packages are not included.

Resources belong to the project currently open in the Designer. Different projects can use the same library and resource names without sharing definitions. Gateway tags and connections remain shared. Archiving a project stops its event scheduler; restoring it resumes the prior script publication. See [project management](PROJECTS.md).

## Save, publish and run

**Save resources** persists the complete script draft using its revision. **Publish application** opens the shared review of saved screens, queries, libraries and event resources, then activates them as one revision. Saving alone does not replace running events, though an already published Update handler can observe the saved resource changes. Changed executable code requires a gateway administrator to approve publication; a Design/Publish grant alone cannot activate it. See [unified publication](UNIFIED_PUBLICATION.md).

Add a resource under Project library, Gateway events or Browser events. Libraries are enabled initially; new events are disabled until explicitly enabled. Choose an event, edit its code and optional scalar parameter defaults, then save and publish. Deletion is a draft change until saved and published.

Python resources can run manually from either their saved draft or their publication. Save edits before running a resource. Run overrides must use declared parameter names and matching scalar types. A default of `null` allows any supported scalar type. Running a library executes its module body; defining functions alone need not produce a result. Browser resources run in the published operator runtime, not on the gateway.

The Console remains a Python scratchpad. **Save console** stores its text in this browser, separate from gateway resources. `Ctrl+S` saves the active document and `Ctrl+Enter` runs Python. `Ctrl+F` opens search, `Ctrl+Space` requests completion, and Tab indents; press Escape followed by Tab to leave the editor. Failed revisions retain local edits and show conflict feedback. Invalid parameter JSON must be corrected before switching resources, so unfinished text is not silently discarded.

**Check syntax** is shared by component editors, script resources and the console. JavaScript is parsed without execution in the browser. Python is compiled by an isolated CPython process without running the submitted body or importing its project libraries. Design permission and CSRF are required for `/scripts/validate`; it does not require administrator-only script execution permission. Source is limited to 65,536 characters, with four concurrent validation processes gateway-wide and a two-second deadline. Invalid syntax reports a message and available line/column positions; unavailable runtime, overload or timeout reports validation unavailable rather than claiming the source is invalid. Checking syntax does not save, publish, validate runtime names or execute a script.

## Python libraries

A library name is one Python identifier. For a library named `helpers`:

```python
def title(value):
    return str(value).strip().title()
```

An event, console command or operator action can use its published version:

```python
from project import helpers
result = helpers.title("assembly ready")
```

`import project.helpers` and `project.helpers` access are also supported. Modules load lazily within a fresh CPython worker. Module globals survive within that invocation only; use explicit persistent tags or a database for state needed across invocations. A draft resource run still imports published libraries.

The initial gateway API includes `system.tag.readBlocking`, `system.tag.writeBlocking`, `system.db.runNamedQuery`, `system.util.getLogger`, JSON helpers, `system.date.now` and a small dataset wrapper. Tag reads return the gateway's current values with quality and timestamps. The Python tag-write API supports configured, enabled memory tags. Reviewed Equipment Commands separately support OPC UA scalar device writes; arbitrary Python device writes are unavailable. Query resources return datasets, while explicit update resources return an affected-row count.

Published operator actions and gateway events resolve queries and libraries from their captured application revision. Draft Preview, manual draft resources and the Console retain their documented engineering scope. Saving a query or library does not change the active published application; publish the complete saved application to activate that change.

## Event scopes

Python button actions and input, mount/unmount, property-change and component-message handlers receive a scoped UI proxy. For example, `self.text = "hi"` changes the calling component and `self.getSibling("heading-id").text = "Ready"` stages an unbound heading change in its form. `system.ui.setState("screen", "title", "Ready")` updates declared state and its bindings. These effects apply only after success and only to the still-current browser context; an unmount invocation reads its departing snapshot and cannot mutate that retired UI. Shared changes continue to use gateway tags or database records. See [Python UI actions](PYTHON_UI.md) for the scope, conflict and failure contract, and [Python component events](PYTHON_COMPONENT_EVENTS.md) for the event editors, payloads and portable workshop.

| Resource | Events | Execution and lifetime |
| --- | --- | --- |
| Gateway Python | Startup, update, shutdown, timer, tag change, message, scheduled | Runs without an operator browser. Published resources govern execution; each event has its own trigger configuration, bounded timeout and dedicated or shared execution lane. |
| Component Python | Button click, input change/commit, mount/unmount, property change, named message handlers | Runs saved code on the gateway with Operate permission, or saved-draft code in administrator-enabled Live Preview. Validated UI effects return to the calling screen, popup or template instance; unmount uses a read-only departing snapshot. Shared tag/database changes use their normal gateway behavior. |
| Browser JavaScript | Startup, screen open | Runs in each operator runtime tab. Startup runs once per script revision in the mounted runtime; screen open runs on screen activation. |
| Component JavaScript | Input change/commit, mount/unmount, property change, named message handlers | Runs in the browser with local form/state helpers. Messages use an exact type and listener scope; instance, screen and single-tab session scopes expire with their mounted context. See [component messaging](COMPONENT_MESSAGING.md). |

New supported automatic handlers default to Python; existing JavaScript keeps its language and source. Language switching uses separate drafts and does not translate code. Template/repeater wrappers support Python automatic handlers in their containing form; child components retain their own private row state. Password controls support redacted lifecycle/property/message Python handlers, but input change/commit remains JavaScript-only and automatic Python snapshots omit password values. Unmount is bounded best-effort cleanup and is not guaranteed on browser close, crash or lost network.

Browser `app.sendMessage` stays within one runtime tab. Python `system.ui.sendMessage(messageType, payload={}, sessionId=None)` instead notifies connected same-project operator tabs; `system.ui.getSessionInfo()` lists their server-issued identities. Omitting `sessionId` broadcasts to current same-project tabs, and a supplied ID targets one. Receivers use session-scoped component message handlers. This works from gateway events, published button/component Python and authorized console/Live Preview execution. A receipt counts queued recipients, never successful browser execution, and no replay or durable delivery is promised. `system.util.sendMessage`/`sendRequest` remain the distinct gateway-resource API. See [component messaging](COMPONENT_MESSAGING.md) for examples, authentication, publication boundaries and queue limits.

Gateway events do not overlap themselves. Replacing a script publication stops previous work and gives old shutdown handlers a bounded best-effort opportunity before activating the replacement. Republishing the same revision is idempotent. Fixed-delay timers wait after completion; fixed-rate timers skip missed intervals without a catch-up backlog. Scheduled handlers use five-field numeric cron and an explicit time zone. Tag handlers observe selected value, quality and timestamp changes and report coalescing. Named message handlers accept permission-checked JSON payloads. Gateway resource timeouts default to ten seconds and can be configured from 100 to 300,000 milliseconds; console and other invocation limits are separate.

Dedicated resources can execute independently. Shared resources serialize within their project's shared lane. Shutdown is best effort within a ten-second aggregate budget, and forced termination cannot execute cleanup. Missed schedules during downtime are skipped; daylight-saving gaps are skipped and repeated minutes run once. See the [Gateway events workshop](GATEWAY_EVENTS.md) for every trigger, Python event context, message testing and the portable seven-event example. The new examples are disabled until deliberately enabled and published.

Browser event bodies may use `await` and receive:

| Value | Meaning |
| --- | --- |
| `event` | Event type, screen ID/name and script revision |
| `parameters` | The resource's declared scalar defaults |
| `session` | An ordinary, untyped memory object shared across browser resources in this runtime tab; separate from typed reactive state |
| `app.notify(message)` | Display feedback in the runtime |
| `app.navigate(screenId)` | Navigate to a published screen |
| `app.refresh()` | Request runtime data refresh |
| `app.state.get(scope, key)` | Read a declared session or screen state value |
| `app.state.set(scope, key, value)` | Update a declared state value using its type and bounds |
| `app.state.reset(scope, key?)` | Restore one declared default, or all defaults in the scope |

For example:

```javascript
session.openedAt = new Date().toISOString();
app.notify("Application ready");
```

For reactive application data, declare defaults in the project or screen property sheet and use `app.state`. For example, after declaring Boolean session state `showDetails`:

```javascript
app.state.set("session", "showDetails", true);
```

Session state survives screen navigation within this project tab. Screen state resets when that screen is left, and popup state belongs to each popup opening. Templates and repeater rows inherit the containing screen or popup state. Application reload, project/publication replacement and user changes reset the state. Values stay in memory; packages contain defaults only. JavaScript input change/commit handlers also receive `app.state`, subject to their existing enabled, visible, read-only and stale-context gates. Python uses `system.ui` and `self.parent.custom` under its gateway permission and context checks. Missing keys and incorrectly typed values fail with a script diagnostic. See [typed application state](APPLICATION_STATE.md) for the saved format, binding sources and reset rules.

Updating declared state changes its bindings; assigning to the older `session` memory object does not. Browser startup/screen-open code can change local presentation state for a viewer, but those values never grant permissions or become implicit gateway Python inputs.

The browser helper object does not provide direct Python or database access. Browser code is trusted JavaScript in the application's origin, not a security sandbox. Python similarly runs with the gateway account's OS access. Process isolation and execution limits do not make untrusted author code safe.

## Component scripting

[Python UI actions](PYTHON_UI.md) expose scoped `self` and `system.ui` to button actions. [Python component events](PYTHON_COMPONENT_EVENTS.md) extend that bridge to supported input change/commit, mount/unmount, property-change and component-message handlers. These definitions publish with the project; libraries publish separately. `self.value` reads a non-password input's captured value and stages a validated local input edit; assignments to bound/read-only values fail. `inputs` remains the original invocation snapshot. Password text/value remains inaccessible through `self`; password change/commit requires JavaScript or an explicit authorized form submission. JavaScript uses its browser `app` helpers; language selection is not source translation. Gateway message resources, browser-local component messages and gateway-to-operator notifications have distinct routing contracts.

## Diagnostics and limits

The Gateway events output tab shows the active revision, enabled/running/queued state, execution counts, last/next run times and recent results. Its polling interval is five seconds. The latest 100 run records are persisted across gateway restarts; they are bounded diagnostics, not a durable job queue or security audit journal. Standard output and error are each bounded to 8,192 characters per log, and logged results are capped at 8,192 serialized characters. Engineering administrators can cancel active runs; cancellation cannot undo completed side effects.

There are at most 100 resources, with 64 KiB of UTF-8 code per resource and 512 KiB total. Each resource may declare up to 64 scalar parameters: string, finite safe number, Boolean or null. Strings are limited to 4,096 characters. Timer intervals range from 100 to 86,400,000 milliseconds. Tag-change resources accept one to 64 unique absolute paths. Durable job queues, replay after downtime and guaranteed delivery are not included.

## Database application example and next scope

From the source checkout, `node tools/load-sqlite-example.mjs` loads independently authored work-order screens, a managed local SQLite connection, parameterized queries, a Python library and gateway/browser events. It preserves unrelated resources and rejects conflicting example resource definitions. The example uses selected-row fields and an optimistic row version to prevent silent overwrites. It does not demonstrate an external SQL Server connection or equipment writes.

Chrome verification exercised library creation in the editor, retention of unsaved edits across Designer/Scripting navigation, saved execution, publication and console import. Invalid parameter JSON retained its buffer when switching was attempted. Gateway status/logs were visible, and an authored browser screen-open notification executed. These are selected workflows, not complete editor or browser compatibility coverage.

Historical baseline: the original scripting increment passed 14 API groups from source and its self-contained Windows package, with restart/library/startup and SQLite/browser checks described in the dated [verification ledger](PARITY.md). Those counts do not validate the later seven-family gateway event engine, component messaging, Python UI bridge or Python component events. Their guides and ledger entries identify their own evidence and release boundary.

Remaining scripting work includes package organization, deeper debugging, additional APIs and dependency environments with offline wheels. See [verification and roadmap](PARITY.md) for measured coverage and remaining boundaries; selected automated and browser checks do not establish production scheduling or every shutdown condition.
