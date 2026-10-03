# SparkStudio workshops

Each major user-facing feature should ship with an independently authored workshop project, a short exercise guide, compatibility information and a verified import/publish/runtime check. Workshops serve as both learning material and reproducible acceptance examples. Use synthetic data and make any gateway setup or writes explicit.

[catalog.json](catalog.json) is the machine-readable inventory of all 58 source examples. 37 are portable project workshops; 21 require additional gateway setup. The package builder uses this catalog to produce the portable `.sparkproj` files and their exercise guides. Generated files belong in the ignored `artifacts/` directory, not in the source repository.

The [Ask Spark workshop](../docs/architecture/ASK_SPARK.md) uses a synthetic canvas to exercise voice transcription, pasted screenshots, context-aware edits and Undo. It needs AI configuration on a development gateway; no equipment, database or gateway tags are involved.

## Use a downloaded workshop

1. Use the SparkStudio build identified by the workshop bundle, or a newer compatible build with its listed features. The first `v0.1.0-preview.1` installer predates this collection. A package's format version describes the archive, not the feature set supported by an older application.
2. Sign in to Projects as a gateway administrator and choose **Import .sparkproj**. Importing a `.sparkproj` creates a new, unpublished project; it does not replace an existing application or configure gateway resources.
3. Open the new project in Designer. Review its screens, bindings and scripts, and follow the supplied workshop guide. Preview starts in **Live read-only**: native local inputs, pure bindings, navigation and read queries work; authored browser JavaScript and Python actions are blocked. To exercise those scripts, a gateway administrator must explicitly enable **Live actions**, or you can use the explicitly published operator application with its required permissions. Changing Preview modes resets its forms and popup; leaving Preview revokes its temporary capability.
4. Publish the project, grant the intended user View access and, where Python buttons or component events are part of the exercise, Operate access. Open its operator application and complete the exercise there too. Engineering and operator sign-in are separate sessions.
5. Repeat an exercise by reopening the application or importing a fresh copy. Browser session values are not saved in the package. Examples that write memory tags need their explicitly declared gateway values reset separately.

The portable collection needs no OPC UA server, SQL Server or external database. Visitor check-in requires a webcam, HTTPS or localhost camera access, and internet access to Labelary; the other portable exercises work offline. Query properties uses the gateway's built-in synthetic sample provider. Process displays and process graphics use deliberately undefined synthetic tag paths for their unavailable-data exercises; leave those paths undefined as their guides specify. Read-only Python preview buttons need the Python runtime shipped with the matching gateway package. Browser-only workshops do not depend on Python actions.

Project packages carry saved screens, templates, queries, script drafts, styles, translations, authoring defaults and referenced local images. They do not contain accounts, grants, credentials, connection configuration, tag definitions or values, databases, active publications/history or live browser state. See [project packages](../docs/architecture/PROJECTS.md) for the complete format and import rules.

The Gateway events workshop includes seven disabled Python resources. Import leaves them inactive; review, enable and save them before publishing the complete application. Screen and script resources are published together. Its optional tag-change exercise requires one memory tag configured outside the package. The other event examples require no equipment or database setup.

The Python UI workshop keeps its core exercise local to the calling browser form: property overrides and declared state are returned by Python without changing the project or other operator tabs. Its optional shared-title display begins unavailable. The [Python UI guide](../docs/architecture/PYTHON_UI.md) explains how to create a separate String memory tag and add a deliberate shared write action; neither gateway setup nor that write action is included in the portable package.

## Portable collection

The [Visitor check-in workshop](../docs/architecture/VISITOR_CHECKIN.md) combines
name/email inputs, static host choices, Computer camera capture and a returned
Labelary badge image. Its maintained package is
`artifacts/sparkproj/visitor-checkin.sparkproj`. Dismiss clears local visitor data
and returns to the welcome form. It requires preview.11 or a later compatible
build; preview.10 installers do not support it.

| Workshop | What to try | Python actions |
| --- | --- | --- |
| [Python UI](python-ui.json) | Rename a button with `self.text`, change local titles from Python, compare independent template rows, then follow the optional shared-tag extension. | Local UI property/state effects only; shared tag writes require explicit guide setup |
| [Python component events](python-component-events.json) | Load synthetic work orders through input handlers, observe property changes and reset one form through messages. | Input, property and message handlers; independent template and row state |
| [Component messaging](component-messaging.json) | Send from native buttons and JavaScript input events; compare instance, screen and popup session receivers and cleanup. | None |
| [Gateway events](gateway-events.json) | Configure startup, update, shutdown, timer, tag-change, message and cron events; inspect retained logs and cancellation. | Seven disabled diagnostic-only scripts; enable and publish deliberately |
| [Canvas precision](canvas-precision.json) | Select by type, match grouped dimensions and inspect numeric grid coordinates. | None |
| [Reusable visual styles](visual-styles.json) | Share style resources, compare local/bound overrides and inspect protected references. | None |
| [Preview communication](preview-communication.json) | Verify default action denial, explicitly enable temporary Live actions and reset back to read-only. | Optional return-only messages |
| [Publication history](publication-history.json) | Restore an earlier operator snapshot while preserving the current Designer draft. | None |
| [Designer diagnostics](designer-diagnostics.json) | Capture intentional property failures, filter their messages and open the owning controls. | None; optional deliberate browser-event failure |
| [Offline caption translations](localization.json) | Switch languages while preserving form values; inspect missing-translation fallback. | None |
| [Canvas authoring defaults](authoring-defaults.json) | Set new-document sizes and grid defaults while existing geometry stays unchanged. | None |
| [Gateway operations](gateway-operations.json) | Inspect the administrator inventory, disposable sessions and local support diagnostics. | None |
| [Bulk replacement](bulk-replacement.json) | Preview selected text replacements, preserve form values and undo a whole batch. | None |
| [Resource changes](resource-changes.json) | Preview renames and deletion impact, inspect blockers and undo changes. | Read-only message button |
| [Project resource search](project-search.json) | Find resources, follow structured references and distinguish script-text matches. | Read-only message button |
| [Component properties and form events](component-workshop.json) | Calculate an order total, commit an order code and inspect bound geometry. | None |
| [Process displays](process-displays.json) | Compare five numeric displays and unavailable signal states. | None |
| [Process graphics and equipment](process-graphics.json) | Change pipe flow and equipment state; open the pump popup. | None |
| [Multi-state inputs and indicators](state-controls.json) | Select mapped states and preview a disposable masked input. | Read-only preview |
| [Template properties and typed parameters](template-properties.json) | Change wrapper position, size and inherited state; compare per-station limits. | Read-only preview |
| [Nested forms and saved rows](nested-forms.json) | Compare isolated nested inputs, repeated forms and popup context. | Read-only previews |
| [Template parameter expressions](template-parameter-bindings.json) | Pass machine and calculated quantity into nested forms and saved rows. | Read-only previews |
| [Session and screen state](application-state.json) | Carry session choices across screens while local counters reset. | None |
| [Two-way input state bindings](input-state-bindings.json) | Mirror accepted values across forms while invalid drafts remain local. | Read-only previews |
| [Private template instance state](instance-state.json) | Edit and reset each panel's private quantity and nested note. | Read-only previews |
| [State-driven template parameters](template-parameter-state.json) | Feed reusable forms from session, screen and private state. | Read-only previews |
| [Python lifecycle and gateway session messages](lifecycle-session-messaging.json) | Mount/cleanup, one Actions & Events editor, broadcast and targeted operator tabs. | Bundled Python; Operate permission |
| [Component lifecycle and property events](component-events.json) | Compare user/property events, popup cleanup and deliberate bounded failures. | None |
| [Named-query property bindings](query-properties.json) | Drive values, layout and visibility from synthetic query results. | Read-only refresh button |

Use the companion **0.2.0-preview.12** release or a newer compatible gateway for the complete 37-project collection. The catalog retains older minimum versions for individual exercises; runtime property bindings and visitor check-in require preview.11. Each generated bundle records its actual source revision and release label. A workshop may be distributed as an individual `.sparkproj` with its guide or as part of the collection accompanying a release. Exact frozen-bundle verification is recorded in the [release ledger](../docs/architecture/PARITY.md).

## Examples that require gateway setup

These remain useful authored source fixtures, but are excluded from the standalone portable collection. A raw example JSON file is not a `.sparkproj` import file. The examples below require deliberate setup because their gateway resources, administrative exercises or chosen image files are not supplied by these source fixtures.

| Source example | Additional setup | Runtime writes |
| --- | --- | --- |
| [Scheduled backups](scheduled-backups.json) | Disposable gateway and dedicated SMB, FTP/FTPS or S3 test targets; multiple schedules start disabled with 02:00 gateway-local time and seven-day retention. See the [backup schedule guide](../docs/architecture/SCHEDULED_BACKUPS.md). | None from the screen; administrator actions create and copy encrypted archives. |
| [Gateway recovery](gateway-recovery.json) | Disposable gateway, offline CLI backup/restore and explicit review; see the [recovery guide](../docs/architecture/GATEWAY_RECOVERY.md). | None from the screen; the administrative exercise creates archive/restored files. |
| [Gateway network access](gateway-network.json) | Disposable installation, matching DNS certificate and client trust; see the [network guide](../docs/architecture/NETWORK_ACCESS.md). | None from the screen; deployment changes are deliberate administrator actions. |
| [Gateway tag engineering](tag-engineering.json) | Synthetic memory/expression tags initialized by its dedicated loader; see the [tag guide](../docs/architecture/TAG_ENGINEERING.md). | Explicit Save actions update synthetic memory tags. |
| [Asset library and replacements](asset-library.json) | Bring/upload two local images and assign all three authored image references before publishing. | No equipment/data writes; Designer uploads assets and changes selected image references. |
| [Operator form](application-form.json) | Four synthetic `Application` memory tags. | Explicit Python save writes those tags. |
| [Operator inputs](operator-inputs.json) | Six synthetic `InputWorkshop` memory tags. | Explicit Python save writes those tags. |
| [Expression bindings](property-bindings.json) | One synthetic Boolean `BindingWorkshop/Permit` memory tag. | None; the Python action only returns form values. |
| [Reusable applications](reusable-applications.json) | Twelve synthetic `Workcenters` and `Orders` memory tags. | Explicit save/release actions write those tags. |
| [Images and popups](assets-popups.json) | Eight synthetic memory tags and the local drawing in `examples/assets/assembly-cell.png`. | Explicit popup save/release actions write those tags. |
| [Industrial devices](industrial-devices-workshop.json) | Independent Int16 lab storage, saved maps and device tags for the four protocols, including six EtherNet/IP families; see the [family/address matrix](../docs/architecture/INDUSTRIAL_DEVICE_CONNECTIONS.md#ethernetip-family-setup). | Explicit reviewed equipment commands write the chosen lab setpoint; rebind its EtherNet/IP tag deliberately between family connections. |
| [Read-only data sources](data-sources.json) | Independently authored loopback MTConnect/i3X agents and MQTT broker, explicit source configuration and reviewed imports; see the [source guide](../docs/architecture/DATA_SOURCES.md). | None. Script tests evaluate supplied payloads; automatic tag ownership is an explicit engineering opt-in. |
| [SQLite data controls](data-controls.json) | Separate managed SQLite connection and synthetic database initialized by its dedicated loader. | None during the exercise; setup creates and seeds the database. |
| [Read query operations](query-testing.json) | Managed SQLite connection and synthetic database; follow the [setup and cancellation guide](../docs/architecture/QUERY_TESTING.md). | None during reads; setup creates and seeds the database. |

The dedicated `tools/load-backup-example.mjs` creates a new Scheduled backup workshop project on an authenticated local gateway; it leaves the checkpoint unpublished unless `--publish` is explicit. It never configures backup credentials or schedules. Its read-only screen helps compare published checkpoint A with an unpublished draft B after an isolated configuration restore. Follow the guide before using any real destination.

The dedicated `tools/load-industrial-devices-example.mjs` creates only a new unpublished Industrial devices workshop project. It creates no connections or tags. Configure isolated lab profiles separately and explicitly publish after checking each mapped address. Profiles you leave unconfigured remain unavailable.

The dedicated `tools/load-data-sources-example.mjs` creates only a new unpublished Read-only data sources workshop project. Start `tools/run-data-source-simulators.mjs`, then configure MTConnect, i3X and MQTT through Connections. Review point/tag imports and automatic ownership separately. This workshop requires a build containing the source-session implementation; earlier preview.12 assets lack these additions.

The generic `tools/load-example.mjs <id>` loader is a development tool for an authenticated local gateway on port 5090 or 5091. It backs up and adds missing resources to the **default project**, preserves existing resource IDs and tag values, and leaves the draft unpublished unless `--publish` is supplied. It cannot retarget an arbitrary project. Prefer portable imports for the collection above. The [security verification guide](../docs/architecture/SECURITY.md#verification-commands) describes authentication for an isolated test gateway; there is no unauthenticated loader bypass.

SQLite data controls instead uses `tools/load-data-controls-example.mjs`. This creates and immediately publishes a separate project and creates its reserved sample connection/database; it refuses existing configured resources. The asset-library fixture requires two user-selected local images and complete assignments before publication; its configured project can then be exported through the normal project package workflow. Read the catalog's prerequisites before running either kind of loader. Use an isolated development gateway for examples that configure shared tags or connections. The Gateway operations session-revocation exercise requires a clearly identified disposable sign-in.

## Building and verifying a distribution

Run from the source repository root with Node.js; no gateway, credentials, downloads or extra npm packages are needed to build:

```powershell
node tools/test-workshop-build.mjs
node tools/build-workshops.mjs --version 2026.09.29
```

The builder adds and updates loose packages only in `artifacts/sparkproj/<id>.sparkproj`, with matching guides and a current `index.json`. This is the single maintained package directory. It refuses to overwrite an unindexed or locally edited package with different contents. Each build also creates a fresh `artifacts/workshops/<version>/` release directory containing the ZIP, manifest and checksums, without another set of loose `.sparkproj` files. Use a new version label for each immutable release artifact. The builder reads the catalog and authored definitions, never a running gateway or development project export. Packages carry draft projects only. Asset-backed and gateway-setup examples stay out of the standalone collection.

Inside each release ZIP are `projects/*.sparkproj`, `guides/*.md`, the corresponding authored definitions and feature guides, `catalog.json`, `manifest.json` and `SHA256SUMS`. These frozen archive entries are distribution snapshots; the maintained loose packages stay in `artifacts/sparkproj/`. The walkthroughs work offline; wider links in feature guides may require the full source checkout. The adjacent `.sha256` covers the ZIP itself. The manifest records the source revision, dirty-worktree status, required feature baseline and every archived payload hash/size. Verification reads packages from that ZIP so later updates to the maintained directory cannot change an older release. Build timestamps default to the source commit timestamp for reproducibility; `SOURCE_DATE_EPOCH` can explicitly set them. A bundle label is independent of the gateway version.

Check the frozen archive's manifest, packages and checksums without contacting a gateway:

```powershell
node tools/test-workshop-packages.mjs artifacts/workshops/2026.09.29 --verify-only
```

Before distributing a bundle, also validate it against an isolated gateway built from the companion release. Port 5091 and a disposable data directory are required; the verifier creates, publishes and then archives test projects. It does not invoke their action scripts or alter gateway tags/connections:

```powershell
$env:SPARKSTUDIO_TEST_AUTH_FILE = '.data/test-evidence/security-test-accounts.json'
node --import ./tools/test-auth-session.mjs tools/test-workshop-packages.mjs artifacts/workshops/2026.09.29
```

The credential file must come from the existing isolated [security test workflow](../docs/architecture/SECURITY.md#verification-commands). Also exercise each new or changed walkthrough in Designer and runtime; package tests verify structure and gateway compatibility, not every operator interaction. CI runs the offline catalog/package checks without credentials. The gateway verification and walkthroughs remain release checks.

`node tools/test-python-ui-workshop.mjs` creates its own disposable gateway on port 5092 using a gateway build at `artifacts/python-ui-tests/bin/SparkStudio.Gateway/debug` (override with `SPARKSTUDIO_TEST_GATEWAY_DIR`). It verifies fresh authored import/publication, actual CPython UI effects, `self.text`, template/row context, capability-protected Live Preview, rejected snapshots, failure handling and re-export. A separate fixture project creates the optional synthetic shared tag and verifies it through two operator sessions. `--browser` keeps only this fixture running for visual checks; press Enter or create `browser-done` inside the printed fixture directory to stop it. Set `SPARKSTUDIO_TEST_PORT=5093` when a separate fixture already owns 5092; other ports are rejected. The installed gateway and its data are not used.

Build the final distribution from a clean source commit. Attach the ZIP and checksum to a compatible release in **SparkStudioX/releases**, or create a separately versioned workshop release there. State the tested gateway build and feature baseline in its release notes. Keep that repository source-free: upload generated assets and user guides, not application code. To share one workshop, include its `.sparkproj`, guide and package hash from the manifest. No new public release is created by the builder.

The initial collection passed all nine offline build checks and real import/publication/operator-query/re-export checks for all 13 portable packages against the `2143ecc` gateway build. No workshop automatically publishes itself. Older source fixtures retain their existing documented runtime checks; future feature changes require their walkthrough to be verified again.

## Adding a workshop with a feature

1. Add an independently authored `examples/<id>.json` with a clear starting screen, synthetic values and a small sequence that demonstrates the feature and an important failure or reset case. Avoid dependencies on a developer's existing project, equipment or credentials.
2. Add the catalog entry with its feature prerequisites, starting screen, guide, walkthrough and actual gateway-write behavior. Mark it portable only when importing its package is sufficient; otherwise explain the separate setup and keep it out of the standalone bundle.
3. Build the package from checked-in definitions. Verify a fresh import, publication and the documented operator interactions against the intended release build. Check reset, error and context behavior when relevant. Preserve authored defaults in the exported result.
4. Record the build/revision and verification with the release. Distribute the `.sparkproj`, guide and checksum together, either with the installer release or as a separate workshop collection. Keep generated packages and test/runtime data out of Git.

Feature completion includes its workshop and validation. The exercises may expand as the feature grows, but compatibility changes must be reflected in the catalog and distribution metadata.

The [alarms and history workshop](../docs/architecture/PROCESS_DATA.md) adds one synthetic memory tag, two alarm conditions and a retained history source through `tools/load-process-data-example.mjs`. It is setup-required and never uses a physical device.
