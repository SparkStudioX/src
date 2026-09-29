# Query-backed choices and equipment forms

A **Dropdown**, **List** or **Tree view** can read its choices from a saved read-only named query. Each holds one selected string form value; choosing a row can also populate other inputs in that same screen or template instance. A value or gauge can bind its **Tag path** to those inputs to display a different machine's tag. These features support a form-oriented application flow: select a record, review live data, edit fields, validate, save, and refresh. Multiple selection is not implemented.

## Query choice source

Choose a query option source in the property editor. A dropdown's saved component contract is:

```json
{
  "type": "select",
  "props": {
    "fieldKey": "selected_record",
    "defaultValue": "",
    "optionsSource": {
      "queryId": "equipment-options",
      "valueColumn": "record_id",
      "labelColumn": "equipment_label"
    },
    "selectionFields": {
      "id": "id",
      "version": "version",
      "machine": "machine",
      "quantity": "quantity"
    }
  }
}
```

For Dropdown and List, `optionsSource` has exactly the three keys shown. Tree view requires a fourth key, `parentColumn`, identifying its result's parent-value column. Dropdown and List reject `parentColumn`. Each setting is nonblank text up to 128 characters. Static `options` and a query source are separate modes. The source must identify a read query. Only declared query parameters are supplied from the current parameter context; query parameter defaults apply when context has no matching key. Form edits are not automatically supplied as query parameters, and a source does not accept arbitrary browser-supplied SQL.

Results may contain up to 500 rows. The value and label columns accept nonblank text or finite numbers; integral numbers must fit JavaScript's exact integer range. Values become strings up to 4,096 characters; labels become strings up to 200 characters. Every normalized value must be unique. Missing columns, invalid cells, duplicate values, or an oversized result fail the source rather than silently omitting rows. Use SQL `CAST` when a database ID should explicitly be a string.

Every tree result row must include the configured parent column. Null or an empty string denotes a root; other parent values accept the same text/exact-number normalization as choice values. Boolean values are invalid in value, label and parent columns. A nonempty parent must match a value in the same result. Self-links, cycles, missing parents and trees deeper than 16 levels, counting roots as level 1, fail the complete result. Parents may follow their children in the returned rows; sibling order follows result order. An empty query result is valid and displays an empty state.

An empty default shows a prompt and does not select the first row. Loading, communication failure, and source errors disable the choices and display their state. Queries refresh every ten seconds and after successful action refresh events. Refreshing leaves the operator's current selection and edited form values untouched. A selected value that disappears is shown as unavailable. Choosing another record loads its mapped fields; **Reload selected record** explicitly reloads the current choice's fields, replacing unsaved edits in those mapped inputs.

`selectionFields` maps **form input name → result column**. The targets must be declared in the same form scope and cannot include the choice control's own field. All mapped cells and target input values are checked before any mapped fields change. A selection does not write a tag or database. Automatic refresh and mapped-field assignments do not run input change/commit handlers on the mapped controls.

Saving and publishing retain their existing separation: Designer uses draft query definitions; operator screens use their publication's query snapshot. Published reads carry that publication token and reject stale clients after republishing. Before a published Python action runs, the gateway re-executes the captured choice query and checks the submitted selection against its permitted values. Query membership and disabled controls do not replace authentication, authorization, or record-level database rules. Form mappings are browser state; a save script must validate its input relationships and constraints.

## Static list/tree authoring and keyboard

Use **Edit options** for static List or Tree view data. The row editor stages Value, Label, Add/Remove and default selection changes until Apply; trees also offer a Parent dropdown. Cancel leaves the saved definition unchanged. A draft rename preserves child links and the selected default by row identity. Removing a parent with remaining children or the selected default requires an explicit replacement before Apply.

Static definitions contain 1–100 rows with unique nonblank string values up to 4,096 characters and nonblank labels up to 200 characters. Tree `parentValue` is optional, with an empty or omitted value denoting a root; List forbids it. Exact strings are preserved, and the same parent/cycle/depth rules as query trees apply. An explicit static default must be a member; an omitted default selects the first authored choice. Options, query columns and row mappings are structural settings without fx bindings.

| Runtime key | Behavior |
| --- | --- |
| Up / Down | Move focus to the previous / next visible item |
| Home / End | Focus the first / last visible item |
| Enter / Space | Select the focused item |
| Typed label prefix | Focus a matching visible item |
| Tree Right | Expand a collapsed parent, or focus its first child when expanded |
| Tree Left | Collapse an expanded parent, or focus its parent |

Clicking an item selects it; clicking its expander only changes expansion. Focus and expansion do not change the form value or run input handlers. A changed selection emits change then commit immediately. Tree parents and roots are selectable. Missing selections remain explicit instead of silently moving to another value; each template instance maintains its own selection and expansion.

## Loaded-result table paging

Tables filter and sort the entire loaded result before dividing it into pages. The static `pageSize` is an integer from 1 to 100, default 25; it has no fx binding. Previous/Next changes the visible slice without running SQL or fetching more rows. The result remains bounded by the connector's 1,000-row cap and any narrower authored query limit. Filtering, sorting or changing the query context resets the page; refreshed results that shrink clamp it to a valid page.

Moving between pages preserves local form edits and selection. Stable row-key checks cover the full loaded result. Explicit refresh and the existing polling/action-refresh behavior fetch the query again; paging itself does not. Inline editing, server-side paging and multiple selection remain separate work.

## Table display columns

Choose **Edit columns** in the table inspector to configure an ordered display without changing its query. Each row has an exact Source key, optional Heading, visibility, width, alignment and format. Add/Remove and Move up/down operate on a local draft. **Apply columns** changes the component in one project history step; Cancel discards the draft. **Use automatic columns** clears the explicit list on Apply. Save and Publish retain their normal draft/publication separation. Column configuration is structural and has no fx binding.

The optional `props.tableColumns` list accepts up to 64 definitions. An absent or empty list keeps the existing automatic source order, generated headings, display formatting and filtering. A nonempty list shows only its visible entries, in authored order, and must contain at least one visible column. Changing the query preserves the configuration so an author can repair source keys deliberately.

```json
{
  "tableColumns": [
    { "key": "id", "visible": false },
    { "key": "machine", "label": "Station", "width": 180 },
    { "key": "quantity", "label": "Output", "width": 110,
      "align": "right", "format": "number", "precision": 0, "suffix": " pcs" }
  ]
}
```

| Setting | Contract |
| --- | --- |
| `key` | Required unique, case-sensitive query column name; 1–128 characters, no outer whitespace or control characters |
| `label` | Optional nonblank heading up to 120 characters without control characters; omission uses the generated source heading |
| `visible` | Boolean, default true; hidden and unlisted fields are omitted from display |
| `width` | Optional whole number from 40 to 1,200 pixels; larger tables scroll horizontally |
| `align` | `left`, `center` or `right`, default left; applies to header and cells |
| `format` | `auto`, `text`, `number`, `boolean` or `datetime`, default auto |
| `precision` | Number format only; 0–10 decimal places, default 2 |
| `suffix` | Number format only; up to 32 literal characters without control characters; include any wanted leading space |

Source keys are checked against the returned query schema, including when it has no rows. Missing configured keys, even hidden ones, show a diagnostic instead of a partial or automatic table. Duplicate source names and invalid configuration also block the table's paging and row selection. Authoring does not require a successful query result before a valid definition can be saved.

Number format accepts native finite numbers and rejects unsafe integers or numeric strings. It uses fixed decimal places and appends the literal suffix. Boolean format accepts native true/false or numeric 1/0 and displays True/False; string flags are rejected. Date/time format requires a valid ISO timestamp with seconds and an explicit `Z` or signed timezone offset, with optional fractional seconds up to seven digits. It displays UTC and preserves fractional precision. A local timestamp without an offset is not silently assigned a timezone.

Text format displays literal text, including markup and braces, and serializes structured values as text; it does not execute HTML or substitute parameters. Unsafe or nonfinite native numbers receive a diagnostic, while exact numeric ID strings remain intact. Null and missing cell values show an em dash in every format. An incompatible non-null value shows an em dash, a marked cell with an accessible diagnostic and a summary for the current page. Formatting does not replace the underlying row value.

With explicit columns, the filter searches only visible formatted cell text, including numeric suffixes. Hidden and unlisted values cannot cause a match. Sorting still compares raw source values before paging, and row identity/field mappings still use the complete raw result. Hiding an ID or revision column therefore does not break form selection. Column visibility does not restrict access to query data. Column or page-size changes reset filter, sort and page state without overwriting form inputs. Cell formatting errors do not bypass mapped-input validation.

Wrapping, independent header alignment, per-column sort/filter switches, cell/row color mappings and custom renderers remain outside this display-column contract. Inline editing has its own explicit contract below.

## Inline table editing

Choose a table's read named query and **Unique row column**, then open **Inline editing → Configure editing** in Properties. Enable editing, specify its version column, declare editable fields and write the Python commit handler. Apply is one undo step; Cancel discards the dialog draft. Save and Publish capture the configuration, handler and named-query definitions. The code editor has no Run action; writes are available only in the published operator application to accounts with Operate access.

```json
{
  "queryId": "production-records",
  "rowKey": "id",
  "tableEdit": {
    "versionColumn": "version",
    "columns": [
      { "key": "machine", "type": "string", "required": true, "maxLength": 64 },
      { "key": "quantity", "type": "number", "integer": true, "min": 0, "max": 10000 }
    ],
    "script": "# Author the handler described below"
  }
}
```

Configure 1–64 distinct fields. Exact source keys are 1–128 characters without surrounding whitespace or control characters; neither the row key nor version may be editable. Text accepts optional `required` and `maxLength` (1–4,096; default 4,096). Number accepts optional finite `min`/`max` within the safe integer range and `integer`. Boolean accepts actual true/false values. Unsupported fields, wrong-type constraints, null metadata and incompatible ranges are rejected by both authoring and gateway validation. New values cannot be null; an existing null cell can be corrected. Python source must be nonblank and at most 64,000 characters.

The complete loaded query result, bounded to 1,000 rows, must contain the configured fields, unique row keys and nonnegative safe integer versions. Keys are nonblank text up to 4,096 characters or safe integers; numeric `1` and text `"1"` remain different identities. Display columns can hide identity/version fields while retaining them in the raw data. Hiding a column is presentation, not authorization.

An operator edits one cell per table instance with an explicit Save or Cancel; Enter saves from the input and Escape cancels. While a draft is open, its displayed rows stay fixed and filtering, sorting, paging, row selection and manual refresh are locked. Background reads check the row without replacing typed text. Removed rows, changed versions and invalid source data block Save. Communication loss retains the draft and blocks submission until fresh data is available. Failed or uncertain saves require current data to be reloaded before another attempt. Context/publication changes discard the old table session. Viewer sessions and disabled/failed component or template bindings expose no edit action.

The runtime request contains only a publication token, root project parameters, row key/version, column/new scalar value and any published template/repeater/popup identities. The gateway checks authorization/CSRF, reconstructs the published context, reruns the captured read query and checks the fresh row and version. It supplies these fixed Python inputs:

| Input | Value |
| --- | --- |
| `column` | Exact editable source key |
| `value` | Validated proposed string, number or Boolean |
| `oldValue` | Current source cell; may be null |
| `rowKey` | Current row identity |
| `version` | Current row version |
| `row` | Complete gateway-read row, including hidden fields |

Client-supplied code, SQL, old values, rows or unrelated form inputs are rejected. `parameters` comes from the published screen/template/popup context. The action retains one detached publication snapshot even if another publication occurs while it runs. Runtime project responses omit the handler source. Templates, saved/query repeaters and popup actions use the same published provenance checks as button actions. Bindings are interface behavior; trusted handlers must enforce their business rules and data relationships.

The fresh-row check is a preflight, not a database transaction. A concurrent write can occur after it. For a quantity field, create a parameterized **update** named query `save-quantity` with `value`, `id` and `version` integer parameters:

```sql
UPDATE production_records
SET quantity=@value, version=version+1
WHERE id=@id AND version=@version
```

Its commit handler must choose the permitted update and check the affected-row count:

```python
if inputs['column'] != 'quantity':
    raise ValueError('This handler only updates quantity.')
affected = system.db.runNamedQuery('save-quantity', {
    'id': inputs['rowKey'], 'version': inputs['version'], 'value': inputs['value']
})
if affected != 1:
    raise ValueError('This row changed. Reload current data before editing again.')
result = {'message': 'Quantity saved.'}
```

For multiple editable fields, use an explicit field-to-query map and a guarded update for each field. Do not interpolate the submitted column into SQL. Successful handlers refresh query data; scripts are trusted gateway code and are not automatically rolled back if a later statement fails. Multi-cell transactions, automatic retries, null/date editors, row creation/deletion and database-side paging are outside this increment. SQLite integration is verified separately from browser behavior; equivalent real SQL Server acceptance still requires a test server.

## Data workshop example

The independently authored [Data workshop](../../examples/data-controls.json) needs no Work orders prerequisite:

```powershell
node tools/load-data-controls-example.mjs
```

The [loader](../../tools/load-data-controls-example.mjs) creates and immediately publishes a separate **Data workshop** project with three read queries and two screens. It creates the shared `sqlite-data-controls` connection and managed `data-controls.db` with synthetic production records. **Records and hierarchy** combines query list/tree choices, validated same-form mappings and a two-row table page. **Independent station forms** contains two instances of a static list/tree template, demonstrating independent local selections. Python preview buttons return form values; they do not write records or equipment.

Only an optional plain local gateway URL on port 5090 or 5091 is accepted. Existing projects stay unchanged, reserved project/connection/database configuration causes a refusal, and database creation never overwrites an existing file. There is no `--publish` switch: this loader publishes its new project automatically. It is a one-time example creator, not an updater or cross-resource transaction; an interrupted run can leave resources already created.

## Indirect display tags

The **Tag path** binding on a value or gauge accepts a text expression. For example:

```json
{
  "tagPath": {
    "expression": "'[default]EquipmentDemo/' + machine + '/Load'",
    "references": { "machine": { "kind": "input", "key": "machine" } }
  }
}
```

The expression uses the current form scope. Selecting or editing its `machine` input changes the resolved display tag. An unconfigured machine path reports missing/bad quality; it does not substitute another machine's last value. This increment binds a display's tag path; it does not add a device write operation.

## Equipment workbench example

Run from the application repository:

```powershell
node tools/load-sqlite-example.mjs
node tools/load-equipment-example.mjs
```

The first loader supplies the existing `sqlite-workorders` connection, managed `workorders.db`, and synthetic `production_records` schema. The equipment loader requires that connection and schema; it never creates, replaces, migrates, or seeds the database. It adds an **Equipment workbench** screen, three dedicated named queries, and three synthetic memory tags while preserving the original Work orders screens, queries, scripts, and saved records.

The seed machines `Press01`, `Press02`, and `Press03` have fixed synthetic load values of 28%, 64%, and 91%. The screen labels these values as synthetic. Different machine names correctly show unavailable tag quality until appropriate tags exist. Saving the equipment form modifies the selected synthetic production record, never an OPC device.

The choice query returns the first 100 records ordered by machine and ID and bounds display labels to 200 characters while retaining distinct record IDs. Its row maps the record ID, revision, work order, machine, quantity, and status into the form. The screen's inline Python validates required text, allowed status, whole-number quantity, record identity, and revision before calling a parameterized update. The update includes `WHERE id=@id AND version=@version` and increments the version. A stale selection produces a visible conflict instead of overwriting another operator's edit. Successful saves refresh the saved-records table and choices; use **Reload selected record** to load its new revision before another edit. This example needs no new script-library publication.

Optional loader arguments:

```powershell
node tools/load-equipment-example.mjs http://127.0.0.1:5091 --project=maintenance --publish
```

Only local development ports 5090/5091 are accepted. `--project` defaults to `default`; its project must already exist. Connections and tags remain shared by the gateway. Without `--publish`, the loader saves a draft for review. With it, the loader publishes the project's current saved draft, including its other authored resources. Compatible repeat runs preserve existing resources and current synthetic tag values. Conflicting reserved IDs, changed example behavior, or an incompatible schema stop the loader before HTTP mutations. A local authoring backup is saved under `.data/example-backups/` before adding resources. The additive API calls are not a cross-resource transaction; after an interrupted run, correct the issue and rerun the loader.

Run `node tools/test-equipment-example.mjs` for pure preflight, mocked-transport, and isolated Python validation checks. Set `SPARKSTUDIO_PYTHON` when the bundled Python is located elsewhere. With the example published on a disposable gateway, `node tools/test-equipment-application.mjs http://127.0.0.1:5091` exercises query choices, actual Python/SQLite saves, validation, stale revisions, and long labels. It restores the original business fields through the guarded save action; normal revision numbers and saved timestamps advance. API tests refuse port 5090. Browser and API verification are recorded separately in the parity roadmap; these checks do not establish connectivity to a real SQL Server or OPC device.
