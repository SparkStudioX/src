# Projects and portable packages

The Projects home at `/` manages applications on one gateway. Each project has its own Designer at `/designer/<id>` and operator application at `/runtime/<id>`. The stable ID is part of the URL; renaming a project changes its display name, not its address.

Engineering and operator access use separate sign-in sessions backed by the same gateway accounts. The engineering catalog lists accessible projects; `/?audience=operator` lists permitted published applications without management controls. Gateway administrators manage project creation, renaming, duplication, import and archive/restore. Per-project Design permits draft editing and export, while Publish additionally permits reviewed application publication; activating changed executable code also requires gateway administrator approval. View opens an operator application; Operate additionally permits its published Python actions. Design does not automatically grant operator access. See [local accounts and project access](SECURITY.md) for setup, request protection and permission limits.

Create starts with one empty screen. Open enters the Designer. Rename checks the saved project revision so a stale project list cannot silently overwrite an editor's changes. Duplicate copies saved draft screens, templates, queries, script resources and local images into a new unpublished project. Archive retains the files, stops that project's gateway event scheduler and disables its Designer/runtime API access. An already-open operator tab clears its project at the next publication check, within about 15 seconds while the gateway is reachable. Restore makes it available again and resumes its previously published gateway events. The original default project cannot be archived because legacy URLs continue to refer to it.

Designer project navigation uses full page navigation. Unsaved screen, named-query or script-resource edits open a Stay in Designer / Discard and switch dialog; closing or reloading the tab retains the browser's unload warning. Save those changes in their respective editors before exporting or switching. Export captures saved server resources, not an unsaved browser draft.

## Resource ownership

| Per project | Shared by the gateway |
| --- | --- |
| Screens, templates, component scripts and bindings | OPC UA, SQL Server and SQLite connections |
| Named queries | Connection credentials and certificates |
| Python libraries, gateway events and browser events | Tag definitions, subscriptions and values |
| Local image assets | Managed SQLite database files |
| Drafts and published snapshots | Accounts, project grants, security settings, audit and data-protection keys |

Project, query and script IDs may overlap across projects. Each project executes with its own query definitions and `project` Python library namespace. Gateway tags intentionally remain shared. Project and script publication remain separate explicit actions; this increment does not make them a single atomic application release.

## Files on disk

The configured `SPARKSTUDIO_DATA_DIR` contains:

```text
projects.json                 # catalog, stable IDs and archive state
connections.json              # gateway connections, protected secrets
tags.json                     # gateway tag definitions
keys/                         # gateway data-protection keys
security/                     # account store, settings, local audit and first-run setup code
databases/                    # managed SQLite application data
projects/
  default/
    project.json              # saved screen/template draft
    queries.json              # named-query definitions
    scripts-draft.json        # saved script resources
    scripts-published.json    # explicitly activated script resources
    published.json            # published screens and captured queries
    assets/                   # immutable local images and metadata
  another-project/
    ...
```

No database is required for project storage. The development data directory is `.data/development` beneath the application checkout. Runtime data stays out of Git.

On first startup after upgrading, the legacy project files and images are copied into `projects/default` before the catalog is committed. Existing revision and publication timestamps are retained. The original files remain as a migration fallback; after the catalog exists they are no longer the active project files. Gateway connections, tags, keys and databases retain their existing locations. Take a complete data-directory backup while the gateway is stopped when moving a gateway installation or recovering all application data.

## Designer workspace

The top document strip contains the screens and templates currently open in this browser. Clicking a resource under Project opens or activates its tab. Closing a tab changes only the workspace: it does not delete the resource, discard its draft edits or unpublish it. Close every document to return to an empty editor, then reopen any resource from Project. Open documents are remembered per project in this browser; they are not part of the project package.

Project, Components and Tags have separate left-pane tabs. Screens, Templates and Layers each scroll independently. Drag the dividers between them to adjust their heights; focus a divider and use Up/Down or Home/End for keyboard resizing. Pane proportions are remembered per project in this browser, outside project content, Undo/Redo and `.sparkproj` exports. Tags gets the pane's available height for searching, reading and binding tags.

Select a screen/template or click empty canvas space to view its property sheet. Name, dimensions and parameter defaults are editable; IDs remain stable. Project settings owns project-wide defaults and navigation. Templates support typed public parameters, parameter fx and private instance state; wrapper presentation uses the common property bindings. Runtime screen title/background bindings remain planned. Component selection restores its property sheet. These edits use the existing Undo/Redo, Save and Publish workflow. See [templates](TEMPLATES.md), [parameter bindings](TEMPLATE_PARAMETER_BINDINGS.md) and [instance state](INSTANCE_STATE.md).

## Operator navigation

The operator application displays one regular screen at a time. Its navigation is authored as part of the project; creating a screen does not create a runtime tab or menu entry. Designer document tabs remain an independent editing preference.

Open **Project settings** in the Designer to choose a startup screen and navigation mode. **None — use navigation actions** uses the controls and scripts you place on your screens. **Show selected destinations** adds a compact **Go to screen** selector containing only the destinations you add, in your chosen order, with editable labels. A screen omitted from that menu can still be opened by a navigation action. Popups use popup actions and cannot be startup or menu destinations. Menu membership is not an authorization boundary.

Save and Publish apply these settings through the normal project revision workflow; changing draft navigation does not change an operator's captured publication. Export/import and duplication preserve the configuration. Deleting a screen or converting it to a popup removes its menu entry and selects a remaining regular startup screen in the same undoable edit.

The optional project JSON field is:

```json
{
  "navigation": {
    "startupScreenId": "overview",
    "mode": "menu",
    "items": [
      { "screenId": "overview", "label": "Overview" },
      { "screenId": "workcenters", "label": "Workcenters" }
    ]
  }
}
```

Projects without this field start on their first regular screen and show no generated menu. Existing authored navigation and popup actions continue to work. A saved menu can be retained while its mode is None. Changing a publication preserves the operator's current screen if it still exists; a fresh session uses the configured startup screen.

Shared docked navigation, nested menu components, parameterized page routes and browser history/deep links are later extensions.

## `.sparkproj` version 1

A `.sparkproj` file is a bounded ZIP archive with a versioned manifest, a JSON screen/template draft, named queries, script-resource drafts and referenced local images. It is portable across SparkStudio installations using this format. It contains source text for scripts; only import projects from authors you trust and review them before publishing.

The package contains no connection credentials, connection configuration, tag values/definitions, database files or active publication. Accounts, password hashes, access grants, session cookies, gateway security settings and audit records are also excluded. Connection IDs are retained as dependencies. On a different gateway, configure the needed connections, tags and project access, then edit the imported queries or tag bindings to match. An import always creates a new project and leaves its scripts and screens unpublished. It does not replace an existing project or run startup/timer scripts.

Imports validate the manifest version, known archive paths, duplicate entries, expanded sizes, JSON definitions and image content before adding the project to the catalog. ZIP entries are read as data and never extracted to archive-controlled filesystem paths. Version 1 limits packages to 32 MiB compressed and 64 MiB expanded, with each image retaining the existing 512 KiB limit.

This is a portable saved-draft package, not a full gateway backup or historical release archive. Legacy `.spark.json` files are screen/template definitions only and do not contain queries, script resources or images.

## API and compatibility

Catalog endpoints use `/api/projects`. Project-specific endpoints use `/api/projects/<id>/...`, preserving the existing resource route suffixes, for example `project`, `project/publish`, `queries`, `scripts/resources`, `runtime/project` and `assets`. Gateway connections, tags and event streams retain their global routes with server-enforced access checks. Shared connection/tag configuration requires administrator access. Operator tag reads and streams are limited to the current project's configured readable paths; runtime assets must be referenced by its publication.

The existing unscoped project API routes resolve to `default` and authorize that actual project; a request header cannot retarget a legacy alias. Existing `/runtime` and `/designer` links resolve to the default project's routes. Clients should use explicit IDs for newly created projects. Older fixture loaders now need authenticated requests with the selected audience and matching mutation CSRF token; there is no unauthenticated developer bypass. The [security verification guide](SECURITY.md#verification-commands) describes the real-session preload restricted to isolated test gateways.

Local accounts, separate audience sessions, project permissions and bounded local audit are implemented. Plain HTTP account/API access is restricted to loopback; remote clients require HTTPS. First-run administrator setup requires a local connection and the setup code on the gateway computer. Trusted Python/browser scripts retain OS/origin privileges. [Network settings](NETWORK_ACCESS.md), [offline recovery](GATEWAY_RECOVERY.md) and [configuration backups](SCHEDULED_BACKUPS.md) have implemented, bounded contracts. Consult [Windows installation](WINDOWS_INSTALLER.md) for release-specific checks; source features and single-host service evidence do not establish every deployment or upgrade path.