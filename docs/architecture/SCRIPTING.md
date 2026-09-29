# Scripting workspace

SparkStudio separates reusable Python libraries, gateway automation and browser JavaScript events. The Scripting workspace edits persistent resources with a tree, document tabs and a locally bundled CodeMirror editor. Syntax highlighting, line numbers, folding, indentation, find/replace and completion hints work without a CDN. Completion hints are not a language server; a debugger, breakpoints and nested library packages are not included.

Resources belong to the project currently open in the Designer. Different projects can use the same library and resource names without sharing definitions. Gateway tags and connections remain shared. Archiving a project stops its event scheduler; restoring it resumes the prior script publication. See [project management](PROJECTS.md).

## Save, publish and run

**Save resources** persists the complete script draft using its revision. **Publish scripts** activates the saved library/event snapshot. Saving alone does not replace running events. Script publication is separate from the screen/project publication; these resources do not yet form one atomic release.

Add a resource under Project library, Gateway events or Browser events. Libraries are enabled initially; new events are disabled until explicitly enabled. Choose an event, edit its code and optional scalar parameter defaults, then save and publish. Deletion is a draft change until saved and published.

Python resources can run manually from either their saved draft or their publication. Save edits before running a resource. Run overrides must use declared parameter names and matching scalar types. A default of `null` allows any supported scalar type. Running a library executes its module body; defining functions alone need not produce a result. Browser resources run in the published operator runtime, not on the gateway.

The Console remains a Python scratchpad. **Save console** stores its text in this browser, separate from gateway resources. `Ctrl+S` saves the active document and `Ctrl+Enter` runs Python. `Ctrl+F` opens search, `Ctrl+Space` requests completion, and Tab indents; press Escape followed by Tab to leave the editor. Failed revisions retain local edits and show conflict feedback. Invalid parameter JSON must be corrected before switching resources, so unfinished text is not silently discarded.

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

The initial gateway API includes `system.tag.readBlocking`, `system.tag.writeBlocking`, `system.db.runNamedQuery`, `system.util.getLogger`, JSON helpers, `system.date.now` and a small dataset wrapper. Tag reads return the gateway's current values with quality and timestamps. Writes support configured, enabled memory tags; OPC device writes are not implemented. Query resources return datasets, while explicit update resources return an affected-row count.

Published operator actions resolve named queries from their captured project publication. Console commands, Designer Preview, manual resources and gateway events use that project's current named-query definitions. Libraries come from the independent script publication, including when called from a published operator action. Changing a project query or publishing a library can therefore affect later executions in that project without republishing every screen.

## Event scopes

| Resource | Events | Execution and lifetime |
| --- | --- | --- |
| Gateway Python | Startup, timer | Runs without an operator browser. Startup runs when a new script publication activates and after gateway restart. Timers wait their configured delay before the first execution and after each completed execution. |
| Browser JavaScript | Startup, screen open | Runs in each operator runtime tab. Startup runs once per script revision in the mounted runtime; screen open runs on screen activation. |

Gateway timers do not overlap themselves. Replacing a script publication cancels previous gateway event work before activating the replacement. Republishing the same revision is idempotent. The timer interval is a fixed delay, not a calendar schedule or a fixed-rate timing guarantee. Separate resources may execute independently. Python invocations have a ten-second execution limit.

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

Session state survives screen navigation within this project tab. Screen state resets when that screen is left, and popup state belongs to each popup opening. Templates and repeater rows inherit the containing screen or popup state. Application reload, project/publication replacement and user changes reset the state. Values stay in memory; packages contain defaults only. Input change/commit handlers also receive `app.state`, subject to their existing enabled, visible, read-only and stale-context gates. Missing keys and incorrectly typed values fail with a script diagnostic. See [typed application state](APPLICATION_STATE.md) for the saved format, binding sources and reset rules.

Updating declared state changes its bindings; assigning to the older `session` memory object does not. Browser startup/screen-open code can change local presentation state for a viewer, but those values never grant permissions or become implicit gateway Python inputs.

The browser helper object does not provide direct Python or database access. Browser code is trusted JavaScript in the application's origin, not a security sandbox. Python similarly runs with the gateway account's OS access. Process isolation and execution limits do not make untrusted author code safe.

## Diagnostics and limits

The Gateway events output tab shows the active revision, enabled/running state, last/next run times and recent results. Its polling interval is five seconds. Logs retain at most 100 resource runs in memory and reset on gateway restart; they are not a durable audit journal. Standard output and error are each bounded to 8,192 characters per log, and logged results are capped at 8,192 serialized characters.

There are at most 100 resources, with 64 KiB of UTF-8 code per resource and 512 KiB total. Each resource may declare up to 64 scalar parameters: string, finite safe number, Boolean or null. Strings are limited to 4,096 characters. Timer delays range from 100 to 86,400,000 milliseconds. Manual cancellation controls, durable job queues and delivery guarantees are not included.

## Database application example and next scope

From the source checkout, `node tools/load-sqlite-example.mjs` loads independently authored work-order screens, a managed local SQLite connection, parameterized queries, a Python library and gateway/browser events. It preserves unrelated resources and rejects conflicting example resource definitions. The example uses selected-row fields and an optimistic row version to prevent silent overwrites. It does not demonstrate an external SQL Server connection or equipment writes.

Chrome verification exercised library creation in the editor, retention of unsaved edits across Designer/Scripting navigation, saved execution, publication and console import. Invalid parameter JSON retained its buffer when switching was attempted. Gateway status/logs were visible, and an authored browser screen-open notification executed. These are selected workflows, not complete editor or browser compatibility coverage.

The 14 scripting API groups passed from source and again from the rebuilt self-contained Windows executable. A separate restart audit retained the publication and library and ran startup exactly once after restart. The accompanying 12 SQLite API groups also passed from the package; Chrome create/edit, immediate refresh, stale-edit rejection, reload/filter and selection after sorting passed. The public installer and Linux image have not been refreshed for this increment.

Next work includes broader component events, tag-change/message handlers, shutdown and calendar scheduling, package organization, diagnostics/navigation across resources, and dependency environments with offline wheels. Authentication, permissioned actions and audit remain required before shared-network deployment. See [verification and roadmap](PARITY.md) for measured coverage and remaining boundaries.
