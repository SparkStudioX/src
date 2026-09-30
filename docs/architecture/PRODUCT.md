# Product and architecture

SparkStudio is an independently implemented industrial application platform with a browser Designer, an operator runtime and a self-hosted .NET gateway. Windows is the first distribution target. The Linux container path has bounded offline runtime evidence; lifecycle and external connector acceptance remain separate gates. There is no native macOS gateway package.

This page describes the current source tree as reviewed on September 30, 2026, including development changes. It is not an installer feature manifest. Start with the [documentation index](README.md); use [verification and roadmap](PARITY.md) for dated evidence and [Windows installation](WINDOWS_INSTALLER.md) for the released package boundary.

## Architecture

| Area | Current implementation |
| --- | --- |
| Application building | Fixed X/Y canvas, 44 component types including sixteen inputs, multiple selection, flat groups, resizing, snapping, alignment/distribution, size matching and Undo/Redo. Embedded, tab, split and dock containers retain independent pane state. |
| Projects | Catalog, create/rename/duplicate, archive/restore, draft-only `.sparkproj` import/export and reviewed operator publication history. |
| Gateway | ASP.NET Core/.NET 10, Windows self-contained distribution and service tooling, Linux container recipe. |
| Browser | React/TypeScript Designer and operator; bundled editor/assets with no required application CDN. |
| Identity | Local accounts, separate engineering/operator sessions, View/Operate/Commands/Design/Publish project grants, administrator controls and bounded local audit. |
| Scripting | CPython libraries and seven gateway event families; browser startup/screen JavaScript; JavaScript or Python on supported input/lifecycle/property/message events; a shared component Actions & Events editor; bounded gateway notifications to connected same-project operator tabs. |
| Reuse | Typed template parameters and parent-context fx, private instance state, nested templates/saved repeaters through four levels, nested query repeaters and contextual popups. |
| Data | Memory, OPC UA and expression tags; OPC UA client; parameterized SQL Server and managed SQLite queries; scalar query-property bindings. |
| Presentation | Local images/icons, drawing/process controls, reusable visual styles and offline caption translations; Light, Dark and System preferences. |
| Operations | Local alarm conditions, acknowledgement/journal and bounded raw tag history/trends; gateway overview/sessions/diagnostics, connection operations, deployment settings, offline full-data recovery and online/scheduled configuration backups. |

The gateway owns saved projects, connection secrets, live tags, query execution and Python workers. The browser owns transient form and session/screen/instance state. Python UI actions can return validated presentation effects to the calling browser; they do not create a shared server-side component tree. Shared process data belongs in tags or databases.

Similar workflows or selected API names do not imply drop-in compatibility with another product. Ignition project/backup import and Java-module compatibility are unavailable.

## Authoring and application behavior

Components expose typed property sheets, bounded expressions, scalar named-query bindings and dedicated structured editors. Template parameters can read the containing form's parameters, non-password inputs, static custom properties and typed state. Input values can connect directly to compatible state declarations. Private template state belongs to each concrete placement or repeat row; public parameters do not become shared mutable state.

One Actions & Events editor covers button actions, input change/commit, mount/unmount, observed scalar property changes and component messages. Python events require gateway authorization and saved definitions. Template/repeater wrappers support Python automatic events in their containing form; ordinary children retain their own instance context. Password controls support redacted non-input Python events, while password change/commit remains JavaScript-only. Lifecycle work has bounded queues, cleanup and stale-helper protection; unmount can read captured values but cannot change a retired UI. Browser `app.sendMessage` stays within one application tab, while gateway `system.ui.sendMessage` can broadcast to the same project's operator tabs or target one session. See [component events](COMPONENT_LIFECYCLE.md), [Python component events](PYTHON_COMPONENT_EVENTS.md), [messaging](COMPONENT_MESSAGING.md) and [Python UI actions](PYTHON_UI.md).

Project tools include resource search/usage, reviewed rename/delete and bounded bulk replacements, asset replacement, publication history, visual styles, caption translations and diagnostic snapshots. These have explicit scopes; they are not arbitrary source-code refactoring or complete dependency analysis. The [component guide](COMPONENTS.md) distinguishes implemented controls from planned families.

## Drafts, publications and runtime state

Projects are JSON resources under `projects/<id>/` in the data directory. Save uses optimistic revisions. A `.sparkproj` carries saved drafts and referenced assets, not unsaved browser edits, accounts, credentials, live tags, databases or local publication history. Import creates a new unpublished project.

Operator publication captures screens, templates, component handlers, query definitions, Python libraries and gateway/browser script resources as one reviewed revision. Published reads/actions validate their publication identity; stale clients must reload after replacement. Up to 20 checksummed application snapshots support reviewed restore, subject to byte limits. Legacy snapshots that predate unified publication disclose their narrower scope before restore. See [projects](PROJECTS.md) and [publication history](PUBLICATION_HISTORY.md).

Connections and live tags remain shared gateway resources. Transient browser values reset according to their declared lifetimes and never enter a project export. Python effects apply only to the original live owner and reject conflicting newer edits. Failed UI-effect batches do not roll back gateway/database side effects that already occurred.

Designer [Preview](PREVIEW_COMMUNICATION.md) starts live read-only. Native local inputs, pure bindings and read queries work; authored scripts and writes are blocked. An administrator can deliberately enable expiring live actions for one engineering session/project. Python resolves saved draft definitions, so save handler changes before testing. Leaving Preview cannot undo completed external effects.

## Tags and connectors

[Tag engineering](TAG_ENGINEERING.md) includes persisted memory values, OPC UA mappings, scalar expression dependencies, quality/source timestamps and reviewed additive bulk import/export. Types include Boolean, Int16, Int32, Int64, Float, Double and String. Expressions have bounded evaluation and cycle/type checks. The default provider, versioned UDT definitions and pinned instances, instance overrides and named scan groups are supported. Reviewed Equipment Commands support typed scalar OPC UA writes, separate Commands permission, serialized dispatch and bounded readback. General Python tag writes remain memory-only.

The OPC UA client supports discovery, secured browse/read, monitored items, reconnect and connection revision/enable controls. Read-only quick watch and dependency observations aid diagnosis. Gateway Settings lists public OPC certificates, permits public-certificate download, verified-fingerprint trust and reviewed trust removal. Automated renewal and broader vendor/load/recovery acceptance remain open; an OPC UA server and native device drivers are separate work. See [connection operations](CONNECTION_OPERATIONS.md).

SQL Server and managed SQLite provide typed parameters, bounded reads and explicit INSERT/UPDATE/DELETE query resources. SQLite creation, schema browsing and guarded application edits have recorded local evidence. Read-query testing supports deadlines/cancellation; interrupted writes may have uncertain outcomes. Live SQL Server end-to-end acceptance remains open. Query validation supplements database permissions. See [query controls](QUERY_CONTROLS.md), [query properties](QUERY_PROPERTIES.md) and [read testing](QUERY_TESTING.md).

## Python and execution boundaries

CPython workers and standard-library dependencies are packaged. Scripts are trusted code with the gateway account's OS access; process separation is not a sandbox. Published modules import through `project.<module>`. Tag reads use current gateway values, configured memory writes persist locally, and named-query writes are explicit. Scoped `self`/`system.ui` helpers stage local presentation changes separately from shared gateway data.

Gateway events cover startup, update, shutdown, fixed-delay/fixed-rate timers, tag changes, named messages and time-zone-aware cron. They have bounded shared/dedicated execution, configurable resource deadlines, cancellation and persistent diagnostic history. Shutdown is best effort; missed schedules are not durably replayed. Browser startup/screen resources remain JavaScript. Offline third-party Python environments, deeper debugging and durable job delivery remain planned. See [scripting](SCRIPTING.md) and [gateway events](GATEWAY_EVENTS.md).

## Deployment and recovery

Remote account/API access requires HTTPS; plain HTTP is restricted to loopback. First administrator setup is local. Engineering and operator cookies, CSRF checks, project grants, revocation and tag scopes enforce API access. External identity/MFA, finer operation grants and tamper-evident audit remain separate work. Trusted author scripts retain their OS/origin privileges; see [security](SECURITY.md).

The Windows installer offers local-only or network HTTPS configuration, with supplied or generated certificates. Preview.8 extraction/package checks and earlier single-host LocalService installation/upgrade evidence are recorded separately. Preview.8 elevated upgrade, remote-client trust/firewall acceptance, rollback, uninstall, secret portability and broader host coverage remain open. Container runtime evidence does not establish Linux connector, upgrade or volume-recovery acceptance.

[Offline recovery](GATEWAY_RECOVERY.md) encrypts and restores a stopped gateway's data into a new destination with recovery quarantine. [Scheduled backups](SCHEDULED_BACKUPS.md) capture online configuration and support reviewed downloads/destination delivery; they exclude live databases and audit/history data. External databases need their own backups. Application publication and rollback capture screens, queries and scripts together. Startup supports a guarded legacy version-1 to version-2 tag-data migration with preserved original bytes and future-format rejection. General cross-version migration, downgrade and production-scale recovery remain open.
