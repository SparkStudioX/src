# Nested templates and local forms

A template can contain another template or a saved-row repeater. Each rendered instance and repeater row adds a form boundary. Reusing one machine-card definition twice, including its identical child component IDs, therefore creates independent nested forms. Layout remains a proportional, fixed-canvas layout at every level.

## Supported structure

The screen or popup is the root document; it is not counted as a template level. A root instance is level 1, its nested instance is level 2, and so on through level 4. Each repeater row instantiates its referenced template at one level. Definitions cannot form a cycle, including self-reference. Empty repeaters do not make a cyclic or excessively deep definition graph valid.

| Constraint | Bound |
| --- | --- |
| Template definitions | 100 per project |
| Components in one template | 500 |
| Template levels | 4 |
| Saved rows or query result rows in one repeater | 100 |
| Repeater columns / gap | 1–12 / 0–64 pixels |
| Expanded components, including containers | 10,000 per project |
| Query-backed repeater placement | Screen or popup root only |
| Modal depth | One popup |

The expansion budget includes repeated descendants, not just the unique template definitions. A query-backed repeater reserves 100 rows when checking that budget. Its root-level rows may contain nested templates and saved-row repeaters. A query-backed repeater inside any template is unsupported and rejected. Templates placed inside popups cannot open another popup, including from a deeper descendant.

## Parameters, inputs and state

At each boundary, the child resolves its declared defaults, instance overrides and optional row overrides against its immediate parent's resolved parameter context. It then applies its own `parameterTypes` declarations. Saved authored values remain strings; a child declared with `"limit": "number"` or `"permit": "boolean"` receives native numeric or Boolean values after resolution. An exact parent reference such as `"limit": "{limit}"` passes the parent value into that conversion. Number and Boolean declarations use the validation rules in [TEMPLATES.md](TEMPLATES.md#typed-public-parameters).

Substitution is one pass per authored boundary. Literal braces inside a replacement value are not recursively interpreted. A child receives parameter context, but never copies the parent's editable inputs into its own form. Field names such as `setpoint` can be reused by different nested instances and rows. Input bindings, input-event `inputs`, `app.setInput` and gateway submission validation operate on the immediate leaf form only.

The complete sequence of instance IDs and optional row IDs identifies a draft. Changing a relevant context invalidates that draft and its pending helpers. Identical child IDs beneath different outer instances or saved rows remain distinct. Hiding an unchanged wrapper preserves its draft, while hidden and disabled descendants cannot dispatch input events or interactions.

Templates share their containing screen's declared browser state. A regular screen and its popup have different screen-state instances; both share session state. Templates cannot declare their own `state` block. Every containing screen must declare the screen-state keys required by its descendants. Browser state is not included in a Python action's trusted inputs or parameters merely because a template reads it. See [APPLICATION_STATE.md](APPLICATION_STATE.md).

## Wrappers and interaction

A wrapper's bindings read the immediate parent form. Its children read their own resolved form context. Enabled and Visible apply through the complete ancestor chain: an enabled child cannot bypass a disabled or hidden parent, and a wrapper binding error blocks descendant interactions. Appearance supplies inherited defaults through nesting, with explicitly authored child appearance taking precedence. Wrapper geometry keeps its fixed-canvas fitting behavior.

Display properties are not an authorization policy. Gateway actions still require account/project permissions and validate the saved action identity. Authors remain responsible for checks inside trusted action scripts when an operation has business or equipment consequences.

## Gateway identity and popup provenance

Root actions have no instance target. Existing one-level requests continue to use `instanceId` and an optional `rowId`. A target deeper than one template uses an ordered `instancePath`, outermost first:

```json
{
  "screenId": "nested-saved-rows",
  "componentId": "preview",
  "instancePath": [
    { "instanceId": "machine-rows", "rowId": "bench-c" },
    { "instanceId": "setpoint-form" }
  ],
  "inputs": { "setpoint": 37, "acknowledged": true }
}
```

This fragment omits the normal publication token and root parameter fields. Every segment identifies a container component in the preceding document. A repeater segment identifies one of that repeater's rows; a simple template segment has no row ID. The final `componentId` belongs directly to the last referenced template. The gateway walks the published graph, derives each parameter context and validates the final form's declared inputs. Supplying the same leaf ID under another parent does not make it the same action.

A deep form that opens a popup records the same full path in `popupOrigin`, together with its opener `screenId` and `componentId`. Every popup action validates that opener and its saved target before deriving popup parameters, then resolves the popup action's own target path independently. Client-supplied intermediate parameters or script text cannot replace the saved definition. For a root query-backed row, the existing captured-query recheck still applies before resolving its descendants. Stale tokens, missing containers, invalid row membership and mismatched popup targets fail explicitly.

Opening a popup initializes its own inputs without submitting or replacing the opener's draft. Closing and reopening starts a fresh popup form. One popup remains the limit. Publication captures the referenced resources; changing a draft does not modify an already published action.

## Workshop

The original [nested forms fixture](../../examples/nested-forms.json) needs no database, tags, image assets or equipment. It adds five template definitions and three screens:

- **Nested forms** has two outer machine-card instances. Each contains the same nested setpoint form and a read-only summary. The wrapper controls disable both cards or hide Packaging cell.
- **Nested saved rows** places that machine card in a two-row saved repeater, with row IDs `bench-c` and `bench-d`.
- **Machine inspection** is a popup opened by a button inside the nested setpoint form. It contains a nested inspection form with its own note, preview and Close buttons.

The nested setpoint form declares `limit` as Number and `permit` as Boolean. Its preview script asserts both native types and the exact local input names `setpoint` and `acknowledged`. The popup script accepts only `inspectionNote`. Both return the actual parameter/input snapshots and a readable result message. Neither writes tags or database records. Input-change events update a containing-screen edit counter and the session's last-edited machine; these deliberate shared values are distinct from each form's independent draft.

Run commands from `source/`. The additive loader recognizes `nested-forms`, backs up the current project under `.data/example-backups`, and preserves existing resource IDs. It does not overwrite an earlier loaded copy or automatically add screens to an operator menu. Authenticated gateways require an authenticated CLI session; for the isolated 5091 development gateway, use the real-session preload and the existing local test-account file described in [SECURITY.md](SECURITY.md#verification-commands):

```powershell
$env:SPARKSTUDIO_TEST_AUTH_FILE = Join-Path $PWD '.data/test-evidence/security-test-accounts.json'
node --import ./tools/test-auth-session.mjs tools/load-example.mjs nested-forms http://127.0.0.1:5091
```

Review the draft in Designer and publish through the normal project workflow. The fixture contains navigation between its two regular screens. Configure its initial navigation or menu entry deliberately in the containing project.

To inspect isolation, enter different setpoints in Assembly and Packaging, then preview each. Hide and show Packaging to check that its draft remains intact. Open an inspection, enter a note and preview it: only the popup note is submitted. Close it and verify the machine-card drafts. On the saved-row screen, edit both rows independently and repeat the preview/popup checks. The summary's screen counter is shared deliberately and resets with that screen context; the session's last-edited machine survives navigation.

This fixture demonstrates the bounded contract. It does not claim arbitrary nesting, template inheritance, private instance properties, bidirectional parameter binding, nested query sources, stacked popups or a general reusable application framework. Model, gateway and browser acceptance evidence belongs in [PARITY.md](PARITY.md).
