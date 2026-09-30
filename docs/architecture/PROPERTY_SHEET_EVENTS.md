# Property sheet, input events and groups

Select a control, template instance or repeater to edit its name/value property sheet. Common rows cover General, Layout and Appearance. Each supported binding target has an **fx** button on its own row, so a position, size, caption or color can be bound directly where its static value is edited. Existing type-specific settings remain available for input defaults/ranges, options, tag paths, queries, actions and media. Complex options, parameters and other structured settings retain their dedicated editors. This is an explicit property surface, not an arbitrary binding API for every JSON field.

## Common properties

| Property | Stored field | Accepted binding result |
| --- | --- | --- |
| Text | `props.text` | Text, Boolean or finite number, displayed as text |
| Enabled, Visible | `props.enabled`, `props.visible` | Boolean |
| X, Y | `x`, `y` | Finite number from 0 to 8,192 |
| Width, Height | `width`, `height` | Finite number from 1 to 8,192 |
| Font size | `props.fontSize` | Finite number from 1 to 256 |
| Accent color | `props.color` | Hex color |
| Background | `props.backgroundColor` | Hex color |
| Text color | `props.foregroundColor` | Hex color |
| Border color | `props.borderColor` | Hex color |
| Border width | `props.borderWidth` | Finite number from 0 to 32 |

Numeric displays and gauges also expose **Tag path** in a Data section, with an fx button for complete paths derived from form inputs. Multi-state indicators add State value. Process displays add Value, Minimum, Maximum, Decimals, Unit, Show value, Show percent and Orientation where applicable. Drawing components add Stroke color, Fill color, Stroke width, Rotation, Flowing, Reverse flow and Active where applicable. There are 30 distinct supported target names across these type-specific surfaces; ordinary controls retain the 13 common targets. See [process display properties](COMPONENTS.md#process-displays) and [drawing properties](DRAWING.md) for the supported subsets. Colors accept `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`; drawing Fill color also accepts `none`. Clearing an optional static appearance value restores its normal component/theme default. Appearance properties affect the rendered control; an SVG graphic, icon or control's internal details may still use their own component styling.

The binding dialog accepts named Custom property, Form input, Parameter, Tag, Session state, Screen state and available Private instance state references. Scalar Named query bindings have their own source/parameter/result controls. It previews a result or diagnostic before Apply; Cancel preserves the existing definition. Expressions use the constrained grammar in [PROPERTY_BINDINGS.md](PROPERTY_BINDINGS.md), not Python or JavaScript. A valid definition may be authored while its tag is unavailable; evaluation failures show diagnostics and block affected interactions. Failed dynamic tag paths and process properties clear their evaluated value instead of displaying an authored fallback. See [QUERY_PROPERTIES.md](QUERY_PROPERTIES.md) for query evaluation and refresh.

Geometry bindings apply in Preview and the operator application. The authoring canvas retains stored X/Y/Width/Height so selection handles remain stable while an input or tag changes. Resizing or moving a bound control changes that stored geometry; its binding can override the result in Preview. Bounds describe allowed property values, not a guarantee that a dynamically positioned control remains fully within its screen.

Ordinary leaves in templates and saved repeater rows use their instance's form/parameter context. Popup leaves use the popup context. Template/repeater instances accept the 13 common targets using the containing screen or popup context. Their Text property is an accessible wrapper label. Disabled instances and instances with binding errors lock every child input, event and action. Hidden instances have no visible or interactive child content in Preview/runtime, but unchanged row drafts remain mounted. Instance appearance supplies defaults; explicit child appearance wins. Template selection, row source definitions, columns and gap remain structural. Template parameter values have dedicated [fx bindings](TEMPLATE_PARAMETER_BINDINGS.md). Component custom Number/Text/Boolean properties remain static definitions; mutable [session/screen state](APPLICATION_STATE.md), [private instance state](INSTANCE_STATE.md) and bounded [property/lifecycle events](COMPONENT_LIFECYCLE.md) are separate implemented features.

List/tree options use a dedicated row editor with Value, Label, tree Parent and default selection, plus Apply/Cancel. Query choices expose named-query/value/label settings; Tree view additionally requires a parent column. Same-form row mappings remain dedicated structural settings. A table's Page size is a static integer from 1 to 100, default 25, and pages only the loaded result. None of these fields adds a binding target. See [choice authoring and table paging](QUERY_CONTROLS.md) for validation, keyboard and scope rules.

## Input value and application state

Inputs other than password fields can connect their value to a declared session, screen or available private instance key through the property sheet's state-binding controls. The saved definition is `props.stateBinding: { scope, key }`. This direct two-way connection is separate from the read-only fx expression targets above: a valid edit writes the chosen state value, and other controls bound to it follow without synchronization scripts.

The state type must match the input, and its default must satisfy that input's validation. Tag-seeded values and named-query choice sources cannot be combined with this binding. Invalid intermediate input remains local instead of propagating to shared state. Template and repeater inputs use the containing screen or popup's state scope, so instances share only the keys their author explicitly binds. See [input-state bindings](INPUT_STATE_BINDINGS.md) for supported types, lifetime and gateway submission behavior.

## Input change and commit events

All fourteen inputs can declare JavaScript **Value changed** (`change`) and **Value committed** (`commit`) handlers. Non-password inputs also support gateway Python; new supported handlers default to Python and existing JavaScript is preserved. Each language has a separate editor draft, not automatic code translation. Apply records one undo step; Cancel discards changes. Save and Publish deploy the definitions. Default Preview blocks scripts; administrator Live actions Preview can run them, and Python resolves saved draft code. See [Python component events](PYTHON_COMPONENT_EVENTS.md). The payload and `app` examples below describe JavaScript.

Handlers receive:

| Value | Meaning |
| --- | --- |
| `event.type` | `change` or `commit` |
| `event.componentId` | Authored source control ID |
| `event.fieldKey` | Declared source input name |
| `event.value` | Current operator-entered value |
| `event.previousValue` | Prior edit for change; last committed value for commit; may be `null` when the initial value was unavailable |
| `inputs` | Snapshot of the current form values when the event occurred, including the source's new value |
| `parameters` | Snapshot of the current screen/template/popup parameters |

`app.notify(message)` displays a message on the source input. `app.setInput(fieldKey, value)` changes a declared input in the same form, with its type, bounds and options validated. It cannot reach a sibling template instance, another repeater row or a parent form. Assigning through this helper does not invoke this or another input's handlers. Changing the local `inputs` snapshot alone does not update the form.

For example, an input's change handler can update another declared numeric field:

```javascript
app.setInput("doubleQuantity", event.value * 2);
```

A commit handler can report the completed local edit:

```javascript
app.notify("Committed " + event.fieldKey + ": " + event.value);
```

Use compatible field types and values. JavaScript handlers do not receive the gateway Python `system` namespace. Python input handlers use the saved gateway event path and scoped UI bridge; password fields are excluded from their automatic snapshots. Explicit Python button submissions retain full-form validation and separate library publication. Choose a deliberate authorized action for database or tag writes; an input event is not an implicit persistence operation.

A commit marks completion of the user's editing gesture; it does not submit the form or write a tag/database. A gateway button action still performs its normal form validation when invoked. Handlers may encounter intermediate user-entered values and should validate any assumptions before using them.

### Event timing

| Control interaction | Change | Commit |
| --- | --- | --- |
| Text, password, number, date/time and typed spinner value | Each changed value entered by the user | Enter or blur |
| Text area | Each changed value entered by the user | Ctrl/Meta+Enter or blur; plain Enter inserts a newline |
| Checkbox, toggle, dropdown, list, tree, radio and multi-state choice | Changed choice | Immediately after the change |
| Spinner increment/decrement button | Changed numeric value | Immediately after the change |
| Slider | Changed pointer or keyboard value | Pointer release/cancel, blur or navigation-key release |

Repeated commits of the same value are suppressed. List/tree focus movement and tree expansion do not select an item or emit change/commit. Initial/default values, incoming tag refreshes and programmatic assignments establish state silently. Enter during an IME composition does not commit in text-entry controls. Disabled, hidden or interaction-locked controls do not dispatch their input events.

For a state-bound input, the edited control retains this user-event timing. Updates arriving through its shared state binding do not fire change/commit handlers on receiving controls. This prevents a pair of inputs bound to one state key from creating a handler feedback loop.

Events run in order for each control, with at most 32 pending handlers. Overflow skips new events and displays an error; this is not a durable queue. Each handler is limited to 65,536 characters. Changing the form context, handlers or relevant input definitions, leaving Preview, disabling/hiding the control or unmounting invalidates queued work and prevents stale `app` helpers from affecting the new context. This does not forcibly terminate arbitrary JavaScript already running.

Browser event authors are trusted. JavaScript handlers run with the page's privileges, and their source is delivered to the browser as part of the project publication. The scoped helpers and expression evaluator do not make arbitrary JavaScript a security sandbox. The gateway's existing publication/input checks remain separate from browser behavior.

## Persistent flat groups

Select at least two controls and choose **Group** or press Ctrl+G while the canvas is focused. **Ungroup** or Ctrl+Shift+G removes membership. Groups are flat and local to one screen or template; grouping multiple existing groups merges their members into one group. Grouping does not create another form scope, add a template or alter input/event definitions.

Clicking or marquee-selecting a member selects the entire group. Move, duplicate and delete operate on the group atomically. Alignment and distribution treat each group as one unit and retain its internal spacing. A copied group gets an independent group ID. Explicit custom-property references among copied controls point to the new copies; external references, form-input names inside bindings and authored scripts remain unchanged and need review.

Select a single group to show its bounding box and bottom-right resize handle. Resizing uses a common horizontal factor and a common vertical factor for all member positions and boxes, anchored at the group's top-left corner. The factors may differ; this is not an aspect-ratio lock. Font sizes remain authored. Each child is kept at least 40×28 and the group is constrained by canvas bounds. If those constraints cannot be satisfied, such as impossible imported geometry, the resize is a no-op. Active layout bindings may override stored resized geometry in Preview.

Grouping, ungrouping, duplication and each resize gesture participate in project Undo/Redo. Undo retains the latest acknowledged gateway revision rather than replaying an old save token. Membership survives project save/publication. Groups have at least two members and a `groupId` of at most 64 characters, starting with a letter or underscore and then using letters, numbers, underscores or hyphens.

## Example and verification scope

The independently authored component workshop combines these features and can be loaded with:

```powershell
node tools/load-example.mjs component-workshop
```

Use the local disposable/development gateway supported by the example loader, review the resulting draft, then publish. The separate [Data workshop](../../examples/data-controls.json) demonstrates list/tree commit notifications and independent template form values. Run its [loader](../../tools/load-data-controls-example.mjs) with `node tools/load-data-controls-example.mjs` to create and immediately publish a new project with a separate synthetic SQLite database; existing projects remain unchanged. Its preview actions report values without writing records or equipment.

See [PARITY.md](PARITY.md) for recorded authoring, model/renderer, gateway and browser evidence and limits. Older package/installer evidence does not establish acceptance of subsequent additions.
