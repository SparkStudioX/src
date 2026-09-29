# Reusable templates and repeaters

SparkStudio templates reuse a fixed-canvas collection of components. Public parameters support Text, Number and Boolean types. Templates can contain other templates and saved-row repeaters, with a maximum of four template levels and no reference cycles. Query-backed repeaters remain restricted to a screen or popup's root component list. UDTs, private mutable template properties and arbitrary-depth nesting remain future work. See [NESTED_FORMS.md](NESTED_FORMS.md) for nested form identity and action contracts.

## Authoring

Create a template, give it a stable ID and declared public parameters, then place its components using explicit X/Y positions and dimensions. The template property sheet edits each parameter's Name, Type and Default in one Apply/Cancel transaction. Instances expose a row per declared parameter with Use default/Override controls and parent-reference support. A `repeater` references the same definition and stores an ordered list of rows with stable row IDs and parameter overrides.

Templates can contain labels, values, gauges, buttons, query tables, all fourteen input types (text, password, multiline text, numeric, spinner, slider, checkbox, toggle, dropdown, list, tree, radio group, multi-state button and local date/time), multi-state indicators, LED/progress/tank/level/thermometer displays, images and icons. Nested template instances and saved-row repeaters add another local form scope. The operator preserves each authored layout with proportional fitting; responsive container layout is not implemented.

Parameter values resolve once against the immediate parent's resolved parameter context at each template boundary. Template defaults, instance overrides and saved-row overrides form the local parameter scope, in that order. Override keys must be declared by the target template. Each nested template applies its own declared types after resolving its authored references. A replacement value containing braces stays a value; it is not substituted repeatedly or evaluated as code.

Regular screen defaults resolve against root project parameters. Popup callers have an additional, server-validated context contract described in [ASSETS_POPUPS.md](ASSETS_POPUPS.md).

### Typed public parameters

Saved parameter defaults and overrides remain strings. An optional template-only `parameterTypes` map declares up to 64 entries, for example `{"limit":"number","permit":"boolean"}` alongside `parameters: {"limit":"40","permit":"true"}`. Missing metadata preserves legacy text behavior. Numeric declarations require finite decimal values within the browser's exact integer range; blanks, surrounding whitespace and hexadecimal forms are rejected. Boolean declarations accept exactly `true` or `false`, not numeric 0/1. Native primitive query values are checked by the same rules.

Coercion follows one-pass parent substitution and the default → instance → row overlay. The resolved number or Boolean reaches bindings, input events, read queries and Python as a native scalar. Query cells remain literal; a brace in database text is never a second parameter expression. Invalid resolved contexts show a diagnostic, suppress child forms and reject actions. The entire query result must be valid before any row is rendered or acted upon.

Changing parameter types invalidates local form edits, pending input events, query results and popup origins. Published actions capture type metadata; changing a draft does not change published execution. Project, screen and popup declarations retain their existing text contract. Dynamic bindings on public parameters and private instance state are separate future work.

## Instance property bindings

Template instances and repeaters expose the common property sheet with **fx** controls for Text (an accessible wrapper label), Enabled, Visible, X, Y, Width, Height, Font size, Accent, Background, Text color, Border color and Border width. Wrapper bindings use their immediate parent form's inputs, parameters, tags and saved custom properties. They cannot refer to child form inputs. Each child evaluates its own bindings in its separate instance/row scope. All levels share the containing screen or popup's declared screen state and the application's session state; a template does not introduce another screen-state namespace.

Geometry changes in Preview/operator mode; authoring handles use saved geometry. Disabling a wrapper or encountering a binding error blocks its child interactions and scripts. Hiding a wrapper removes it from visibility, focus and hit testing in Preview/runtime, while retaining unchanged row drafts. Hidden and disabled child event helpers are invalidated. Appearance supplies inherited defaults while explicit child styles take precedence. These display settings are not server authorization. Template references, parameter maps, row sources and repeater arrangement remain structural; parameters are still saved strings.

The independent [template property workshop](../../examples/template-properties.json) uses parent inputs to move, resize, highlight, hide and disable reusable station forms. Its Python preview buttons return messages without writing data. Load it with `node tools/load-example.mjs template-properties`, then open **Template properties** in Designer. Loading a screen does not automatically add it to the operator menu; configure a deliberate menu entry or navigation action before publishing.

## Query-backed rows

At the root of a screen or popup, choose a read named query in the repeater's property sheet, specify its string row-key column, and map result columns to declared template parameters. Query-backed repeater placement inside a template is rejected in this increment. A root query row can contain nested templates and saved-row repeaters. A query-backed repeater uses this shape instead of nonempty saved rows:

```json
{
  "templateId": "request-card",
  "rowsSource": {
    "queryId": "active-requests",
    "rowKey": "row_key",
    "parameterMap": { "requestId": "request_id", "status": "status" }
  }
}
```

Query parameters come from the calling screen's resolved project/screen context and query defaults. The query does not use editable row inputs. Its complete result must have at most 100 rows, unique nonblank string keys of at most 200 characters, and finite primitive mapped values. Nulls, objects, arrays and unsafe integers are rejected. Convert nullable database columns explicitly in SQL. Mapped strings are limited to 4,096 characters and are overlaid literally after authored default/instance references resolve; braces in database text are never evaluated again.

Rows refresh every ten seconds and after successful actions. Loading, empty and failed results have explicit feedback; context changes, failures and offline state clear stale rows. Each row retains its own input edits while its key and mapped values stay unchanged. A changed or removed row resets its form. Use a versioned row key, such as an ID plus record revision, for editable records that require optimistic concurrency.

On an action, the gateway re-executes the captured read query and reconstructs the row parameters using the submitted row key. It does not accept row parameters supplied by the client. Missing, stale or malformed row identities fail explicitly. Database updates must still check the record revision themselves: the read and subsequent script execution are not one transaction. Query-backed templates can open contextual popups; their actions re-check the opener row as described in [ASSETS_POPUPS.md](ASSETS_POPUPS.md#query-row-popup-lifecycle). Dynamic child tag-quality errors appear on their components; the header's aggregate tag totals do not include these dynamically loaded children.

## Inputs and actions

Each screen and complete template-instance/row path has separate input state. Reusing the same child IDs under different outer instances or rows does not merge their drafts. A nested form does not inherit its parent's or siblings' editable inputs. Changing the application context clears edits so a value entered for one asset cannot silently carry into another. Inputs, context selection and navigation lock while a Python action runs.

List/tree selection and tree expansion stay local to each rendered instance or row. Query choices use that instance's resolved parameters; their row mappings can populate only inputs in the same form. Table paging, filtering and sorting are also local to each rendered table, while its saved page size and query definition are shared through the template. Paging does not clear local form edits or fetch additional database rows. See [query choices and paging](QUERY_CONTROLS.md) for their bounded behavior.

Action requests identify the saved screen and leaf button, and include only that leaf form's typed inputs and the publication token. A one-level target retains the legacy `instanceId` and optional `rowId` fields. Deeper targets use `instancePath: [{ "instanceId": "outer" }, { "instanceId": "inner" }]`, with `rowId` on each repeater segment. The gateway validates every segment and derives every intermediate parameter scope from the published definition. Deep popup openers use the same path in `popupOrigin`. The client cannot supply replacement script code or arbitrary template parameters. Published runtime responses omit script source, and stale action tokens are rejected.

Identity and context validation supplement the account and project permissions described in [SECURITY.md](SECURITY.md); they do not sandbox authored scripts. Python runs with the gateway account's operating-system access. Memory writes persist locally. External OPC writes are not implemented.

## Example

The independently authored [nested forms workshop](../../examples/nested-forms.json) contains paired machine cards, a two-row saved repeater and a contextual popup. Every card has a nested setpoint form and read-only summary. Its Python preview buttons assert exact local input names and return parameter/input snapshots without writing tags or database rows. See [NESTED_FORMS.md](NESTED_FORMS.md#workshop) for loading and a focused walkthrough.

The independently authored [reusable applications example](../../examples/reusable-applications.json) contains a two-instance workcenter form and an order board with four saved rows. It demonstrates local memory tags and separate input/action contexts without requiring equipment or a database.

From the repository root, with the local development gateway running:

```powershell
node tools/load-example.mjs reusable-applications
```

The loader backs up the current project under `.data/example-backups`, adds missing IDs and preserves existing resources and memory values. Review the draft and publish through Designer. The example file combines a project fragment and tag definitions; it is not a general project-import format.

The separate [Data workshop](../../examples/data-controls.json) includes **Independent station forms**, a screen containing two instances of one Station selector template. Each instance has its own static single-selection list/tree, a caption derived from those local inputs and a Python button that reports the station parameter and selected values. Its other screen, **Records and hierarchy**, demonstrates query choices and loaded-result table paging through three read queries against synthetic SQLite records.

Run `node tools/load-data-controls-example.mjs` to create and immediately publish this new project. The [loader](../../tools/load-data-controls-example.mjs) creates a separate managed `data-controls.db` and shared connection, leaves existing projects unchanged and refuses existing reserved project/connection/database configuration. It accepts an optional plain local gateway URL on port 5090 or 5091. It does not use the additive `load-example.mjs` workflow or require the Work orders example. Workshop preview buttons do not write equipment or database rows.

## Bounds and remaining work

| Limit | Current bound |
| --- | --- |
| Template definitions | 100 per project |
| Components per template | 500 |
| Saved or query result rows per repeater | 100 |
| Repeater columns | 1–12 |
| Repeater gap | 0–64 |
| Expanded components, including containers | 10,000 per project |
| Nesting | At most four template levels; no cycles |
| Query-backed repeater placement | Screen/popup root only |

Template inheritance, richer custom property types, arbitrary property-change events and nesting beyond four template levels remain planned. Invalid references, duplicate identities, cycles, excessive depth, nested query-backed repeaters and expansion limits are rejected at publication. Expansion budgeting reserves 100 rows for every query-backed repeater and includes each row's nested descendants.

Publication captures screens, templates, action scripts and referenced table, dropdown, list, tree and repeater read queries. Runtime Python actions use captured named-query definitions. Published reads and actions carry a publication token, so a stale client fails explicitly after republishing and must reload. Script libraries retain their separate script-publication lifecycle.

Verification covers independent instance and row writes, one-pass substitution, forged targets, invalid graphs, script-source omission, draft isolation and stale publications. See [PARITY.md](PARITY.md) for the evidence and its deployment limits.
