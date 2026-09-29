# Named-query property bindings

Select a component, choose **fx** beside a scalar property and select **Named query**. Choose a saved read query and its result column, map any query parameters, and optionally enter a result expression. Apply saves one change in Designer history; Cancel discards the staged settings. Changing binding modes replaces the old binding for that property. Removing the binding restores its authored value.

This includes captions, enabled/visible flags, appearance, process values and limits, and supported position/size properties. Input values retain their existing two-way state binding workflow. Template parameter fx remains a separate contract; a query-bound property cannot feed another query through a property dependency graph.

## One scalar result

A property query must return exactly one row. The selected column must contain a non-null scalar: text up to 4,096 characters, a Boolean, or a finite number whose integral values fit JavaScript's exact integer range. Empty results, multiple rows, missing columns, nulls, objects and oversized values are unavailable data. Use SQL aggregation or a deliberately selective predicate to return the intended row.

The optional **Result expression** uses the fixed reference `value` and the existing bounded expression grammar. Examples:

| Expression | Use |
| --- | --- |
| `value` | Use the selected cell unchanged. |
| `value + ' · production'` | Append text to a text result. |
| `value / 20` | Scale a quantity into a width. |
| `value > 0` | Convert a SQLite integer flag to a Boolean. |
| `value > 14000 ? '#24876a' : '#596fc7'` | Choose a color. |

The transformed value must satisfy the property's existing type and bounds. For example, widths are 1–8,192 pixels, Boolean properties need true/false, and colors need supported color strings. Concatenation requires two strings; use a numeric result directly for a text property to display its number, or format it in the read query. Text produced by a query or result expression stays literal; braces do not trigger a second parameter substitution. The result expression cannot read other properties, application state or another query.

## Query parameter mapping

An omitted mapping uses the named query's saved default. It does not implicitly copy a same-named screen parameter. Explicit mappings use bounded expressions with named references to the current form's parameters, non-password inputs, static custom properties or typed session/screen/private-instance state. Private state belongs to the containing template instance. Tags and query results are not parameter sources in this increment.

Every authored reference must be valid, including aliases in an unused conditional branch. Invalid input drafts block the dependent query. Mapped values use the query's declared native type: numeric parameters receive numbers, Boolean parameters receive Booleans, and text/date/GUID parameters receive text. Integers must be exact and respect their declared range. Database conversion and date/GUID validation remain on the gateway. Saved query defaults retain the existing connector conversion rules.

Shared templates can retain a screen-state reference while edited without a caller. Publication validates every placement against its containing screen or popup. State and custom-property editors include structured query-parameter uses in their dependency checks. Script source remains authored code and is not automatically refactored.

## Preview and refresh

**Run preview** explicitly executes the staged read query and shows the transformed result. Opening the dialog, typing mappings or changing settings does not execute SQL. Changing the draft or its source context invalidates the preview; stale or cancelled results cannot replace the new preview. A successful preview is useful evidence, but Apply does not require a live database connection.

The normal authoring canvas keeps authored positions and values. Designer **Preview** and the operator runtime load query properties when their form opens or effective query parameters change. Each binding supports:

- **On change:** load initially and after parameter changes; respond to explicit application refresh events.
- **Polling:** also refresh after each completed read, at a configured interval from 1,000 to 3,600,000 milliseconds. Reads do not overlap for the same request.

Existing successful gateway form actions and browser-resource `app.refresh()` dispatch the application refresh event. A refresh only runs read queries. Database updates continue to require their separately authored and authorized action.

Identical query/parameter requests share a read within the application run, including across templates and popups. The shortest polling interval among those active consumers drives the shared read; all matching consumers see its refreshed result. Work is bounded to eight concurrent reads and 128 distinct active requests. Excess distinct demand reports unavailable capacity. Repeated refresh requests during a read are coalesced.

Initial loading and changed source context do not display a previous context's value. An ordinary refresh of unchanged parameters can retain the last result while showing refresh status. Failed reads and communication loss clear the usable sample and apply existing binding fallback/interaction rules. Authorization and publication conflicts stop automatic retry; an explicit refresh or context change can attempt again after the cause is resolved. Network work has a 30-second client deadline in addition to gateway/provider limits.

Geometry, presentation and component events consume the same result snapshot. Each nested form owns its context; a popup reads data using its captured opening parameters and its own current state. Closing/navigating, ending Preview, changing publication or signing out cancels obsolete consumers. Late responses cannot change the replacement form. Query-driven automatic property events participate in the existing shared cascade protection, including time spent awaiting query results.

Reusable panels display their own loading, refreshing and unavailable indicators. The optional runtime header cannot aggregate every nested form's live query sample; it reports partial coverage rather than claiming all values are healthy. Full nested diagnostic aggregation remains separate work.

## Saved format and gateway boundary

```json
{
  "queryBindings": {
    "text": {
      "queryId": "production-summary",
      "column": "Produced",
      "transform": "value",
      "parameters": {
        "line": {
          "expression": "selected",
          "references": { "selected": { "kind": "sessionState", "key": "selectedLine" } }
        }
      },
      "refresh": { "mode": "poll", "intervalMs": 10000 }
    }
  }
}
```

`props.queryBindings` and `props.bindings` cannot both own the same target. Structural validation runs on save and package import. Queries must exist, be read queries, and declare mapped parameter names. Publication captures referenced queries with the screens that use them; runtime reads use that publication's definitions and revision checks. Project packages preserve the definitions and report required external connections.

The gateway owns SQL, database credentials, read/write restrictions and project permissions. Browser parameters are untrusted user data, like existing query controls; query mappings or enabled/visible properties do not establish record-level authorization. Read queries must express the intended data access for authorized project viewers. This feature adds no device write or implicit SQL update.

## Workshop and remaining work

The independently authored [query-property workshop](../../examples/query-properties.json) uses the built-in production summary sample query. It demonstrates a session selection, independent reusable panels, transformed geometry/color/visibility, polling, explicit refresh and popup queries. Missing/all-line selections demonstrate empty and ambiguous results. Its loader provisions the known sample query only when absent and refuses to overwrite a conflicting query. No external database is needed.

```powershell
node tools/load-example.mjs query-properties
```

The generated local-only `artifacts/examples/query-properties.sparkproj` is an importable alternative. Verification is recorded in [PARITY.md](PARITY.md). Dataset-valued property bindings, deeper query-backed repeater sources, broader refresh scheduling and atomic screen/query/script releases remain separate roadmap work.
