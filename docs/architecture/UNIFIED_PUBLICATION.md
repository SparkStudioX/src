# Complete application publication and rollback

Designer and Scripting both open **Review application publication**. The review shows the saved project and script revisions, screen/template/query counts, and every library, gateway event and browser event with its enabled state. **Publish application** commits these resources together. Save each workspace first; unsaved edits in another tab remain local and are not included.

The review fingerprint covers the saved project, all named queries, all script resources and the current active publication. A save or another publication after review makes confirmation fail with a request to review again. Project and script revision checks also protect API clients. The compatibility `/scripts/publish` endpoint now publishes the entire saved application, using its `revision` as the expected script revision; it does not activate a separate script version.

The active release and its bounded history share a single `published.json` atomic file replacement. Screens, templates, appearance, project settings, executable component code, all named queries, Python libraries and gateway/browser script definitions belong to that snapshot. A failed validation or write leaves the prior release, history and running script generation intact. Existing script draft files remain independent drafts; a new release does not write a second `scripts-published.json` active pointer.

Python actions and component events capture library sources with their action and query definitions before asynchronous work. Gateway events retain their own captured queries and libraries through cancellation and shutdown. The scheduler stops admission, cancels queued/active old work, drains it, and runs bounded old shutdown handlers before starting the new generation. An application or query change restarts that generation even when the script draft revision is unchanged. Browser scripts load only for the publication stamp of the displayed operator screen. Existing sessions must load the new application before executing another server action.

Publication history retains up to 20 snapshots within a 32 MiB aggregate limit; each history record is checksummed and limited to 16 MiB. A restore records a fresh publication stamp and reactivates the selected complete snapshot. Project, query and script drafts remain unchanged. Tags, gateway connections/credentials, local asset storage, database rows and external device state are outside the transaction. Existing content-addressed local assets must remain available for image validation during rollback.

Older publications remain readable. Their history entries are marked **Legacy (partial)** because they did not capture script resources. Restoring one requires the explicitly labelled legacy restore action (`acknowledgeLegacy: true` for API callers), preserves currently active scripts in the durable restored release, and retains a compatibility warning. No missing script version is invented. Review compatibility before choosing this option.

## Dispatch desk workshop

Source: [unified-publication.json](../../examples/unified-publication.json). This independently authored portable example uses synthetic built-in sample data and performs no gateway writes. It requires a build with complete application publication, bundled Python, Design/Publish permissions and Operate permission to execute the button. Older releases with separate script publication do not support its one-step workflow.

1. Import the workshop as a new project. It starts unpublished; the library and both startup resources are disabled.
2. Inspect the screen and all three resources in Scripting. Enable **dispatch_release**, **Dispatch startup**, and **Dispatch browser**, then save resources.
3. Choose **Publish application** from either workspace. Verify the review includes one screen, one named query and the three enabled resources; confirm once.
4. Open Operator application. Its startup banner says **Browser loaded Release Amber**. Choose **Verify matching release**: the result is **Release Amber / Line1**. Scripting execution history contains the same gateway startup result.
5. Make a second saved release: change the screen title to **Release Indigo**, change `dispatch_release.caption()` and the browser message to Indigo, and change the query parameter default to **Line2**. Save the project and scripts. Publish once and load the new operator version; verify **Release Indigo / Line2**.
6. Open Publication history in Designer, review the first complete snapshot and restore it. Load the operator version again. The screen, button result, browser banner and gateway startup return to Amber/Line1. Designer and Scripting drafts still contain Indigo/Line2.
7. To try the revision guard, open a publication review, save a changed query from another tab, then confirm the original review. It must reject the stale review without changing the active release. Refresh and inspect the new review before retrying.

The workshop can be imported, explicitly published and re-exported without enabling resources to verify draft portability. Enabling is required only for its authored Python/browser exercises. Re-export contains the current drafts and no publication history, runtime state or gateway configuration.

## Verification

`dotnet run --project src/SparkStudio.Gateway.Tests -- --unified-publication-only` exercises stale review checks, failed publication/rollback writes, detached runtime captures, restart recovery, draft preservation, legacy acknowledgement, actual CPython startup/shutdown query/library consistency and ordering, and a query-only generation transition. Use the workspace SDK and an isolated configuration when a development gateway is running. `node tools/test-unified-publication-workshop.mjs` verifies the workshop through a fresh authenticated loopback gateway and re-export.
