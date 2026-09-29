# Product and architecture

SparkStudio is an independently implemented industrial application platform for practical internal tools. This preview combines a browser designer and operator runtime with a self-hosted, non-Java gateway. Windows is the first gateway target; Linux containers are exercised, while macOS browser validation and native gateway packaging remain future work.

## Decisions

| Area | Current direction |
| --- | --- |
| Application building | Fixed X/Y canvas with marquee/multiple selection, persistent flat groups, proportional group resizing, snapping, alignment/distribution, duplication and Undo/Redo; 29 component types including fourteen inputs. Runtime fitting preserves authored geometry. |
| Projects | Projects home, create/rename/duplicate, archive/restore and draft-only `.sparkproj` import/export. Project resources and publications live in separate on-disk directories. |
| Gateway | ASP.NET Core/.NET 10; Windows self-contained package/service tooling and Linux container. |
| Browser | React and TypeScript; no native desktop designer is required. |
| Identity and access | Local gateway accounts, separate engineering/operator sessions, project View/Operate/Design/Publish grants, gateway administrators and a bounded local audit trail. |
| Scripting | Persistent resource workspace, reusable CPython libraries, gateway startup/timer events and explicit browser JavaScript startup/screen events. No Jython. |
| Connections | OPC Foundation .NET client, Microsoft.Data.SqlClient and managed local SQLite databases. |
| Appearance | Neutral Light default, Dark and System; preferences persist per browser and synchronize between same-origin tabs. Explicit component colors remain intact. |
| Reuse | Single-level templates and saved-row repeaters with isolated input/action state. |
| Assets and dialogs | Immutable local PNG/JPEG/WebP assets, bundled icons and one parameterized modal at a time. |
| Compatibility | Similar workflows and selected API names do not imply drop-in compatibility. Ignition project/backup import is unavailable. |

The gateway owns projects, connections, live tag state, named queries and Python execution. Browser clients render and edit resources through its API. Secrets and connector execution belong on the gateway.

## Current application-building rounds

The first round expands the initial four inputs with multiline text, spinner, slider, radio group, local date/time and toggle controls. All ten input types participate in the existing form, template, saved-row and popup context model. A scripted button action submits declared, typed inputs. Controls edit form state; they do not directly write an OPC device. Numeric `step` is a UI stepping hint, not a requirement that submitted values divide evenly by the step. A date/time value is an optional `YYYY-MM-DDTHH:mm` local wall-clock string with no timezone conversion; an empty string is valid.

The second round adds multiple selection, movement by a shared bounded delta, grid choices Off/4/8/16, alignment, equal-gap distribution, duplication, deletion and Undo. Grid snapping is based on the selection's origin, so relative offsets remain intact. Distribution requires three or more selected components and available nonnegative spacing. Duplication retains z-order and independent property values, assigns unique IDs and input field names, and leaves script/binding text unchanged for author review.

Later rounds added persistent flat groups, marquee selection, group resizing, Redo and a property sheet with bindings for common appearance/layout fields. Input change/commit handlers run trusted browser JavaScript with typed same-form assignments. Query-backed dropdowns populate forms from named-query rows, while bound display tag paths follow the selected machine. Mutable custom/session properties and generic property-change events remain future work. The public installer and Linux image remain the earlier baseline. The synthetic [operator inputs example](../../examples/operator-inputs.json) exercises local memory persistence through a submit script; it does not send equipment commands. See [COMPONENTS.md](COMPONENTS.md) and [QUERY_CONTROLS.md](QUERY_CONTROLS.md) for behavior and limits.

## Drafts, publications and runtime state

Projects are persisted as JSON resources in `projects/<id>/` beneath the gateway data directory. A `.sparkproj` is a portable ZIP of saved draft resources and referenced assets; importing creates a new unpublished project. It excludes gateway connections, credentials, live tags, databases, accounts, access grants and gateway security/audit files. Saving uses an optimistic revision and completes persistence before replacing in-memory state. Publishing validates the saved revision and captures screens, templates, action scripts, referenced table/choice/repeater query definitions and an internal named-query snapshot for Python actions. Invalid references or stale revisions prevent publication. Runtime project responses omit Python source; actions resolve saved targets and validate declared inputs under the selected publication token. See [PROJECTS.md](PROJECTS.md).

Live tags and connection definitions remain shared. Publication boundaries remain:

- Published operator actions resolve named queries from their captured project snapshot. Designer previews, manual resource runs and gateway events use that project's current draft query configuration.
- Libraries and event scripts have an independent explicit script publication. Publishing scripts updates libraries used by later operator actions; projects and libraries do not yet form one atomic release.
- An open runtime retains its loaded screens until reload. Table/dropdown reads carry that publication's identity and fail explicitly if a new version was published, preventing new query definitions from mixing with old screens. Stale published actions are also rejected; archiving or withdrawing a project clears its open runtime on the publication poll. Legacy API callers that omit the optional query token retain latest-publication behavior.

Reload after publishing or restoring a publication. [Publication history](PUBLICATION_HISTORY.md) retains up to 20 reviewed operator snapshots; multi-user editing and complete gateway backup/restore remain future work. Designer Preview starts [live read-only](PREVIEW_COMMUNICATION.md): native local inputs, pure bindings and read queries work, while Python, authored browser scripts and writes are blocked. A gateway administrator can explicitly enable temporary live actions for that engineering session and project. Trusted scripts are not sandboxed, and leaving Preview cannot undo their completed effects.

## Tags and connectors

Configured tags support OPC UA mappings or persisted memory values. Types are Boolean, Int16, Int32, Int64, Float, Double and String. Concrete `[default]` paths provide folders, with a 512-character path limit and up to 1,000 configured tags. Validation rejects malformed paths, integer fractions, overflow and nonfinite values. Disabled memory tags reject writes; external OPC writes are not implemented.

OPC UA supports discovery, secured browse/read and genuine monitored items, grouped by connection and publishing interval. Requested intervals range from 100 to 60,000 ms. Values carry quality and timestamps. Subscription reconnect behavior has isolated coverage and secured live subscriptions have been exercised on Windows. Browse/read sessions use a bounded cache of 32 slots with serialized use and configuration invalidation. Certificate renewal and broader industrial failure scenarios remain open.

SQL Server and SQLite named queries support typed parameters, bounded reads and explicit INSERT/UPDATE/DELETE resources returning affected rows. SQLite databases use managed gateway-local filenames, explicit creation and schema browsing. The synthetic work-order example exercises create/edit flows and optimistic row versions against a real local file. SQL Server supports TLS; real SQL Server end-to-end validation remains unverified. Database permissions remain necessary; a query guard is not an authorization system.

## Python boundary

Workers provide process isolation and a ten-second execution limit. Scripts are trusted code with the gateway account's OS access, not sandboxed code. The initial API includes gateway tag reads, validated configured-memory writes, named queries, logger output, JSON helpers, `system.date.now` and a small dataset wrapper. Tag reads retrieve gateway state rather than forcing a fresh device read.

Workers and standard-library Python are packaged. Published modules import through `project.<module>`. Gateway startup and fixed-delay timer events have execution logs, per-resource overlap prevention and cancellation on replacement. Browser events execute trusted JavaScript locally and receive UI helpers plus tab-local session state. The bundled editor works offline. Third-party dependency environments, offline wheels, tag-change/message/shutdown handlers and broader event APIs remain planned. See [SCRIPTING.md](SCRIPTING.md).

## Deployment boundary

The gateway now requires local-account authentication and enforces project permissions on its API. Engineering and operator cookies are separate; signing into Designer does not sign into an operator application. First setup requires a loopback connection and the one-time code stored on the gateway computer. Administrators manage users, gateway configuration and project lifecycle. Project Design permits draft editing, Publish requires Design, and published operator actions require Operate plus View. Viewer pages retain navigation and data inspection while editable inputs, input events and Python actions are disabled. Server checks enforce the same distinction independently of UI controls.

Sessions use HttpOnly, SameSite cookies, memory-only CSRF tokens and fixed expiry; account changes revoke existing sessions. Per-project tag scopes filter operator reads and streams, while runtime image access is limited to published references. A bounded local audit records authenticated actors and outcomes without form contents or secrets. Published scripts remain trusted code with gateway account access; these permissions do not sandbox Python or same-origin browser JavaScript. See [SECURITY.md](SECURITY.md) for the exact contract.

Remote account/API access requires HTTPS; plain HTTP is restricted to loopback. Certificate provisioning, proxy trust, network deployment, operational recovery and service/container lifecycle remain separate acceptance gates. External identity providers, MFA, fine-grained per-action permissions and tamper-evident audit retention remain future work. Current isolated security checks do not establish factory-network readiness.

The unsigned Windows installer includes the application and runtimes. Extraction and execution passed recorded checks; actual elevated service installation, LocalService execution, upgrade and uninstall remain unverified. Its recovery logic does not transactionally restore older binaries. The Linux container has offline non-root runtime evidence, but real Linux OPC UA/SQL, upgrades and complete volume recovery remain unverified.

See [verification and roadmap](PARITY.md), [component scope](COMPONENTS.md), [template contracts](TEMPLATES.md), [assets/popups](ASSETS_POPUPS.md) and [Windows installation](WINDOWS_INSTALLER.md).
