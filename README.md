# SparkStudio

SparkStudio is an early-preview industrial application builder with a browser designer, a published operator runtime and a self-hosted gateway. The application uses ASP.NET Core/.NET 10, React/TypeScript and CPython 3; it does not require Java or Jython.

[Website](https://sparkstudiox.com/) · [Windows preview release](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.13) · [Product scope](docs/architecture/PRODUCT.md) · [Verification and roadmap](docs/architecture/PARITY.md)

The current source includes **local accounts, separate engineering/operator sessions, server-enforced project permissions and a bounded audit trail**. First run requires administrator setup on the gateway computer. Remote account/API access requires HTTPS; network deployment and service lifecycle acceptance remain separate gates. Python scripts run with the gateway account's operating-system access; worker processes are not a security sandbox. See the [security guide](docs/architecture/SECURITY.md).

Preview.13 adds [Ask Spark](docs/architecture/ASK_SPARK.md), the engineering assistant with voice transcription, pasted screenshots, Markdown answers, authorized tools and reviewed changes. It also adds read-only [MQTT, MTConnect and i3X sources](docs/architecture/DATA_SOURCES.md), tabbed connection editors, clearer field guidance and Layers-pane multiple selection. Normal builds now enforce frontend/backend lint, offline tests and cyclomatic complexity checks. The [release ledger](docs/architecture/PARITY.md) records candidate status, exact-package verification, asset hashes, source revision and remaining acceptance limits. The features below remain available.

## What works today

- Administrator account setup, user/grant management, separate engineering/operator sign-in, read-only viewers, session revocation, project tag-read scopes, audit and copyable published operator links.
- Projects home and Designer project navigation, with create, rename, duplicate, archive/restore and portable `.sparkproj` import/export. Each project has its own screens, queries, scripts, assets and operator URL; gateway connections and tags are shared.
- Ask Spark throughout Projects, Designer and Gateway Settings, with Gemini configuration, voice transcription, pasted images, Markdown answers, on-demand tool discovery, parallel reads and ordered changes. Designer tools support batched edits, reusable faceplates, bindings/scripts, canvas captures and approved image crops. Operator tools use separate authorized sessions. See the [Ask Spark setup and workshop](docs/architecture/ASK_SPARK.md).
- Fixed-canvas screen editing with explicit X/Y positions, marquee/multiple selection, persistent flat groups, group resizing, a bounded custom grid, selection by type, matching dimensions, alignment, distribution, duplication and Undo/Redo. Project authoring defaults apply to new screens/templates without resizing existing documents.
- Forty-five component types, including seventeen inputs and browser camera capture, formatted fields and barcode entry, state controls, numeric LED, process displays, drawings, ten chart modes, sparkline and explicit equipment commands.
- Optional embedded, tab, split and dock containers with retained independent pane forms and pointer/keyboard layout controls. See [view containers](docs/architecture/VIEW_CONTAINERS.md).
- Focus/blur, keyboard, double-click and pointer handlers in the shared Actions & Events editor, in Python or JavaScript. See [interaction events](docs/architecture/COMPONENT_INTERACTIONS.md).
- Inline input rules and formatted/barcode commits, plus typed table multiple selection and staged atomic database batches. See [validated inputs](docs/architecture/VALIDATED_INPUTS.md) and [table batch editing](docs/architecture/TABLE_BATCH_EDITING.md).
- Published Python button actions with typed form inputs, isolated template/row context and persisted local memory-tag writes.
- Python UI actions with `self` component proxies and typed `system.ui` helpers: update the calling session's unbound properties or declared state, while shared tags/database records feed other operators. See the [Python UI workshop](docs/architecture/PYTHON_UI.md).
- Python input change/commit, property-change and component-message handlers with scoped UI effects, staged language editors and an offline [work-order form workshop](docs/architecture/PYTHON_COMPONENT_EVENTS.md).
- Reusable templates and saved-row repeaters nested through four template levels, with independent inputs for every complete instance/row path, typed parameters, inherited wrapper properties and validated popup provenance. Query-backed repeaters support nested template scopes under explicit row and expansion limits.
- Template-parameter fx bindings from the containing form's parameters, non-password inputs, custom properties, typed session/screen/private state and live tags, with typed previews, dependent-form reset and gateway reconstruction of published action contexts.
- A name/value property sheet with direct fx controls for supported general, component-specific and custom runtime properties, including validated structured settings and datasets. Sources include form inputs, typed template parameters, sibling custom properties and tags. See [runtime property bindings](docs/architecture/RUNTIME_PROPERTY_BINDINGS.md).
- Python or browser JavaScript input change/commit events with validated same-form effects and one shared Actions & Events editor.
- Component Mounted, Property changed and Unmounted Python or JavaScript handlers, with a staged property-sheet editor, ordered observation, bounded queues, async deadlines, shared feedback-loop protection and cleanup that cannot write into a disposed context.
- Named component message handlers and native Send message buttons, with instance, screen and single-tab session scopes. Browser scripts send payloads through `app.sendMessage(...)`; see the [component messaging workshop](docs/architecture/COMPONENT_MESSAGING.md).
- Declared, typed browser session, screen and private template-instance state, read by bindings and updated through script helpers or two-way value bindings on supported non-password input types. Each template placement and repeater row owns its private values; nested templates still share their containing screen's state, and popups start fresh screen state while retaining the session.
- A persistent scripting workspace for reusable libraries and gateway/browser events, plus an expanded Python onClick editor with syntax highlighting, completion and form/parameter context.
- Gateway startup, update, shutdown, timer, tag-change, message and cron-scheduled Python events, with shared/dedicated execution, fixed-rate/fixed-delay timers, bounded queues, configurable deadlines, cancellation and restart-persistent run history. See the [gateway events workshop](docs/architecture/GATEWAY_EVENTS.md).
- Immutable local images with searchable usage and previewed reference replacement, plus parameterized modal popups with independent form state.
- Reusable visual styles and packaged caption translations, with staged editors, explicit source precedence and stable resource references.
- Live read-only Designer Preview by default, with administrator-confirmed live actions, expiring session/project capabilities and bounded authoring diagnostics.
- Reviewed atomic application publishing and rollback capture screens, queries, Python libraries and gateway/browser events in one immutable release. See [unified publication](docs/architecture/UNIFIED_PUBLICATION.md).
- Explicit equipment commands add fresh confirmation, type/range checks, matching readback and audited receipts for configured memory/OPC UA tags. Operate alone does not grant Commands.
- Native **Set tag value** button actions browse a configured memory/OPC UA tag and use a fixed scalar or same-form component property. Commands permission and existing command limits remain authoritative; uncertain writes are never retried. See [equipment commands](docs/architecture/EQUIPMENT_COMMANDS.md).
- An administrator gateway overview, revocable session inventory, process/API diagnostics and a redacted support download. Checked operator publication history restores a prior application while preserving its Designer draft.
- Encrypted online configuration backup downloads and multiple named schedules targeting SMB, FTP/FTPS or S3 in **Gateway Settings → Backups**. Each schedule has its own days, time zone and age retention; **Restore** contains the offline full-data guide and recovery review. See [scheduled backups](docs/architecture/SCHEDULED_BACKUPS.md) and [offline recovery](docs/architecture/GATEWAY_RECOVERY.md) for scope and secret portability.
- Versioned UDT definitions and pinned instances, member overrides, named scan groups, default-provider lifecycle, scalar expression tags and reviewed tag-model imports; see [tag engineering](docs/architecture/TAG_ENGINEERING.md).
- Installer selection of local-only access or HTTPS on all IPv4 interfaces with a separate loopback management port, a DNS hostname or specific IPv4 operator address, and either a generated self-signed certificate or protected PEM certificate/key import. Generated certificates need no supplied files; operator computers must explicitly trust the exported public certificate. IP access uses an exact iPAddress certificate SAN without requiring DNS. See [network access](docs/architecture/NETWORK_ACCESS.md).
- OPC UA discovery, browse/read and monitored-item subscriptions; managed local SQLite databases and SQL Server connections with parameterized named reads and explicit updates.
- Modbus TCP, Allen Bradley EtherNet/IP, Siemens S7 and Beckhoff ADS connections with saved point maps, browsing, polling and reviewed scalar writes. Allen Bradley profiles include ControlLogix, CompactLogix, Micro800, MicroLogix, SLC 500 and PLC-5; supported encodings and acceptance limits are in the [industrial connections guide](docs/architecture/INDUSTRIAL_DEVICE_CONNECTIONS.md).
- Read-only MTConnect, i3X and MQTT source sessions with browsable catalogs, reviewed point/tag imports and source diagnostics. MQTT includes opt-in automatic tag ownership and bounded payload transformations. Start with the [MQTT](docs/architecture/MQTT_SETUP.md), [MTConnect](docs/architecture/MTCONNECT_SETUP.md) or [i3X](docs/architecture/I3X_SETUP.md) walkthrough.
- Query tables with configurable headings, order, visibility, widths, alignment and value formats, plus loaded-row paging, filtering, sorting, refresh, selection into declared form inputs and validated inline edits through published Python handlers.
- Single-selection dropdowns, lists and trees with static or named-query choices, validated row-to-form mappings and published server-side membership checks. Query trees declare a parent column; input-driven tag paths let a selected machine determine its process display.
- Light, Dark and System themes, browser preference persistence, a collapsible designer sidebar and horizontally resizable project/properties panes with saved widths.
- A self-contained Windows package, an unsigned Windows installer and a non-root Linux container baseline.

These are bounded implementations, not complete Ignition feature or file-format compatibility. Real SQL Server and physical-device command acceptance, additional tag providers, richer historian/alarm services, reporting and migration tooling remain outstanding. See the [component matrix](docs/architecture/COMPONENTS.md).

The current source includes query-backed forms and scalar properties, single-selection lists/trees, loaded-result table paging and inline editing, typed nested templates with parameter fx bindings and private instance state, two-way input/state bindings, automatic property/lifecycle events, state controls, five process displays and six drawing/symbol types. Further binding sources, responsive containers, conditional styles, deeper diagnostics, service-switching recovery and cross-version restore migrations remain planned. Supplied-data charts, bounded datasets, local raw tag history and alarm conditions/journals are implemented; historian aggregation, alarm notifications and reporting remain planned. The [component guide](docs/architecture/COMPONENTS.md) defines behavior and remaining work; the [verification ledger](docs/architecture/PARITY.md) separates each implemented increment from its remaining acceptance gates. SQLite has real disposable-database and gateway/Python integration checks; SQL Server reads and DML still need a live test server. Verification applies only to the build and environment named in the ledger. An already installed gateway does not adopt source changes automatically.

## Run on Windows

Download the preview.13 installer, checksum and matching 37-project workshop collection from the [Windows preview release](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.13). The installer bundles .NET, Python, the source-expression worker and browser assets; setup-required examples, including Ask Spark and read-only data sources, are documented separately. It retains unified publication, local alarms/history and the 10,000-expanded-tag configuration limit while adding the features above. Consult the release notes and [release ledger](docs/architecture/PARITY.md) for exact-package verification, and [load measurements](docs/architecture/LOAD_TESTING.md) for throughput limits. Read the [installer guide](docs/architecture/WINDOWS_INSTALLER.md). Ask Spark needs a user-supplied Gemini API key and provider access; offline fixtures do not establish live model availability. Physical industrial controllers, real-source interoperability and Linux execution of the new drivers remain separate acceptance work. Elevated preview.13 service/network installation, remote browser trust, rollback, uninstall, complete real-data preservation, broader service-account/ACL behavior, actual domain SMB, trusted external FTPS and real S3 account-policy/delivery acceptance remain pending.

For development, use Windows x64 with Node/npm available. Node 22.17.1 was used for the recorded checks. Run from the repository root in PowerShell:

```powershell
.\tools\build.ps1
.\tools\dev.ps1 -NoBuild
```

Open the default local address printed by the script, `http://127.0.0.1:5090`. Stop the foreground gateway with Ctrl+C. Development data is stored in `.data/development`; `-Port 5092` selects another port.

For automatic source updates, stop the existing development gateway, then run in **PowerShell 7**:

```powershell
.\tools\dev.ps1 -Watch -NoBuild
```

Keep this PowerShell terminal open while developing. Watch mode runs in the foreground; closing or stopping its host can end both servers. It is not a Windows service.

Watch mode keeps the browser address at `http://127.0.0.1:5090`. Vite updates frontend code through hot module replacement; a separate `dotnet watch` process on loopback port 5092 updates gateway code or restarts it when an edit cannot be applied live. The browser proxies API requests and live connections through the same public development address, retaining the existing login, cookies and origin checks. Designer/runtime page routes stay with Vite. `-Port 5094 -BackendPort 5095` selects a different pair. Both ports must be free; the script never stops an existing server for you.

The same `.data/development` projects and accounts are used by default. For a separate test environment, pass `-DataDirectory .data/my-test-gateway`; relative directories resolve from the source repository root. Run only one gateway against any data directory. Ctrl+C stops both process trees started by watch mode; diagnostics remain under local-only `.data/dev-watch/`. Run the initial build first; omit `-NoBuild` to restore/build prerequisites before watching. Changes to dependencies may require another build. Browser refresh or backend restart can reset unsaved browser state, so save Designer edits before changing application code. Source updates do not publish project drafts or update an installed package. Without `-Watch`, the existing build-and-run behavior is unchanged; an already-running packaged gateway does not adopt source edits automatically.

Create the first administrator using the local code in `.data/development/security/setup-code.txt`. Choose your own password in the setup form; there is no default password. Existing projects remain intact. Use **Security** to add accounts and assign per-project Design/Publish/View/Operate permissions. Operator links require a separate operator sign-in. The current Windows preview includes this account system.

The first build acquires the pinned workspace .NET SDK, embedded Python, NuGet dependencies and npm dependencies. SDK/cache files are kept under `.tools`, and the Windows Python runtime under `runtimes/python/windows-x64`. `build.ps1 -SkipRestore` reuses previously restored dependencies; it does not prepare a fresh machine.

Every normal frontend (`npm run build`), production .NET build/publish (Gateway, Connectors, SourceWorker and ServiceHelper), full (`tools/build.ps1`), Docker and CI build runs frontend ESLint, backend .NET SDK analyzers and Ruff, the complete offline unit/acceptance aggregate and the frontend/C#/Python cyclomatic complexity gate. A failed gate stops the build with a nonzero exit code. Quality diagnostics and the gate summary are saved under `.data/quality/`; detailed test reports remain under `.data/test-results/`. `-SkipRestore` does not skip quality gates. These builds require Node, the pinned .NET SDK and CPython, even when starting from the frontend command.

Direct `node tools/build-quality.mjs full` requires prepared npm dependencies and a production Gateway restore, like `build.ps1 -SkipRestore`. Use `tools/build.ps1` to prepare them. Nested test fixtures use isolated restore/build directories and verify that the calling production build's dependency assets remain unchanged.

The shared coordinator issues a temporary context for its nested test/compiler processes so they do not recursively restart the aggregate. A context is valid only while its owning coordinator is alive and is removed on completion; there is no public quality-bypass flag or persistent passing-build stamp. TypeScript checking and compiler diagnostics remain enabled within nested builds.

## Build an application

Start with the seed project's simulated lines. The independently authored example loaders below describe their payloads; their legacy CLI requests now require authentication. Use the [authenticated test preload](docs/architecture/SECURITY.md#verification-commands) only on an isolated test gateway, or import project packages through the signed-in application. There is no unauthenticated developer bypass.

```powershell
node tools/load-example.mjs application-form
node tools/load-example.mjs reusable-applications
node tools/load-example.mjs assets-popups
node tools/load-example.mjs operator-inputs
node tools/load-example.mjs property-bindings
node tools/load-example.mjs component-workshop
node tools/load-example.mjs template-properties
node tools/load-example.mjs template-parameter-bindings
node tools/load-example.mjs template-parameter-state
node tools/load-example.mjs instance-state
node tools/load-example.mjs component-events
node tools/load-example.mjs nested-forms
node tools/load-example.mjs application-state
node tools/load-example.mjs input-state-bindings
node tools/load-example.mjs state-controls
node tools/load-example.mjs process-displays
node tools/load-example.mjs process-graphics
```

The loader backs up the current project under `.data/example-backups` and adds missing resources and memory tags. Existing IDs and values are preserved. Review the draft, then publish in Designer. The loader currently accepts only local development ports 5090 and 5091; these combined example files are not complete project exports.

Use [templates](docs/architecture/TEMPLATES.md) for reusable forms and saved-row cards, and [assets/popups](docs/architecture/ASSETS_POPUPS.md) for local images and contextual dialogs. The portable examples use synthetic data. Setup-required exercises describe their gateway/database writes separately; the industrial workshop includes explicitly reviewed writes to isolated lab variables.

The [nested forms workshop](examples/nested-forms.json) contains paired machine cards, a two-row saved repeater and a contextual inspection popup. Each card embeds a setpoint form and read-only summary; each Python preview reports only its inner form's inputs and typed parameters without writing tags or records. The [nested-form guide](docs/architecture/NESTED_FORMS.md#workshop) covers loading, draft isolation, popup checks and the four-level/10,000-component bounds. A generated `.sparkproj` can be imported through Projects; generated packages stay in the local-only `artifacts/sparkproj/` directory.

The [template parameter workshop](examples/template-parameter-bindings.json) adds a machine selector and batch quantity that drive nested forms through **Property sheet → Template parameters → ƒx**. Its saved repeater retains each row's machine identity and independent note, and its inspection popup receives the chosen row's context. Change machine to clear dependent drafts, enter a quantity above the authored limit to see validation, and use the read-only Python buttons to inspect submitted parameters. Load it with `node tools/load-example.mjs template-parameter-bindings` using the authenticated loader setup above, or import the generated local-only `artifacts/sparkproj/template-parameter-bindings.sparkproj`. The [parameter-binding guide](docs/architecture/TEMPLATE_PARAMETER_BINDINGS.md) explains source scopes, types, precedence, resets and published gateway validation. This synthetic example needs no tags, database or external equipment.

The [private instance-state workshop](examples/instance-state.json) places independent machine panels side by side, nests a private note, repeats the same panels by row, and opens a fresh inspection popup. It demonstrates mirrored private inputs, explicit resets, shared session choices and read-only Python submissions. Import the generated local-only `artifacts/sparkproj/instance-state.sparkproj`, or use the authenticated loader above. The [instance-state guide](docs/architecture/INSTANCE_STATE.md) defines scope, initialization and disposal.

The [component-event workshop](examples/component-events.json) separates automatic property changes from user edits, demonstrates independent template lifetimes and popup cleanup, and includes deliberate timeout/feedback-loop tests using browser state only. Import `artifacts/sparkproj/component-events.sparkproj` or use the authenticated loader. The [lifecycle guide](docs/architecture/COMPONENT_LIFECYCLE.md) defines payloads, helpers, ordering and execution limits.

The [state-parameter workshop](examples/template-parameter-state.json) passes session station, screen batch and each panel's private extra quantity directly into reusable forms. Its popup preserves the opening context while using a fresh screen batch. Read-only Python buttons report the reconstructed values; no database or tag connection is required. Import `artifacts/sparkproj/template-parameter-state.sparkproj` or use the authenticated loader. See the [state-source guide](docs/architecture/TEMPLATE_PARAMETER_STATE.md).

For an application backed by an actual local database, use the separate SQLite example loader:

```powershell
node tools/load-sqlite-example.mjs
# After reviewing the generated resources, publish the script resources and project.
# Or load and explicitly publish both together:
node tools/load-sqlite-example.mjs http://127.0.0.1:5090 --publish
```

It backs up the project, named queries and script resources under `.data/example-backups`, creates the managed `workorders.db` database with synthetic `production_records`, and adds Work orders and New work order screens. The example includes named list/create/update queries, a reusable Python library, an active-order count memory tag, gateway startup/timer resources and a browser startup resource. Existing database files are never overwritten. Reserved IDs and library names are checked before mutations; incompatible existing resources stop the loader instead of being reused or overwritten. It accepts local ports 5090 and 5091; use a disposable development gateway first. This loader writes only its configured local database and memory tag, and it is not a database migration or project-export tool.

On Work orders, select a row to populate the edit form, change its fields and choose Save changes. The update checks both record ID and revision; a conflicting update returns zero affected rows and asks the operator to refresh and select the row again. Table filters and column sorting affect the whole loaded result before paging. Page size is 1–100 rows, default 25; paging never fetches additional database rows beyond the query result and connector limit. Refresh fetches the named query again; tables also poll every ten seconds and refresh after successful operator actions. Creating or selecting a row does not authorize arbitrary SQL from the browser.

After loading that prerequisite, run `node tools/load-equipment-example.mjs http://127.0.0.1:5090 --publish` for the Equipment workbench. A query dropdown selects a machine's production record and fills its editable fields. The selected machine also resolves a gauge's tag path through the property sheet. Save updates SQLite with a revision check and refreshes the query controls; explicitly reselect a record to reload the form. Its process readings are clearly labeled synthetic memory tags. The loader preserves existing screens and records, checks reserved IDs before writing, and supports `--project=<id>` for another project.

For lists, trees and paging without the Work orders prerequisite, load the independently authored [Data workshop](examples/data-controls.json):

```powershell
node tools/load-data-controls-example.mjs
```

This [separate loader](tools/load-data-controls-example.mjs) creates and publishes a new **Data workshop** project, a shared `sqlite-data-controls` connection and managed `data-controls.db` containing synthetic records. It leaves existing projects unchanged and refuses existing reserved project/connection/database configuration; the gateway never overwrites an existing database file. Its three read queries support **Records and hierarchy**, with query list/tree choices and a table paged two rows at a time. **Independent station forms** shows two instances of one template with separate list/tree selections. Python preview buttons report local form values without writing equipment or database rows. The loader accepts an optional plain local gateway URL on port 5090 or 5091; it publishes immediately and is not a repeatable update or cross-resource transaction.

List/tree static choices use Value/Label rows and a tree Parent picker, with Apply/Cancel validation. Runtime arrows move focus, Enter/Space selects and tree Left/Right collapses/expands; these are single-selection controls. See [choices, keyboard and query contracts](docs/architecture/QUERY_CONTROLS.md) for bounds and mappings.

For a table, use **Properties → Table columns → Edit columns** to set exact query keys, headings, order, visibility, widths, alignment and formats. Apply creates one undo step; Save and Publish make those settings available to operators. Hidden keys remain available for row mappings. Number formats accept precision and a literal suffix; date/time values require an explicit timezone and display in UTC.

Use **Properties → Inline editing → Configure editing** to declare editable text/number/Boolean columns, validation limits, a version column and a gateway Python commit handler. Operators with Operate access use explicit cell Edit/Save/Cancel controls; Designer preview never executes table writes. The gateway reconstructs the published row and checks its current version before running the handler. Your named update must also compare key and version atomically in SQL, advance the version and require exactly one affected row. See the [inline editing contract and SQL/Python recipe](docs/architecture/QUERY_CONTROLS.md#inline-table-editing).

In Connections, add SQLite with a filename such as `application.db`, save it, then use Create database or Browse schema. Testing a missing database does not create it. Databases stay under the gateway data directory's `databases` folder; paths, URI filenames and connection strings are rejected. Create database creates an empty file: arbitrary schema editing is not exposed in this first slice, while the example loader supplies its fixed sample schema. See the [connector contract](src/SparkStudio.Connectors/README.md) for filename rules, row/size/time limits, cancellation and SQL permissions.

Named reads return datasets. Explicit update definitions accept one parameterized INSERT…VALUES, UPDATE or DELETE and return the affected-row count, including through Python `system.db.runNamedQuery`. DDL, stored procedures, batches and general transactions are outside this slice. SQL Server needs appropriate database permissions and remains unverified against a live server; SQLite create/read/update paths are exercised against real disposable databases. Gateway Python and browser JavaScript resources are trusted author code included in the reviewed application publication.

The [input workshop](examples/operator-inputs.json) demonstrates the six new controls and a Python submit action. Toggles change form state; scripts decide when to persist it. Numeric `step` guides the controls but does not require submitted values to be exact step multiples. Date/time values are local wall-clock strings with no timezone conversion, and an empty value is allowed.

The [Binding workshop](examples/property-bindings.json) demonstrates captions, hex color and visibility driven by form inputs, typed custom properties and a tag-qualified Enabled condition. Its Python button returns the current form values. Use the inspector's binding dialog to choose named sources and preview an expression result. Hidden controls remain selectable while designing, and disappear in Preview and the operator application. These bindings are interface behavior, not permissions. See [component properties and bindings](docs/architecture/PROPERTY_BINDINGS.md) for syntax, scope, errors and limits.

Choose **Named query** in a scalar property's fx dialog to read one selected column from an exactly one-row result. Map typed query parameters from the current form or browser state, optionally transform `value`, and choose on-change or polling refresh. **Run preview** explicitly tests the staged read; normal Designer editing does not execute property queries. Reusable panels, popup queries and query-driven geometry are demonstrated in the [query-property workshop](examples/query-properties.json), loaded with `node tools/load-example.mjs query-properties`. See [query properties](docs/architecture/QUERY_PROPERTIES.md) for scope, cancellation and unavailable-result behavior.

Define typed **Session state** in Project settings and **Screen state** in each screen or popup property sheet. Read these values with fx references and update them from browser scripts through `app.state.get/set/reset`. Session values survive screen navigation in the current tab; screen values reset on leaving, and each popup starts fresh. Only authored defaults are saved or exported. The [application-state guide](docs/architecture/APPLICATION_STATE.md) and [two-screen workshop](examples/application-state.json) show the scopes, script helpers and reset behavior. Load the example with `node tools/load-example.mjs application-state`, or import its generated `.sparkproj` through Projects.

For a two-way value connection, select a supported input and choose **Data → Value → fx**. Bind it to a declared state key of the matching Text, Number or Boolean type. Valid edits update other bound controls across root forms, nested templates, repeater rows and popups; script updates flow back into the controls. An invalid draft stays local, leaves shared state unchanged and blocks submission of its own form until corrected. Password inputs are excluded. The [input-state guide](docs/architecture/INPUT_STATE_BINDINGS.md) explains compatible controls and restrictions. Its [workshop](examples/input-state-bindings.json) provides mirrored inputs, nested forms and independent screen/popup notes without database or equipment writes; import the generated local-only `artifacts/sparkproj/input-state-bindings.sparkproj`, or use the example loader above.

Use **Project settings** above the left project tree for project-wide properties; the right property sheet follows the selected screen, template or component. Drag either vertical separator to resize the project and properties panes. Focus a separator and use Left/Right arrows for 8-pixel changes, Shift+arrows for 32 pixels, or Home/End for its limits; double-click restores default widths. Width preferences survive reload and fit around a usable canvas. A repeater consumes wheel scrolling while it can scroll, then lets scrolling continue in the surrounding screen.

The common property sheet shows name/value rows and an fx control for each of its 13 binding targets. Positions and sizes can bind just like captions and colors. Geometry bindings apply in Preview and the operator application while the authoring canvas keeps stored geometry for stable handles. Existing type-specific and complex configuration editors remain available; not every component field supports a binding.

Place a Line, Rectangle, Ellipse, Polyline, Pipe or Equipment symbol on the canvas to build a process diagram. **Edit points** stages X/Y coordinates from 0–100% inside the component, with insertion, reordering, removal and one Apply/Cancel step. Stroke, fill, rotation and supported flow/active states have fx controls; the three equipment symbols can optionally open a screen or popup. The [process graphics example](examples/process-graphics.json) and [drawing guide](docs/architecture/DRAWING.md) cover this first set. These components show authored process state and perform no automatic equipment writes.

For a button with Run Python event, choose Edit onClick event. Apply updates the project draft as one history step; Cancel discards the event draft. The editor shows current input/parameter context and saved library names. The same Actions & Events editor handles input change/commit and lifecycle handlers. Supported events offer Python or JavaScript with context-specific helpers. Programmatic assignments and tag refreshes do not retrigger input handlers. Test applied events in Preview, then save and publish the project. Custom properties remain static definitions; use declared browser state for mutable session, screen or private instance values. **Actions & Events** also provides [property-change and mount/unmount handlers](docs/architecture/COMPONENT_LIFECYCLE.md) with bounded queues and cascade protection.

On the canvas, drag empty space to select intersecting controls; Shift/Ctrl-drag adds to the selection and Shift/Ctrl-click toggles individual controls or complete groups. Ctrl+G groups the selection, and Ctrl+Shift+G ungroups. Move, copy and delete act on the whole group; alignment/distribution treat groups as units. A selected group's bottom-right handle scales member positions and sizes using one factor per axis, with child minima and canvas limits. Font sizes stay authored and active layout bindings may override stored geometry in Preview.

Use arrows to nudge by 1 pixel or Shift+arrows for 10. Ctrl+A selects all, Ctrl+D duplicates, Delete removes, Ctrl+Z undoes and Ctrl+Y or Ctrl+Shift+Z redoes. New edits clear Redo, and restoring content retains the latest acknowledged gateway revision. Copies receive independent group IDs and input field names; explicit custom-property links between copied controls follow the copies. References outside the selection, form-input reference names and authored scripts stay unchanged and need review. Groups are flat and do not introduce a new template/form scope.

**Save** changes the draft. **Publish** captures its saved project, named-query and script resource definitions as one reviewed application revision. Operators load that publication through `/runtime/<project-id>`; the legacy `/runtime` link opens the default project. Later draft screen or named-query edits stay separate from published button actions. Runtime responses omit authored Python source and SQL, and action requests reject stale publication tokens. Tables can reference only read definitions; update definitions remain available to authored Python actions through the captured query snapshot.

Operator URLs default to **Application only**: the screen fills the available viewport without the surrounding SparkStudio bars. Append `?view=controls` to the operator application URL to include the screen menu, parameter selectors, theme, account controls and footer (`?view=controls`). Both presentations require the same operator sign-in and permissions. Application buttons and popups work in either view.

Open the gateway root for Projects home. Use its project cards to open a Designer, create or manage projects, or import/export a `.sparkproj` file. Packages include saved draft screens, queries, script resources and referenced images. Imports and duplicates create unpublished projects; connections, tags, database contents and credentials remain gateway resources. Project files live under the configured data directory's `projects/<id>/` folders, with no database required for storage. See [projects and portable packages](docs/architecture/PROJECTS.md) for migration, archive behavior and the file format.

An already-open runtime retains its screen snapshot until it reloads the new application. Published reads and actions reject stale publication tokens after republishing. Operator actions and gateway events use the queries and libraries captured in their application revision. Live tags and connection settings remain shared resources. Designer Preview starts read-only; administrator-enabled Live Preview can execute scripts that change local values or database rows.

## Packages and Docker

For an application release, follow the [standard preview release cycle](docs/architecture/RELEASE_PROCESS.md), including the new installer, workshop verification, GitHub publication, website downloads and hosted docs.

The [template workshop](examples/template-properties.json) demonstrates typed public Number/Boolean parameters, per-instance overrides and inherited wrapper properties. The [state controls workshop](examples/state-controls.json) adds a segmented multi-state input, an independently bound state indicator and a masked password field. Load missing resources with `node tools/load-example.mjs state-controls`; review navigation and publish through Designer. Password defaults must be blank; authored scripts can receive entered values, so masking is not credential storage or authentication. The example reports only whether its masked field was entered.

See the [component roadmap](docs/architecture/COMPONENTS.md) for current control contracts and remaining component families. Palette presence does not imply full subsystem or compatibility support.

```powershell
.\tools\publish-windows.ps1
.\tools\build-installer.ps1
```

The self-contained folder is generated under `artifacts/windows-x64`; the installer and checksum under `artifacts/installer`. These outputs and runtime data are not source files and should not be committed.

For Linux x86-64 and ARM64, use the [Docker deployment guide](docs/architecture/DOCKER_RELEASE.md) and [example Compose file](compose.yaml):

```powershell
docker compose pull
docker compose up -d --wait
docker compose exec gateway sparkstudio-admin setup
```

Open `https://localhost:8443`; HTTP on 8090 redirects there. The Windows gateway can continue using 5090. Compose defaults to host loopback, creates a persistent self-signed certificate and retains a named data volume. Create your own administrator through the container-local command above and deliberately trust the public certificate, or supply a trusted PEM pair. Read the guide before enabling LAN access or upgrading. Real connectors still need their configured servers. Third-party Python packages, automatic certificate renewal and cross-version recovery acceptance remain future work.

## Feature workshops

The [workshop catalog](examples/README.md) covers 58 authored examples. 37 build into independent, importable `.sparkproj` projects; 21 require gateway tags, databases, industrial lab devices, administrative exercises, AI credentials or local image assignment and are clearly listed separately. Each major feature includes a workshop, walkthrough, prerequisites and verification. The portable collection uses synthetic data. Visitor check-in requires a webcam and internet access to Labelary; the other portable exercises work offline.

Preview.12 supports [Modbus TCP, Allen Bradley EtherNet/IP, Siemens S7 and Beckhoff ADS](docs/architecture/INDUSTRIAL_DEVICE_CONNECTIONS.md) through shared device sessions, saved point maps, polling and reviewed scalar commands. Raw storage and engineering types can differ for numeric scaling; native symbolic browse identities remain separate from saved point IDs. Follow the setup-required industrial workshop and record acceptance against each actual controller/firmware before deployment.

Designer **Search project** (Ctrl+Shift+F / Cmd+Shift+F) finds draft resources, properties, bindings, queries and scripts, with direct navigation and structured-reference views. See [project search](docs/architecture/PROJECT_SEARCH.md) and its portable workshop. Run `node tools/test-project-search.mjs` with Node 22.17 or newer to check the pure index and reference contracts offline.

Screen/template renames and canvas-resource deletions have [change previews](docs/architecture/RESOURCE_CHANGES.md), reference blockers and one-step Undo. Names retain stable resource IDs. Code-text matches require review and are never rewritten automatically. `node tools/test-resource-changes.mjs` checks these preview/apply contracts offline.

**Search project → Replace…** (Ctrl+Shift+H / Cmd+Shift+H) previews literal replacements in supported display text or tag paths. Select the properties to change, apply them as one undoable draft edit, then save and publish explicitly. Stable IDs, code, SQL, expressions and input values are excluded. See [bulk replacement](docs/architecture/BULK_REPLACEMENT.md) and run `node tools/test-bulk-replacement.mjs` for its offline contracts.

The newest workshops cover the following authoring and gateway increments:

- [Scheduled backups](docs/architecture/SCHEDULED_BACKUPS.md): multiple destinations and schedules, encrypted downloads, independent retention and published/draft restore checkpoints. Its dedicated loader creates a new project; new schedules start disabled with a 02:00 gateway-local default and seven-day retention.
- [Gateway recovery](docs/architecture/GATEWAY_RECOVERY.md), [tag engineering](docs/architecture/TAG_ENGINEERING.md) and [network access](docs/architecture/NETWORK_ACCESS.md): offline full-data recovery, derived tags/reviewed imports and HTTPS listener setup. These exercises require deliberate gateway setup.

- [Canvas precision](docs/architecture/CANVAS_PRECISION.md) and [authoring defaults](docs/architecture/AUTHORING_DEFAULTS.md): matching geometry, custom grids and starting dimensions for new resources.
- [Visual styles](docs/architecture/VISUAL_STYLES.md) and [caption translations](docs/architecture/LOCALIZATION.md): shared appearance, local overrides and offline language resources.
- [Preview communication](docs/architecture/PREVIEW_COMMUNICATION.md) and [Designer diagnostics](docs/architecture/DESIGNER_DIAGNOSTICS.md): guarded live actions and explicit diagnostic snapshots.
- [Asset library](docs/architecture/ASSET_LIBRARY.md): local image usage and selected replacement with one Undo step. Assign uploaded images before publishing this setup-required exercise.
- [Gateway console and diagnostics](docs/architecture/GATEWAY_CONSOLE.md): administration, session inventory and bounded process/API observations.
- [Publication history](docs/architecture/PUBLICATION_HISTORY.md): checked revisions, reviewed restore, retention limits and preserved drafts.

Focused automated checks and prior 24-project portable package round trips are recorded in the [verification ledger](docs/architecture/PARITY.md). Match each workshop bundle to its tested gateway build; new setup-required workshops and external deployments have separate acceptance requirements.

```powershell
node tools/build-workshops.mjs --version 2026.09.29.4
```

`artifacts/sparkproj/` is the only maintained location for individual `.sparkproj` files, with guides and a current index. Every build updates it and creates a separate immutable ZIP, manifest and checksums under `artifacts/workshops/<version>/`; it does not create loose packages there. Distribute the ZIP alongside a compatible installer release or share individual packages from `artifacts/sparkproj/` with their guides. End users import through **Projects → Import .sparkproj** without build tools. Match the package to its compatible gateway build. See [building and verifying workshop releases](examples/README.md#building-and-verifying-a-distribution).

## Source layout and verification

Read the [source boundary guide](docs/SOURCE_BOUNDARY.md) and run `tools/install-source-hooks.ps1` after cloning. Never commit vendor reference material, private runtime data or generated packages.

| Path | Purpose |
| --- | --- |
| `apps/web` | Browser designer and operator runtime |
| `src/SparkStudio.Gateway` | Project, tag, publication, query and script services |
| `src/SparkStudio.Connectors` | OPC UA, SQL Server and managed SQLite connectors |
| `src/SparkStudio.Connectors.Tests` | Connector, disposable SQLite and isolated subscription checks |
| `runtimes/python/worker.py` | Original Python worker protocol and API wrappers |
| `installer` | Windows installer and service lifecycle helper |
| `tools` | Build, example-loading and test scripts |
| `examples` | Synthetic application resources and an authored image |
| `docs/architecture` | Product contracts, evidence and limits |

Recorded checks include gateway, action/publication, template, asset/popup and connector suites, Windows browser interactions, offline non-root Linux operation and execution from the extracted Windows installer. Counts and boundaries are in [PARITY.md](docs/architecture/PARITY.md).

For SQLite-specific checks, run `dotnet run --project src/SparkStudio.Connectors.Tests -- --sqlite-integration` using the workspace SDK, then `node tools/test-sqlite-application.mjs` against an isolated gateway on port 5091. The recorded source run passed 157 connector checks and 12 gateway groups, covering actual SQL, Python datasets/affected counts, cancellation, path rejection, optimistic conflicts and published-query isolation. The gateway harness restores the prior project but retains its uniquely named connection, query and database fixtures in the disposable data directory.

`node tools/test-sqlite-example.mjs` runs 20 loader checks using fixtures, a mocked HTTP transport and the local Python runtime, with no gateway connection. It verifies reserved-resource conflict detection, absence of HTTP mutations on conflict, whole-number record identities and zero-quantity handling before SQL execution.

Gateway integration scripts mutate fixtures and must use an isolated data directory on local port 5091. Do not point them at a development or operational project. The site and downloadable release artifacts are maintained separately from this source repository.

Gateway integration checks require CPython and include SQLite and actual Python executions. Use the isolated aggregate runner below; it works from any current directory and avoids a running development gateway’s build files. After building the gateway, `node tools/test-gateway-events.mjs` creates and stops its own Windows fixture on port 5091, including real CPython and the existing scripting regressions. `node tools/test-gateway-events-workshop.mjs` separately checks the authored package on port 5092. Both require those ports to be free and retain synthetic evidence under ignored `.data/test-evidence/`; they do not use installed gateway data.

Component messaging checks run with `node apps/web/check-component-messages.mjs`, `node apps/web/check-component-message-helpers.mjs` and `node apps/web/check-component-actions-authoring.mjs`. `node tools/test-component-messaging-workshop.mjs` uses its own disposable gateway on free port 5092 for import, validation, publication and re-export. Set `SPARKSTUDIO_TEST_GATEWAY_DIR` to an isolated build directory when the development gateway locks the normal build output.

Python lifecycle and session messaging use one **Actions & Events** editor. Import [the workshop](artifacts/sparkproj/lifecycle-session-messaging.sparkproj) and follow [its guide](docs/architecture/LIFECYCLE_SESSION_WORKSHOP.md) to compare two operator tabs, broadcast from a gateway event and target a single tab. Python `system.ui.sendMessage` addresses live same-project operator tabs; browser `app.sendMessage` remains local. `self.text` changes a caption and `self.value` changes a writable form value. All shared script editors offer **Check syntax**, which compiles without executing authored code, and context-specific help. Run `node apps/web/check-runtime-session-messaging.mjs`, `node apps/web/check-script-syntax.mjs` and `node tools/test-lifecycle-session-workshop.mjs` for transport, syntax-model and isolated real-gateway acceptance. The last command uses `artifacts/lifecycle-messaging-tests` and free loopback port 5094. Add `--package <extracted-installer-directory>` to verify its manifest hashes and exercise the exact packaged gateway, browser assets and bundled runtimes instead. Add `--browser` to retain that isolated fixture for browser verification; write `browser-done` in its printed evidence directory when finished.


## Aggregate offline verification

Run `node tools/build-quality.mjs` to execute all mandatory quality gates without copying a product build into the development output. Frontend lint uses the ESLint and typescript-eslint recommended correctness rules, plus self-comparison, constructor-return, constant-expression and loop checks. Intentional control-character validators have narrow documented exceptions. Backend lint recompiles Gateway, its production connector/source-worker dependencies and the Windows service helper with the pinned SDK's Recommended analyzers and production warnings as errors; generated files and test fixtures are not production lint inputs. Ruff checks the Python worker and three container runtime tools for syntax, undefined/unused names and bug-prone constructs. Its reviewed platform wheel and extracted standalone binary are hash-verified under ignored `.tools/ruff/`; embedded Python requires no pip or installed packages.

`node tools/check-complexity.mjs` measures all frontend modules, production C# members/accessors/local functions/callbacks, and the four production Python files. New functions must remain at or below 20. Existing functions above 20 have explicit reviewed ceilings in `tools/complexity-baseline.json`; increases fail, and builds never regenerate the baseline. Reports list the analyzed source files and hashes under `.data/quality/complexity/`. Any baseline adjustment requires a deliberate reviewed source change.

Web complexity reports use the existing TypeScript compiler to inspect every
executable function in `apps/web/src`, including JSX callbacks. Run
`node tools/analyze-web-complexity.mjs --label before` before a refactor, then
`node tools/analyze-web-complexity.mjs --label after --compare .data/complexity/before.json`.
The ignored `.data/complexity/` folder receives JSON with every function, source
hashes and decision counts, plus Markdown rankings and before/after comparisons.
Each function starts at 1; branches, loops, catches, conditional expressions,
non-default switch cases and `&&`, `||`, `??` add decisions. Nested functions
are measured separately. This syntax-based metric is a maintainability signal:
extracting a helper lowers its caller's score while preserving its decisions,
and adds another function base. Review maximum scores and decision totals together.
`node tools/test-web-complexity.mjs` verifies the metric and report comparisons;
the aggregate offline runner includes these checks.

Install dependencies once with `npm ci --prefix apps/web`. The aggregate restores both test
projects with locked dependencies into `.data/test-build` before compiling them.
On Windows, `tools/bootstrap.ps1` supplies the pinned SDK and CPython; otherwise set
`SPARKSTUDIO_PYTHON` to an absolute CPython executable. The aggregate runner chooses
the workspace SDK when present, or `SPARKSTUDIO_DOTNET`/`dotnet` on PATH. Restore with
the same SDK and NuGet cache used by the runner.

Run `node tools/test-all.mjs` (or pass its absolute path from another directory).
It builds isolated Release test outputs, executes real gateway/CPython and SQLite
checks, compiles the worker, typechecks/builds the browser, and runs every offline
browser suite plus the explicitly listed offline tooling suites. It continues after
suite failures and writes JSON, JUnit and individual logs to `.data/test-results/`.
`--node-only` runs the browser/model/tooling portion. The .NET consoles likewise
continue independent suite groups and accept `--results <json-path>` for JSON/JUnit.
A failed assertion stops its current suite, preserving meaningful fixture cleanup;
it does not suppress later suites. Counts in historical verification remain records
of those builds, not promises for the current tree.

The Product validation CI job runs all four mandatory gates on Windows and Linux with restored
locked dependencies. Live device, SQL Server, browser and elevated service acceptance
remain separate tests; the offline aggregate never connects to installed gateways.

Ask Spark is available throughout the engineering workspace. Configure Gemini in
Gateway Settings → AI, then use typed messages, voice transcription or pasted
screenshots. See [Ask Spark setup and workshop](docs/architecture/ASK_SPARK.md)
for context, tool permissions, draft Undo, privacy and publication review.
