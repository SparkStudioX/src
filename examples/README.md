# SparkStudio workshops

Each major user-facing feature should ship with an independently authored workshop project, a short exercise guide, compatibility information and a verified import/publish/runtime check. Workshops serve as both learning material and reproducible acceptance examples. Use synthetic data and make any gateway setup or writes explicit.

[catalog.json](catalog.json) is the machine-readable inventory of all 21 source examples. Fifteen are portable project workshops; six require additional gateway setup. The package builder uses this catalog to produce the portable `.sparkproj` files and their exercise guides. Generated files belong in the ignored `artifacts/` directory, not in the source repository.

## Use a downloaded workshop

1. Use the SparkStudio build identified by the workshop bundle, or a newer compatible build with its listed features. The first `v0.1.0-preview.1` installer predates this collection. A package's format version describes the archive, not the feature set supported by an older application.
2. Sign in to Projects as a gateway administrator and choose **Import .sparkproj**. Importing a `.sparkproj` creates a new, unpublished project; it does not replace an existing application or configure gateway resources.
3. Open the new project in Designer. Review its screens, bindings and scripts, and follow the supplied workshop guide. Preview is useful for checking the authored interactions.
4. Publish the project, grant the intended user View access and, where Python buttons are part of the exercise, Operate access. Open its operator application and complete the exercise there too. Engineering and operator sign-in are separate sessions.
5. Repeat an exercise by reopening the application or importing a fresh copy. Browser session values are not saved in the package. Examples that write memory tags need their explicitly declared gateway values reset separately.

The portable collection needs no OPC UA server, SQL Server, external database or internet connection during use. Query properties uses the gateway's built-in synthetic sample provider. Process displays and process graphics use deliberately undefined synthetic tag paths for their unavailable-data exercises; leave those paths undefined as their guides specify. Read-only Python preview buttons need the Python runtime shipped with the matching gateway package. Browser-only workshops do not depend on Python actions.

Project packages carry saved screens, templates, queries, script drafts and referenced local images. They do not contain accounts, grants, credentials, connection configuration, tag definitions or values, databases, active publications or live browser state. See [project packages](../docs/architecture/PROJECTS.md) for the complete format and import rules.

## Portable collection

| Workshop | What to try | Python actions |
| --- | --- | --- |
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
| [Component lifecycle and property events](component-events.json) | Compare user/property events, popup cleanup and deliberate bounded failures. | None |
| [Named-query property bindings](query-properties.json) | Drive values, layout and visibility from synthetic query results. | Read-only refresh button |

The catalog records a common verified feature baseline by source commit rather than guessing a minimum installer version. Each generated bundle records its actual source revision and release label. A workshop may be distributed as an individual `.sparkproj` with its guide or as part of the collection accompanying a release.

## Examples that require gateway setup

These remain useful authored source fixtures, but are excluded from the standalone portable collection. A raw example JSON file is not a `.sparkproj` import file. The six examples below require deliberate setup because a project package cannot provide the gateway resources they use.

| Source example | Additional setup | Runtime writes |
| --- | --- | --- |
| [Operator form](application-form.json) | Four synthetic `Application` memory tags. | Explicit Python save writes those tags. |
| [Operator inputs](operator-inputs.json) | Six synthetic `InputWorkshop` memory tags. | Explicit Python save writes those tags. |
| [Expression bindings](property-bindings.json) | One synthetic Boolean `BindingWorkshop/Permit` memory tag. | None; the Python action only returns form values. |
| [Reusable applications](reusable-applications.json) | Twelve synthetic `Workcenters` and `Orders` memory tags. | Explicit save/release actions write those tags. |
| [Images and popups](assets-popups.json) | Eight synthetic memory tags and the local drawing in `examples/assets/assembly-cell.png`. | Explicit popup save/release actions write those tags. |
| [SQLite data controls](data-controls.json) | Separate managed SQLite connection and synthetic database initialized by its dedicated loader. | None during the exercise; setup creates and seeds the database. |

The generic `tools/load-example.mjs <id>` loader is a development tool for an authenticated local gateway on port 5090 or 5091. It backs up and adds missing resources to the **default project**, preserves existing resource IDs and tag values, and leaves the draft unpublished unless `--publish` is supplied. It cannot retarget an arbitrary project. Prefer portable imports for the collection above. The [security verification guide](../docs/architecture/SECURITY.md#verification-commands) describes authentication for an isolated test gateway; there is no unauthenticated loader bypass.

SQLite data controls instead uses `tools/load-data-controls-example.mjs`. This creates and immediately publishes a separate project and creates its reserved sample connection/database; it refuses existing configured resources. Read the catalog's prerequisites before running either kind of loader. Use an isolated development gateway for examples that configure shared tags or connections.

## Building and verifying a distribution

Run from the source repository root with Node.js; no gateway, credentials, downloads or extra npm packages are needed to build:

```powershell
node tools/test-workshop-build.mjs
node tools/build-workshops.mjs --version 2026.09.29
```

The output is a fresh `artifacts/workshops/<version>/` folder. The builder refuses to overwrite an existing folder; use a new version label for a new artifact. It reads the catalog and authored definitions, never a running gateway or development project export. Packages carry draft projects only. Asset-backed and gateway-setup examples stay out of the initial standalone collection.

Each bundle contains `projects/*.sparkproj`, `guides/*.md`, the corresponding authored definitions and feature guides, `catalog.json`, `manifest.json` and `SHA256SUMS`. The walkthroughs work offline; wider links in the feature guides may require the full source checkout. The standalone `SparkStudio-Workshops-<version>.zip` contains the same payload; its adjacent `.sha256` covers the ZIP itself. The manifest records the actual source revision, dirty-worktree status, required feature baseline and every payload hash/size. Build timestamps default to the source commit timestamp for reproducibility; `SOURCE_DATE_EPOCH` can explicitly set them. A bundle label is independent of the gateway version.

Before distributing a bundle, validate it against an isolated gateway built from the companion release. Port 5091 and a disposable data directory are required; the verifier creates, publishes and then archives test projects. It does not invoke their action scripts or alter gateway tags/connections:

```powershell
$env:SPARKSTUDIO_TEST_AUTH_FILE = '.data/test-evidence/security-test-accounts.json'
node --import ./tools/test-auth-session.mjs tools/test-workshop-packages.mjs artifacts/workshops/2026.09.29
```

The credential file must come from the existing isolated [security test workflow](../docs/architecture/SECURITY.md#verification-commands). Also exercise each new or changed walkthrough in Designer and runtime; package tests verify structure and gateway compatibility, not every operator interaction. CI runs the offline catalog/package checks without credentials. The gateway verification and walkthroughs remain release checks.

Build the final distribution from a clean source commit. Attach the ZIP and checksum to a compatible release in **SparkStudioX/releases**, or create a separately versioned workshop release there. State the tested gateway build and feature baseline in its release notes. Keep that repository source-free: upload generated assets and user guides, not application code. To share one workshop, include its `.sparkproj`, guide and package hash from the manifest. No new public release is created by the builder.

The initial collection passed all nine offline build checks and real import/publication/operator-query/re-export checks for all 13 portable packages against the `2143ecc` gateway build. No workshop automatically publishes itself. Older source fixtures retain their existing documented runtime checks; future feature changes require their walkthrough to be verified again.

## Adding a workshop with a feature

1. Add an independently authored `examples/<id>.json` with a clear starting screen, synthetic values and a small sequence that demonstrates the feature and an important failure or reset case. Avoid dependencies on a developer's existing project, equipment or credentials.
2. Add the catalog entry with its feature prerequisites, starting screen, guide, walkthrough and actual gateway-write behavior. Mark it portable only when importing its package is sufficient; otherwise explain the separate setup and keep it out of the standalone bundle.
3. Build the package from checked-in definitions. Verify a fresh import, publication and the documented operator interactions against the intended release build. Check reset, error and context behavior when relevant. Preserve authored defaults in the exported result.
4. Record the build/revision and verification with the release. Distribute the `.sparkproj`, guide and checksum together, either with the installer release or as a separate workshop collection. Keep generated packages and test/runtime data out of Git.

Feature completion includes its workshop and validation. The exercises may expand as the feature grows, but compatibility changes must be reflected in the catalog and distribution metadata.
