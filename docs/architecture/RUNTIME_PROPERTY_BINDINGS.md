# Runtime property bindings

Select a component in Designer and choose **ƒx** beside a runtime property.
General, Layout and Appearance come first, followed by component-specific
settings, shared configuration, and finally Custom properties. Bound rows show
their expression or query and disable the saved literal editor. Remove the
binding to restore the authored literal. Apply and Undo use Designer history.

This feature requires preview.11 or a later compatible build. Preview.10 predates it.

## Supported values

The browser and gateway share `apps/web/src/runtimeProperties.json`, which
declares applicable component types, value types, enums and limits. It covers
common properties plus chart axes/type/series/legend, process and gauge limits,
drawing points and symbols, image presentation, choice options and indicator
states, table data/columns/page size, input validation and format, history
range/paths, alarm priority, repeater columns/gap, and container layout and pane
presentation. Pane paths address existing authored pane indexes.

Custom Number, Text and Boolean values also have ƒx. Expressions can read bound
custom values on this component or a sibling in the same form. Dependencies
resolve before consumers regardless of definition order. Cycles, missing
sources, wrong types and unavailable query/tag values produce diagnostics rather
than silently reading the saved custom value. Template placements and repeated
forms keep independent scopes.

Expressions retain the bounded scalar grammar. Structured properties such as
options, points, chart series and datasets accept **JSON text**, then validate
and decode it to the required structure. For example, a text custom property
containing `[{"label":"Running","value":"run"}]` can supply an Options binding.
The expression `choices` references that custom property. Structured text is
limited to 4,096 characters; literal expression source is limited to 2,048.
Larger chart data should use the existing named-query dataset binding. Invalid
JSON and unknown fields are rejected.

An explicit **Data** expression/query-property binding takes precedence over
a chart's named-query dataset source. Remove that Data binding to restore the
dataset source; a failed binding does not silently fall back to old data.

An expression or named-query result can supply a property, but not both at
once. Scalar query bindings still require exactly one row and one chosen
column; use a JSON text column for a structured target. Query parameters may
read custom properties and their dependencies, but cannot indirectly introduce
tag or password-input sources. The gateway reconstructs permitted custom
sources when executing published parameterized actions.

## Runtime behavior

The engine resolves nested properties without modifying saved definitions.
Related fields, such as chart axis bounds, are checked together. A failed
binding displays its error and prevents interaction with the affected control.
Bindings do not grant tag, query, command or script permissions.

Input validation bindings control browser presentation and validation. Published
gateway input constraints remain authoritative and cannot be loosened by a
browser binding. Input **Value source** continues to use its existing typed
two-way state binding; expression bindings do not add reverse writes.

Tables can display an authored or bound dataset. Supplied data takes precedence
over a configured query while present. These tables support presentation,
filtering, paging and selection; database cell/batch editing requires a
named-query source and is not allowed with supplied data.

A bound split ratio or dock size is controlled by its source, so its resize
handle is disabled until the binding is removed. Unrelated pane label updates
do not reset the selected tab or local sizing. Repeater gap and column changes
retain the normal per-row form scopes.

IDs, field names, template/query/command declarations, scripts, event definitions,
permissions, initial form defaults and resource catalogs remain configuration.
Template parameters, input state and chart query datasets retain their dedicated
binding editors. Property-change handlers retain their existing scalar watch
contract; adding a runtime binding does not add arbitrary structured event
payloads or Python assignment targets.

Bound image asset IDs must refer to assets already available on the gateway.
Project packages include authored static asset references; assets referenced
only by a dynamic expression must be transferred separately.

## Workshop

The independently authored **Runtime property bindings** workshop is described
in `examples/runtime-property-bindings.json`. Its distributable package is
maintained at `artifacts/sparkproj/runtime-property-bindings.sparkproj`.

1. Import the package, review it and explicitly publish the application.
2. Change **Chart maximum**. The chart axis reads a custom property that is
   itself bound to session state.
3. Toggle **Show chart legend**. The legend, table row count and repeater columns
   change together.
4. Change **Repeater gap** and **Split position**. Write different notes in the
   embedded forms and confirm their independent values remain.
5. Open a second operator tab. Its state starts from independent defaults.
6. In Designer, inspect the corresponding ƒx rows and the custom property at
   the bottom. Remove a binding, Undo, and verify the original binding returns.

No gateway connections, tags, credentials, scripts or equipment writes are
included in this portable example.
