# Models workspace: choose data, build a model, add equipment

**Status: workspace implementation and acceptance contract.** Updated October 4, 2026. **Models** is a top-level workspace destination in the left navigation. A **Plant | Models** explorer beside one detail page replaces the earlier view tabs and setup guide. Every page shares one model selection and protects one unapplied draft over the [UNS model](UNS_MODEL.md). Modeling is no longer nested under Tags or Gateway Settings. [Model operations](UNS_MODEL_OPERATIONS.md) specifies quality rules, alarms, source profiles, version impact and publishing. Validation evidence and any remaining qualification limits belong in the [verification ledger](PARITY.md); this page does not itself certify a build or a deployment.

## Earlier UI limitations

A walkthrough of **Tags → Model** on a development gateway (October 4, 2026) found that building a model is form entry rather than modeling:

1. The tags being modeled are not visible. A reference member needs its full target path typed into a text field, and its data type picked by hand to match.
2. Every member expands into a full-width card of about eight fields. Reference members still show scan group and interval, which do nothing for them.
3. A type and its instances cannot be created in one pass. Instances can only pin saved types, so the type must be applied before the Instances tab can use it. Nothing explains this order.
4. Parameters are not visibly connected to the members that use them or to the values each instance supplies.
5. Unsaved work is lost without warning when the left navigation bar is used. The discard prompt only covers the workspace's own back button.
6. Preview only covers the current tab, and Apply sits in a bottom footer away from the review.

That earlier page also broke the layout used by Raw tags and Connections. The replacement follows the [consistency rules](#consistency-rules) below.

## Goals

- Build a reusable **model** by dragging in existing data. Explain a model as a recipe, a **field** as one value in that recipe and **equipment** as a machine that uses it. The technical schema continues to call these a type, member and instance.
- Start from connected data, a template or a blank model. Then add machines, place them in locations, review and apply. Each page says what to do next; there is no separate guide.
- Create many pieces of equipment at once. Show whether each can find every value it needs, and explain any missing or incompatible data beside the affected row.
- Make one combined draft (types, instances and hierarchy) with one review and one apply.
- Match the navigation, layout and action placement of Raw tags and Connections.
- Everything possible with a mouse must also be possible with the keyboard.

## Non-goals

- No alternate tag formats or compatibility modes. `sparkstudio.tags` uses the single current schema and its existing limits. The server remains the authority; the client never applies anything without preview → apply.
- Source profiles reuse saved gateway connections and tags; creating a profile does not independently open a connection before review/apply.
- An i3X server, DIME hand-off, writable references and inheritance remain out of scope. MQTT delivery is explicitly enabled through its separate publisher settings.

## Information architecture

**Models** has its own top-level icon and label in the workspace's left navigation, alongside **Designer** and **Tags**. **Tags** contains the individual tag editor; it has no Model section tab. Gateway Settings does not contain a duplicate tag or model editor.

Models is an explorer beside a detail page. The explorer has two lenses:

| Lens | Lists | Selecting an item opens |
|---|---|---|
| **Plant** | **All equipment**, then locations and folders, then machines, each machine with a status dot | A **location page** or a **machine page** |
| **Models** | Each model once with its usage count, draft marker and version chips | The **model page** for that version |

| Page | Contents |
|---|---|
| **Location** | Breadcrumb, level badge, child-location chips and machine cards with up to three live values (60 per page). **＋ Location inside**, **＋ Add machine here** and collapsed **Location details** (name, level, metadata, remove). An undeclared folder offers **Make this a location**. |
| **Machine** | Readiness pill and model chip; **Live data** (Field, Value, Quality, Comes from); **This machine's settings** (name, location, model version, source mapping, enabled, fill-in values, advanced per-field changes); a **field inspector** showing the selected field's data rules with **Edit field and data rules**, which opens the model page at that field. |
| **Model** | Version select, **＋ Add fields from data** (opens the data library beside the fields), **＋ Add a model inside**, the field list with a one-line rules summary per field, **Asks each machine for** (fill-in values) and the machines that use it. |
| **Check & share tools** | **Check:** Live object and Data issues. **Manage:** Versions, Source mappings and Dependencies. **Share:** Publish MQTT and Export selection. Templates also open here. |
| **Data update settings** | Shared scan groups and provider settings. |

Plain words come first: a model's parameters are **fill-in values**, an instance's overrides are **this machine's settings**, and a reference target is where a value **comes from**. **Bulk actions → Paste spreadsheet rows** still brings CSV or tab-separated values into the machines grid on the model page. Model versions such as `CNC@2` describe the user's immutable type definitions, not selectable tag-file formats.

Each page has a URL so it can be bookmarked and restored after reload: `view=models&type=CNC@2` for a model, `view=plant&item=<path>&kind=machine|location` for plant pages, and `view=tools` or `view=settings`. Earlier links keep working: `view=build` opens the Models lens, `view=namespace` opens the plant overview and `view=operate` opens the tools. With a project open, the route stays `/designer/<project-id>` so its Designer state is retained. `/workspace?workspace=models` opens Models without selecting a project. Tags uses `workspace=tags` separately.

## Page layout

- **Page header.** Title **Models** with a status pill such as `Data running` or `1 waiting for data`. On the right: a search box that filters the explorer, **Import / export**, the primary **＋ New** menu and a **⋯** menu (Undo, Redo, Check & share tools, Data update settings, Discard draft).
- **＋ New** offers **Model from connected data** (creates a model and opens the data library), **Model from a template**, **Blank model**, **Machine** (choose model, location and name) and **Location** (next level under the current location).
- **First run.** With no models, machines or locations, the page shows three start cards (connected data, recommended; template; blank), a short explanation of models, machines and locations, and **Import a model file**.
- **Draft bar.** While the draft has changes, a bar pinned to the bottom reads "N changes · Not live until you apply" with **Undo**, **Discard** and the primary **Review & apply**. It hides while the review panel is open.

### Library pane

- **Tags section.** The same folder tree and search as Raw tags, with each tag row showing name, data type icon, live value and quality dot. Rows and folders are draggable. Tags already used by the open model are marked with a small "added" badge.
- The library is hidden until **＋ Add fields from data** opens it; the choice persists in this browser and the pane width is resizable. Model selection lives in the explorer. Saved versions are read-only; **Edit a new version** creates an editable draft while equipment stays pinned until explicitly upgraded.
- Large catalogs: the tree must be virtualized and lazy-loaded by folder. It must stay responsive at the 10,000-tag ceiling.

### Type shell

Header: **Model name** (editable inline for a new model), version (read-only; drafts show `vN · draft`), and metadata. Keep optional semantic identifiers and attributes in details rather than requiring them to start.

**Parameter chips** sit in **Values that vary by machine**, with an explanation that each machine fills in its own value. Each chip shows `{Name}` and its type. Clicking a chip opens it in the detail drawer and highlights every field that uses it. **Add parameter** adds a parameter.

**Member rows** use one compact line each: drag handle, kind icon (⇢ reference, ▣ memory, ƒ expression, ◆ nested type, ⌁ OPC UA / device), name, data type, unit, and source summary (target path, expression or nested type). Rows can be reordered by dragging. Selecting a row opens it in the detail drawer.

**Detail drawer.** It slides over the instance pane, as the Raw tags detail card does, and shows only the fields that apply to the member kind:

| Kind | Fields shown |
|---|---|
| reference | Name, target (tag picker with path text and parameter insertion), data type (read-only, from target), unit, description, range, enabled |
| memory | Name, data type, initial value or parameter, unit, description, range, scan group, enabled |
| expression | Name, data type, expression, inputs (member or tag pickers), interval, unit, description, enabled |
| opcua / device | Existing source fields, unit, description, range, scan group, interval, enabled |
| type | Name, nested type and version, parameter arguments, enabled |

The normal field editor starts with **Name**, **Read from**, **Type**, **Unit** and **Description**, as applicable to its source. **Quality rules**, **Process alarms**, **Advanced metadata** and **Sampling options** disclose additional controls. Opening these sections does not change a saved version's immutability. An empty model shows **Drop your first tags here**. **Manual value** adds a memory field and **Calculation** adds an expression. Direct source fields remain under **Advanced: connect a field directly**.

### Instance grid

One row per instance of the selected model, including draft instances. Columns are **Equipment name**, **On**, one column per parameter and **Status**. Editing a name preserves its location prefix. **Details & settings** exposes the **Full location path**, parameters and advanced field overrides. Parameter cells validate against the parameter type immediately.

**Toolbar:** row count with readiness summary ("3 of 3 ready"), **Add equipment**, **Bulk actions → Paste spreadsheet rows** and **Bulk actions → Update selected to vN**. Updating pins the selected rows to the model's draft version. Unselected equipment keeps its version and shows a version chip.

**Equipment status** combines local source resolution with saved configuration and current modeled samples:

- **Needs setup:** unresolved/invalid configuration, unapplied relevant changes, disabled equipment/provider, or no active fields. Expand the status for the affected field or required action.
- **Waiting for data:** saved, enabled equipment with matching configuration has not received every first sample yet.
- **Data issue:** a saved field has Bad or Uncertain quality, or a modeled rule is violated. **Data issues** opens the filtered inspector; **Live values** shows the affected equipment.
- **Ready:** the applicable saved configuration matches the draft, all active fields have received samples and every field has Good quality. Source resolution alone never makes an unsaved machine Ready.

Human equipment names and issue explanations lead; full paths and raw quality codes remain available in details. The existing live-value refresh updates status without applying drafts.

**Bulk actions → Paste spreadsheet rows** accepts tab- or comma-separated text with a header row (`path, <parameter…>`), up to 2,000 rows. It replaces the Bulk instances tab and reuses `parseModelCsv`.

## Drag and drop

Use native HTML5 drag and drop, as the Designer canvas already does. Tag drags use the existing `text/spark-tag` data type. Add `application/x-spark-tag-folder` and `application/x-spark-model-type` for folders and types. A drag carries paths only, never values.

### Drop rules

| Drag | Drop on | Result |
|---|---|---|
| Tag | Shell (empty area or between rows) | New **reference** member. Name is the tag's last segment, sanitized; data type and unit come from the tag. Duplicate names get `_2`. |
| Tag | Existing reference row | Replaces that member's target, after confirmation if the data type changes |
| Tag | Expression member's input slot (drawer) | Sets that input |
| Folder | Shell | One reference member per tag under the folder, keeping relative paths (`Axis/X/Load`), then the **parameterize offer** below. More than 128 tags shows a selection dialog instead. |
| Folder | Instance grid | New instance from that folder, if the shell has a parameter inferred from the same position; see [Satisfying instances](#satisfying-instances) |
| Type | Shell | New **nested type** member pinned to the dragged version. Rejected with a message if it would create a cycle or exceed 4 levels. |
| Equipment row | Location node | Moves the instance path under that node (Plant explorer) |
| Member row | Shell, between rows | Reorders members |

Drop targets show a highlighted insertion line or outline while a valid drag is over them. Invalid targets show a not-allowed cursor and a short reason in the status line. Every drop is an undoable draft edit (Ctrl+Z / Ctrl+Shift+Z within the workspace).

### Parameterize offer

After a folder drop, or after several tag drops whose targets share a prefix, the shell compares the targets:

1. Compute the common root of the dropped targets, for example `[default]EquipmentDemo/Press01`.
2. If the root's last segment has sibling folders (`Press02`, `Press03`) that contain at least half of the same relative leaf paths, offer **Use this model for similar machines?** Explain the changing `Press01` value and propose the editable parameter name `{Device}`. The actions are **Keep these exact tags** and **Make reusable & add equipment**.
3. On accept:
   - Add a String parameter with no default.
   - Rewrite every target to `[default]EquipmentDemo/{Device}/<relative path>`.
   - Add the draft instance `…/Press01` with `Device = Press01`.
   - List the matching siblings as **Similar equipment** in the instance pane.
4. On decline: keep literal targets. The offer can be reopened from the shell menu (**Reuse with other machines…**).

If the dropped targets have no sibling structure, no offer is made. Users can still add a parameter and insert it into targets from the drawer.

### Keyboard and accessibility

- Every drag action has a keyboard equivalent. Select a library item and press **Enter** or **Add to model** to append it to the shell. **Ctrl+Enter** on a folder adds it to the instance grid.
- Member rows support **Alt+↑/↓** to reorder.
- Drop results and validation messages are announced through a polite live region.
- The library tree and instance grid use the ARIA tree and grid patterns. Focus moves into the drawer when it opens and returns to the row when it closes.

## Satisfying instances

The instance pane answers one question: does each machine have everything this type needs?

- **Similar equipment** come from the parameterize offer, or from **Find matching folders**. That action scans siblings of a chosen folder and ranks them by how many member targets they resolve. Each suggestion shows its match ("12 of 12" or "10 of 12") and is added with **+**, or all at once with **Add all matches**.
- **New instance paths** default to the model location of the first instance with the parameter value substituted (`…/Line1/{Device}` → `…/Line1/Press02`). They are editable, and dragging them in the **Plant** explorer moves them later.
- **Partial matches** can still be added. They show missing data and the server preview reports the missing targets as conflicts, so Apply stays blocked until they are fixed. Fix one by editing the parameter value, adding an override under **Details & settings → Advanced: customize fields for this equipment**, or changing the model.

## Resolution

The client computes resolution for immediate feedback; the server preview remains authoritative.

- **Client.** Substitute each instance's parameters into each reference target, using the same placeholder rules as `TagModelParameters`. Check the result against the loaded tag definitions: does the path exist and is its data type equal to the member's? Also check required parameters and parameter types. Recompute on every edit; debounce at 150 ms for grids over 200 rows.
- **Server.** **Review & apply** sends the combined draft to `POST /tag-engineering/preview`. The review lists conflicts by instance and member, using `expandedTags` and `fieldProvenance` from the existing response. If the client and server disagree, the server's result is shown and the client check is treated as a hint.
- A target tag with no declared data type (possible for imported OPC UA tags) shows "type unknown". Dropping it creates a member with the tag's live data type, if present, and a warning that the target should declare one. See [open questions](#open-questions).

## Organize locations safely

**＋ Location inside**, **＋ Add location** in the explorer and **＋ New → Location** add a child under the current location. A new root starts as **Enterprise**. Child kinds are suggested in this order: Enterprise → Site → Area → Line → Cell → WorkCenter → Custom. If the selected location is Custom, use its nearest declared ancestor with a standard kind to choose the next suggestion. Suggestions remain editable; the server validates hierarchy ordering at review.

The detail editor shows **Location name**, with the full path available for context. Typing changes a local name buffer, not the draft's path or selection. **Rename** or **Enter** commits the name once, retaining its parent and provider. Reject empty names, path separators and conflicting destination paths before changing the draft. A rename updates that location, descendant hierarchy nodes and descendant instance paths atomically as one undoable edit. It preserves each node's kind and metadata. Source tag paths and reference targets are not rewritten; explain that changed model paths can require screen-binding or other reference updates before Apply.

## One draft, one review

- The workspace holds **one draft package** containing every changed type version, instance, hierarchy node, scan group and provider setting. Switching views or types never drops draft content.
- A draft type can be used by draft instances in the same package, because the server merges and expands the whole package together. The current "apply the type first" order disappears.
- **Review & apply** in the draft bar opens a review panel on the right. It does not replace the page.
  - **Grouping:** changes are listed by type, then instance, then member: added, updated, unchanged and conflicts.
  - **Conflicts first:** they are listed at the top, each linking to the offending row or member.
  - **Apply:** **Apply n changes** sits in the panel header and is enabled only when the preview has no conflicts and the draft has not changed since it was taken.
- After apply, the draft clears, the library refreshes, and draft badges become saved versions.
- **Discard draft** is in the review panel and the header overflow menu, and it always confirms.
- While preview or Apply is in flight, edits, drops and navigation out of the workspace are blocked until the request finishes. A failed request preserves the unapplied draft.

## Unsaved-changes guard

While the draft is non-empty:

- Left navigation bar, breadcrumb, **Tags**, gateway settings navigation, browser Back and project switching all use the same model-draft decision: **Stay** or **Discard draft and leave**. Stay preserves the draft and current workspace. Discard clears the draft before completing the requested navigation. Moving between explorer items and pages keeps the draft without prompting.
- Browser reload and close use `beforeunload`.
- The draft is also kept in session storage per signed-in user, as Ask Spark drafts are today. A reload restores it with a banner: "Restored an unapplied model draft from this session."
- If the saved draft cannot be restored, its original text is preserved. **Export recovered draft** downloads that text; **Discard recovered draft** requires confirmation and resumes persistence of current edits. A failed import keeps both the existing draft and the pasted package available for correction.

## Consistency rules

These rules apply to Models, and the same checklist should be used for future workspace pages:

1. **One page title.** Models has one heading; panel headings describe the next action.
2. **Own workspace destination.** Models stays a peer of Tags in the left navigation. Do not bury it inside Tags or add a second editor in Gateway Settings.
3. **Primary action top right**, in the page header, using the primary button style. Secondary actions (**Import / export**) go to its left as a button or menu.
4. **Status as a pill or stat card**, never a sentence of counts.
5. **Master–detail layout.** A list or tree on the left, the work surface in the centre, details in a card or drawer. No full-page forms for collections.
6. **Compact two-column fields** in drawers, with the same spacing, label style and input height as the Raw tags detail card and the Connections editor.
7. **Breadcrumb and URL** reflect the current workspace and page.
8. **Destructive actions** use the danger button style and confirm in-page, never with a browser dialog.
9. **Explain before requiring jargon.** Start with model, field, equipment and location. Explain a parameter as a fill-in value, and an override as a change for one machine. Keep exact source paths, type versions and validation details available without making them the first thing a beginner must understand.

## Ask Spark

- Ask Spark model drafts (`model_draft`) open the model page in **Models** and merge into the current draft, each with a "from Ask Spark" badge. The existing rule stays: Ask Spark never applies model changes.
- Models registers its current page kind, selected type, selection, draft summary and resolution messages as Ask Spark context, so questions like "why can't CNC03 find its data?" include the relevant diagnostics. Context text and arrays are bounded; credentials and editable connection settings are excluded. Pinning chat context does not bypass the live unsaved-draft guard.
- Source **Create type from selection** enters the same owner-scoped draft workflow and is identified as a source draft. It is not labeled as an Ask Spark proposal. Neither entry point applies changes.

## Implementation notes

- **Reuse:**
  - the Raw tags folder tree and search for the library;
  - `parseModelCsv`, `bulkModelInstances` and `modelLeaves` from `modelWorkspace.ts`;
  - the review list from `modelWorkspaceReview.tsx`, extended with grouping;
  - the existing preview/apply calls in `TagModels.tsx`.
- **Replace:**
  - the Types, Instances and Bulk instances tab components (`modelWorkspaceTypes.tsx`, `modelWorkspaceInstances.tsx`) with the Build view;
  - the hierarchy form in `modelWorkspaceNamespace.tsx` with drag-to-place.
- **New client modules:**
  - `modelDraft.ts`: the draft store, with undo/redo, draft counting and session persistence;
  - `modelResolution.ts`: parameter substitution, target lookup and data type checks;
  - `modelParameterize.ts`: common-root and sibling detection, and suggestion ranking.
  Keep them free of React so they can be tested offline like the existing `check-*.mjs` suites.
- `modelNavigation.ts` supplies the shared guard for links, history and application navigation; the global Ask Spark provider hosts its dialog. URL query fields are updated without changing the Designer route.
- Model workspace context is checked at the gateway as well as in the client. Initial messages and later tool rounds can include a bounded context update, marked as data rather than instructions.
- The library indexes the existing definitions catalog, expands folders on demand and virtualizes displayed rows. It does not add a new source acquisition or folder API.
- Client resolution and parameterization use the same placeholder grammar as the server: a leading letter, followed by letters, digits, underscores or hyphens.

## Acceptance

The authored offline checks and browser walkthrough should cover:

1. **Tag drop:** dropping a tag creates a reference member with the tag's name, data type and unit.
2. **Folder drop and parameterize offer:**
   - a folder with three sibling folders triggers the offer;
   - accepting rewrites every target to `{Device}` and lists the siblings as suggested instances with correct match counts.
3. **Declining the offer:** literal targets are kept and no parameter is added.
4. **Nested type drop:** dragging a type nests it; a cycle or a fifth nesting level is rejected with a message.
5. **Equipment status:** test all four states against saved configuration and samples, including unapplied changes, disabled equipment/provider, missing or mismatched sources, missing parameters, duplicate paths, first samples and Good/Bad/Uncertain quality.
6. **Pasted rows:** 2,000 rows parse, and 2,001 are rejected.
7. **One package:** a draft type plus three draft instances preview and apply as one package without applying the type first.
8. **Guard:** left navigation, gateway tabs, links and Back show the guard; **Stay** keeps the draft; discard completes the original destination; reload restores a retained session draft; signing in as another user cannot reuse the pending navigation.
9. **Keyboard parity:** a type can be built and three instances added using only the keyboard.
10. **Consistency:**
    - Models has its own icon and label beside Tags in the left navigation;
    - Tags has no Model subtab, and Gateway Settings has no duplicate tag or model editor;
    - there is exactly one page heading;
    - the primary create action is in the header and the apply action is in the draft bar.
11. **Approachable workflow:** first-run choices, the explorer, the ＋ New menu and the draft bar explain what to do next without a guide; opening and closing the data library preserves its search and selection at desktop and narrow widths. Check/Manage/Share and field disclosures remain keyboard accessible.
12. **Routing:** open Models with and without a project, restore `workspace=models` bookmarks, and return to an open Designer without losing its document state. Source and Ask Spark drafts open the same Models workspace.

Extend the setup-required [UNS walkthrough](UNS_MODEL_SETUP.md) with a drag-and-drop variant:

1. Build `Press` from `EquipmentDemo/Press01` by dropping the folder.
2. Accept `{Device}`.
3. Add Press02 and Press03 from suggestions.
4. Place all three under a Line by dragging them onto it in the **Plant** explorer.
5. Review and apply once.

Record the browser walkthrough in the [verification ledger](PARITY.md).

## Open questions

1. **Untyped OPC UA targets.** Should dropping an OPC UA tag that has no declared data type offer to set it on the source tag, or should the server infer reference types from the live value? The server currently requires a declared type and rejects the reference.
2. **Parameterize offer thresholds.** Is "at least half of the same relative leaf paths" the right sibling threshold, or should the user always choose the varying segment from the path?
3. **Instance location defaults.** Should new instances default under a chosen hierarchy node (for example the selected Line in the Plant explorer) instead of mirroring the source folder structure?
