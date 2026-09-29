# Project resource search

Designer has **Search project** in the workspace navigation and a **Ctrl+Shift+F / Cmd+Shift+F** shortcut. It searches the current project's loaded draft, including unsaved screen/template edits and visited query/script editor drafts. Opening search does not save, publish, execute SQL or run scripts.

Filter by resource category, then open a result to select its owning screen/template and component, open project settings, or select the named query or script resource. Property results display their authored location; common property-sheet rows are scrolled into view. A grouped component can be inspected individually, while canvas editing and the explicitly labeled Delete selected group action retain group behavior. Closing a document does not remove it from search. The first 200 matches are rendered with the total count; refine the text or category to narrow a large result set.

**Structured references** follows explicit resource identifiers: screen navigation destinations, template placements, query-backed components/options/rows/properties and owner-scoped component binding references. Missing screen, template, query and explicit component targets are diagnosed against the loaded draft. Assets and tag paths are searchable references, but their availability is not inferred without their authoritative inventories. Text in Python, JavaScript or SQL is searchable and labeled as text; it is not proof of a dependency or a complete call graph. Dynamic names and generated paths remain outside this analysis.

Script resources are read when search is first opened if their editor has not supplied a loaded snapshot. Once ready, the editor supplies its current draft. A loading or failure notice makes incomplete script coverage visible. This is a local draft index, not a cross-project server index. Changes saved by other engineering sessions require reloading their resources.

Search navigation never discards a named-query draft to switch to another query. Save or discard that draft first. Script drafts stay in memory across resource switches; invalid parameter JSON must be corrected before switching scripts. Search changes editor selection only; it does not change permissions or the active publication.

## Workshop

Import the **Project resource search** `.sparkproj` from the workshop collection. The authored source is [project-search.json](../../examples/project-search.json). It needs the Designer build with project resource search, no configured tags or external database. Its query uses synthetic built-in sample data. The optional Python button only returns a message; it needs the bundled Python runtime and appropriate permission.

1. Search `production-card`, select the template definition and inspect its structured references. There are two placements on Resource search. Open a placement and confirm that its component is selected.
2. Search `production-summary`, select the query and inspect its structured references. Find the template's value binding and the detail table. Open the binding result to select the template's Produced display and locate `value` in its property sheet.
3. Filter Script results for `production-summary`. The read-only button contains a comment with the query ID. It is a text match, not a third verified query use.
4. Search `search-details` and open Production details even if its document tab was closed. Search for `title` and distinguish the two owning screens.
5. Edit the selected component's caption without saving; reopen search to find the new text. Undo the edit. Edit a query's SQL, then attempt search navigation to another query in a project with multiple queries: the unsaved draft must stay intact.
6. Publish the imported project and open the operator application. Both cards show synthetic counts. Open production details and return with its Back button. Search controls belong to Designer and do not appear in the operator application.

Screen/template display-name changes and screen/template/component deletion now have [resource change previews](RESOURCE_CHANGES.md). Structured references also track explicit table/choice selection mappings to local input fields. Bulk replacement, arbitrary reference repair, full script analysis and cross-project search remain future increments. Missing-reference results are diagnostics only, not permission to perform destructive refactoring.
