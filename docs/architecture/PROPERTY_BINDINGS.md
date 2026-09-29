# Component properties and bindings

Select a control on the canvas and use its name/value property sheet or **Custom properties** in the inspector. Each supported property has an **fx** button on its row. These features are available on ordinary controls, controls inside templates, and template/repeater instances. Instances use the containing screen or popup input/parameter context; their children retain their separate form context. The [property sheet and events guide](PROPERTY_SHEET_EVENTS.md) covers the full target list, input events and groups.

Custom properties are component-local saved values with a Number, Text, or Boolean type. A binding can read its own custom properties or those of a sibling in the same screen/template. Duplicating selected components copies custom definitions and remaps explicit custom-property references between the copied controls. References to controls outside the selection remain unchanged. Authored Python and form-input reference names are not rewritten; review those when duplicating forms.

The 13 common binding targets are **Text**, **Enabled**, **Visible**, **Accent color**, **X**, **Y**, **Width**, **Height**, **Font size**, **Background**, **Text color**, **Border color**, **Border width**. Type-specific targets are **Tag path** (numeric/tag values and gauges), **State value** (multi-state indicator), process-display **Value**, **Minimum**, **Maximum**, **Decimals**, **Unit**, **Show value**, **Show percent**, **Orientation**, and drawing **Stroke color**, **Fill color**, **Stroke width**, **Rotation**, **Flowing**, **Reverse flow**, **Active**. There are 30 distinct target names; each control exposes only its supported subset. Text accepts a scalar result; Enabled and Visible require Booleans. All color targets accept hex colors (`#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`); drawing Fill color also accepts the exact string `none`. X/Y accept 0–8,192, Width/Height 1–8,192, Font size 1–256 and Border width 0–32. Numeric results must be finite. Static Enabled and Visible default to true. Hidden controls stay dimmed and selectable while designing; they disappear from Preview and the operator screen. Disabled state and visibility are user-interface behavior, not permissions or server authorization.

A Tag path binding computes a complete path from form inputs or other named references, for example `"[default]EquipmentDemo/" + machine + "/Load"`. Results must be nonempty text up to 1,024 characters with no control characters or unresolved `{parameters}`. Tag-path failures clear the path and show a diagnostic; they never display the authored fallback tag as the selected machine. The value/gauge still displays the actual resolved tag quality. Input initial-value tag paths keep their existing saved-parameter behavior.

Process Value/Minimum/Maximum bindings require finite numbers with safe integral values. Decimals requires an integer from 0–6, Unit accepts text up to 32 characters, display flags require Booleans, and Orientation accepts exactly `horizontal` or `vertical`. LED has no range, flag or orientation targets; tank/thermometer have no orientation target. Invalid constant results fail validation. Dynamic min/max pairs must resolve in order or the reading becomes unavailable. Failed process bindings clear their evaluated property instead of reusing a saved fallback. See the [process-display contract](COMPONENTS.md#process-displays).

All six drawing types support Stroke color, Stroke width (finite number 1–32 pixels) and Rotation (finite number 0–360 degrees). Rectangle, Ellipse, Pipe and Equipment symbol support Fill color. Pipe alone supports Boolean Flowing and Reverse flow; Equipment symbol alone supports Boolean Active. These three state flags default to false. Use the existing Accent color target for flow marks or active equipment. Their sources have the same form, template, repeater-row and popup scopes as other bindings. Failed drawing-property bindings clear the evaluated property and show Graphic unavailable. Points, rectangle corner radius, symbol choice and navigation configuration are structural settings without fx bindings. See [drawing geometry and properties](DRAWING.md).

## Authoring a binding

Choose **fx** beside the property to add or edit its binding. Add named references using Custom property, Form input, Parameter, Tag, Session state or Screen state. The reference names become expression variables. For example, a reference named `quantity` can point to the `quantity` form input, and `minimum` can point to this control's custom property:

```text
quantity > minimum
quantity > minimum ? "Ready to apply" : "Enter a quantity"
quantity > minimum ? "#23866b" : "#ac5e19"
```

The dialog provides a live result or error. Apply changes the project draft; Cancel leaves it unchanged. Save and Publish retain the usual draft/operator separation. A missing tag or temporarily unavailable value can be configured ahead of a connection. Invalid syntax, undeclared references, and invalid constant target types are rejected by the editor. The gateway independently validates saved definitions and their declared scope. Changing or removing a referenced input/component requires correcting its binding references before saving.

Expressions support numeric and quoted string literals, `true`/`false`, parentheses, unary `!`/`+`/`-`, arithmetic, comparison, equality, `&&`, `||`, and `condition ? yes : no`. They do not execute JavaScript or Python, access object members, or call functions. Arithmetic requires numbers; concatenation requires two strings; comparisons require matching types. Logical operators and conditions require Booleans, and short-circuit branches do not read unused sources. Tag paths may contain declared `{parameter}` placeholders with one substitution pass.

Each binding is limited to 2,048 expression characters, 256 tokens, 32 nesting levels, and 32 references. Each control supports 32 custom properties; text values are at most 4,096 characters. Numeric values must be finite and integral values must fit JavaScript's safe integer range. These bounds complement project-size limits; they do not establish load-test capacity.

## Runtime behavior

Bindings reevaluate from the current form's resolved input values, parameter context, custom defaults, tag snapshot and declared application state. Each template instance/repeater row uses its own form inputs and parameters; a popup uses its own form context. Custom values are saved definitions in this version, rather than mutable browser session variables. Use [application state](APPLICATION_STATE.md) for typed reactive session or screen values.

Geometry bindings change positions and sizes in Preview and the operator application. The authoring canvas keeps stored geometry so live changes cannot move its handles. Stored geometry changed by moving/resizing can therefore be overridden in Preview. Other type-specific properties retain their existing configuration editors; the supported targets do not imply that every JSON property is bindable.

Bad or missing tag quality, lost gateway communication for a tag source, missing values, and type/evaluation errors produce a visible diagnostic. An errored component blocks interaction. A failed visibility expression remains visible so its diagnostic can be read. These expression bindings do not perform device writes, update input values, execute named queries, or create property-change events. Server actions still enforce their existing input and publication contracts.

An input can separately use a [two-way state binding](INPUT_STATE_BINDINGS.md) to connect its value to a declared session or screen key. That direct typed connection updates shared state from valid edits and reflects state changes in the input. It does not change the expression grammar, add expression writeback or change the published gateway action contract.

Template and repeater **Template parameters** rows now have their own fx buttons. These [parameter expressions](TEMPLATE_PARAMETER_BINDINGS.md) use parent inputs, parameters and custom properties; their results feed child form context and are reconstructed by the gateway for published actions. They are separate from the wrapper's presentation bindings and do not directly support tag or browser-state sources.

## Component events and canvas history

For a button with **Run Python event**, choose **Edit onClick event**. The expanded editor provides syntax highlighting, line numbers, find, completion, form/parameter context, and saved library names. Apply creates one project history step; Cancel discards the event draft. Save and Publish the project to release the action. Python runs on the gateway with `inputs`, `parameters`, and `result`, not a browser component object. Libraries retain their separate script publication. Test an action in Preview after applying it.

Input controls also have optional browser JavaScript change/commit handlers. They are user-input events, separate from automatic binding reevaluation and gateway Python button scripts. See the [event timing and scope contract](PROPERTY_SHEET_EVENTS.md#input-change-and-commit-events).

Drag across empty canvas space to select intersecting controls; Shift/Ctrl adds to the selection. Ctrl+G creates a persistent flat group and Ctrl+Shift+G ungroups. Groups move/copy/delete as one unit and expose a bounding-box resize handle; child boxes scale on each axis while font sizes stay authored. Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes. A new edit clears Redo. History preserves the current gateway revision across Save, so restoring earlier content does not reuse stale revision tokens.

## Example and verification

```powershell
node tools/load-example.mjs property-bindings
```

The **Binding workshop** screen demonstrates form-driven text/color, visibility, and a tag-qualified Enabled binding. Its Permit tag is synthetic local memory data. The Apply button returns form values and writes no external data. Publish the saved project to open it in the operator application.

Run `node apps/web/check-property-bindings.mjs`, `node apps/web/check-bound-components.mjs`, and `node apps/web/check-canvas-model.mjs` for the model/renderer checks. `node tools/test-property-bindings.mjs` targets only a disposable gateway on loopback port 5091 and checks definition validation and publication isolation. It restores and republishes the original draft afterward. Browser verification and its scope are recorded in [PARITY.md](PARITY.md).
