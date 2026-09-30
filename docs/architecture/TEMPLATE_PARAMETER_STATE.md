# State sources for template parameters

Select a template or repeater and open **Property sheet → Template parameters → ƒx**. Parameter expressions can reference **Session state**, **Screen state** and **Private instance state**, alongside the existing parent parameter, form input and custom-property sources. They use the same bounded expression grammar and Text/Number/Boolean target conversion rules described in [TEMPLATE_PARAMETER_BINDINGS.md](TEMPLATE_PARAMETER_BINDINGS.md).

## Scope and editing

Each expression reads its immediately containing form before entering the child template:

- Session state belongs to the application run in this browser tab.
- Screen state belongs to the containing main screen or popup. A popup has its own screen values.
- Private instance state belongs to the containing template placement or repeater row. It cannot read the child being created or a more distant ancestor's private state.

The fx editor previews the current typed value, stages changes until Apply and supports Cancel, Remove binding and normal Designer Undo. A standalone shared-template editor has no concrete caller screen. It can retain an explicitly named screen-state reference with an unavailable preview; every placed use is validated against its actual screen or popup. Session and private references must name declarations available in the current authoring context.

State declarations show structured uses from parameter bindings as well as ordinary property and input bindings. Referenced keys cannot be renamed, removed or changed to another type until those uses are updated. Script text is not parsed for dependencies.

```json
{
  "parameterBindings": {
    "quantity": {
      "expression": "batch + extra",
      "references": {
        "batch": { "kind": "screenState", "key": "batch" },
        "extra": { "kind": "instanceState", "key": "offset" }
      }
    }
  }
}
```

Here `offset` belongs to the parent template, while `quantity` belongs to its child. This remains a one-way parameter binding: changing the child parameter does not write back to either source.

## Runtime behavior

All declared references must be available and contain bounded scalar values, including references in an unused conditional branch or a binding later overridden by row data. A failure blocks the dependent form rather than substituting its authored default. Strings remain literal after evaluation. Template defaults/static overrides are followed by fx results, then saved/query row overrides, with final target conversion.

Changing referenced state invalidates the dependent form context, including local drafts, private child state and pending callbacks. Unrelated state does not reset it. Independent sibling and repeater-row private state remains separate. Removing a binding restores the static override/default and starts the corresponding fresh form context.

A popup captures its opening source state independently from its own form. Later source-state changes do not silently rebind the open popup. Its nested templates use the popup's current screen state; gateway actions reconstruct the opener from its frozen snapshot and the popup action from its separate submitted snapshot. Source definition changes invalidate the captured definition signature. Query-backed opener rows still undergo the existing fresh row membership/context checks.

## Gateway request boundary

An action or table-edit request can include `bindingState`, aligned outer-to-inner with the instance path and existing `bindingInputs`:

```json
{
  "bindingState": [
    { "session": { "station": "Assembly" }, "screen": { "batch": 4 } },
    { "instance": { "offset": 1 }, "screen": { "permit": true } }
  ]
}
```

Each entry includes only source keys explicitly referenced by that instance's published bindings. Empty entries preserve alignment. The array is limited to the existing four instance levels. Missing required sources, extra keys/scopes, null or malformed maps, wrong types, oversized strings and inexact/nonfinite numbers fail. Repeated session/screen keys within one path must agree. A popup origin carries its own independently validated `bindingState` array; its older opening values need not equal current popup values.

The gateway captures the referenced declaration types and expressions from the same immutable publication as the action. It validates every submitted source against those declarations, recomputes the parameter expressions, reapplies row precedence, and performs the existing form/query membership checks. It neither substitutes declaration defaults for omitted values nor accepts client-computed template parameters. Raw browser state is not added to Python globals; only reconstructed parameters and ordinary validated leaf inputs reach the handler.

These are untrusted operator-supplied values, just like submitted form inputs. They cannot grant permissions or establish identity. Published scripts must enforce business rules and authorized record access; an expression or browser state Boolean is not an authorization rule. Authentication, project permissions and publication revision checks remain unchanged. State parameter bindings do not perform implicit database or equipment writes.

## Workshop and boundary

The independently authored [state-parameter workshop](../../examples/template-parameter-state.json) combines session station selection, a screen batch quantity, separate private offsets, saved repeater rows and a popup with its own batch. Read-only Python buttons report the gateway-reconstructed context without writing tags or records. The local `artifacts/sparkproj/template-parameter-state.sparkproj` can be imported as a separate project. The authenticated example loader also accepts `template-parameter-state`.

Verification is recorded in [PARITY.md](PARITY.md). This increment adds direct browser state sources only. Direct tag-derived parameter sources, parameter writeback, nested query sources, query-backed arbitrary properties and atomic multi-resource publication remain separate roadmap work.
