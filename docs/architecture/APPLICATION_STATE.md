# Browser application state

Typed state holds local application choices such as the selected station, a details-pane flag or a screen counter. It is reactive: changing a value reevaluates bindings that read it. State belongs to the current application run in one browser tab. It is separate from gateway tags, database records, form inputs and authenticated user identity.

## Authoring and saved format

Use **Session state** in the project property sheet for values shared by its screens and popups. Use **Screen state** in a screen or popup property sheet for values local to that opening. The editor accepts Text, Number and Boolean defaults. Apply creates one Undo/Redo step; Cancel leaves the project unchanged. Save and Publish release the defaults through the existing project workflow.

The project stores session declarations in `sessionState`; each screen stores its declarations in `state`:

```json
{
  "sessionState": {
    "selectedStation": { "type": "string", "value": "Assembly" },
    "showDetails": { "type": "boolean", "value": false }
  },
  "screens": [{
    "id": "main",
    "state": {
      "selectionCount": { "type": "number", "value": 0 }
    }
  }]
}
```

This fragment shows the state fields only; normal project and screen fields are still required. Each optional map contains at most 64 declarations. A declaration contains exactly `type` and `value`. Names are case-sensitive ASCII identifiers of 1–64 characters, beginning with a letter or underscore; `__proto__`, `constructor` and `prototype` are forbidden. Strings are limited to 4,096 characters. Numbers must be finite, and integer values must fit JavaScript's safe integer range. Booleans accept only `true` or `false`. Null values, arrays, object values and mismatched types are rejected. An absent map means no declarations; a null map is invalid.

`.sparkproj` packages preserve these declarations and defaults. Export does not capture live browser values. Existing projects without state fields continue to load, save, publish and export.

## Scope and lifetime

| Scope | Sharing | Reset boundary |
| --- | --- | --- |
| Session | All screens, templates and popups in this project run and tab | Application reload, project/publication replacement, sign-out or user change |
| Screen | The active screen and its templates/repeater rows | Leaving that screen; returning creates fresh defaults |
| Popup screen | That popup opening and its templates/repeater rows | Closing the popup; reopening creates fresh defaults |
| Template instance | Only that placed template or repeater row | Effective form-context change, removal or closure of its containing screen/popup |

Opening a popup does not reset the underlying screen. Popup state is separate from the opener even when both declare the same key. Templates and repeater rows inherit their containing screen or popup state. They may also declare `instanceState` for private values; a nested template gets its own private map. Templates still cannot declare screen `state` maps. See [private instance state](INSTANCE_STATE.md) for the separate authoring and lifetime contract.

State is in memory only. It is not written to `localStorage`, a gateway file or a database, and is not shared between browser tabs, browsers or users. Designer Preview has its own transient state, separate from the operator runtime. Returning to a screen restores its authored defaults rather than retaining the state of the previous visit.

## Property bindings

The **fx** reference picker includes **Session state** and **Screen state**. A reference names a declared key, for example:

```json
{
  "expression": "station == 'Assembly' ? '#596fc2' : '#64748b'",
  "references": {
    "station": { "kind": "sessionState", "key": "selectedStation" }
  }
}
```

State references work with the existing supported property targets, including captions, visibility, colors, position and drawing state. Expressions read values; they do not mutate state. Missing declarations or unavailable values fail the binding and use the existing component diagnostic behavior. A failed binding does not silently use another scope with the same key.

The gateway checks session references against the project's declarations and screen references against their own screen during Save and package import. A template can be drafted with a syntactically valid screen-state reference before it is placed. Publication checks every concrete template/repeater placement against its containing screen or popup. Each placement must declare the referenced key. Unplaced templates may remain in a draft or publication without a containing screen.

## Binding an input value

Choose **fx** beside an input's **Data → Value** property to connect it directly to a declared session or screen key. This is saved in `props.stateBinding`. Valid edits update that state; other bound inputs and expression bindings follow automatically. The input type and declared state type must match. Invalid intermediate edits stay local to the edited input and do not overwrite shared state. Password fields, tag-seeded inputs and named-query choices do not support this connection. See [two-way input/state bindings](INPUT_STATE_BINDINGS.md) for authoring, scope checks and the workshop.

Bound controls still submit ordinary form fields. A bound nested form shares only the state keys explicitly chosen by its author; its input names and gateway action scope remain local to the inner form. State-driven updates do not invoke the receiving input's change or commit handlers.

## Browser scripts

Published browser startup/screen-open scripts and input change/commit handlers receive these helpers:

```javascript
const current = app.state.get("session", "selectedStation");
app.state.set("session", "selectedStation", "Packaging");
app.state.set("screen", "selectionCount",
  app.state.get("screen", "selectionCount") + 1);
app.state.reset("screen", "selectionCount"); // Restore one authored default.
app.state.reset("session");                 // Restore every session default.
```

Resource startup/screen-open scripts support `"session"` and `"screen"` scopes. Input handlers inside a template also support its own `"instance"` scope. Keys must already be declared, and assignments must match their declared type and bounds. Invalid live calls throw an error for the existing script diagnostic path. State changes update bindings without firing input change/commit events. Stale helpers from a screen, popup, instance, publication or input context that has ended cannot update the replacement context.

Input handlers retain their existing gates: disabled, hidden, read-only or interaction-locked inputs do not dispatch user events. They retain ordered per-control execution and stale-context invalidation. The browser resource lifecycle can still update local state for a viewer during startup or screen-open; such a change grants no gateway privileges. State-based Enabled or Visible bindings are presentation behavior, never authorization.

The older browser-resource `session` object remains a separate untyped script memory bag. Assigning `session.selectedStation` does not update declared session state or its bindings. Use `app.state` for typed reactive state. Browser scripts remain trusted same-origin JavaScript, and these helpers do not sandbox arbitrary authored code.

Gateway Python receives validated parameters and form inputs. Button actions additionally carry a bounded UI snapshot for the [Python UI bridge](PYTHON_UI.md): `system.ui` and `self.parent.custom` read and stage changes to declared state in the calling session. This presentation snapshot is separate from named-query parameters, device writes and permission checks. A bound input submits its current value as an ordinary validated field. An explicit [state-driven template parameter](TEMPLATE_PARAMETER_STATE.md) submits only its referenced values in a separate sparse typed snapshot so the gateway can reconstruct the parameter. Both snapshots are untrusted form context, never authenticated identity or permission sources.

## Example and verification

The independently authored [application-state example](../../examples/application-state.json) combines two screens, a popup and a reusable template. It demonstrates shared session choices, screen-local resets and bindings without an external database or PLC.

Use `node tools/load-example.mjs application-state` with an authenticated local development gateway, then review and publish the resulting project draft. The loader adds missing example screens/templates and merges the three session defaults. It preserves unrelated declarations and rejects a conflicting default or a merged map over 64 keys before writing anything. Reloading an already installed example leaves matching defaults unchanged.

On **Station desk**, change the station, target or details preference. **Review** shows the same shared choices with a fresh screen counter. Toggle its local check or open **Inspect** to see separate screen/popup counters. Close and reopen Inspect to reset its counter. The review screen's **Reset all demo defaults** input exercises both scope-wide reset helpers: shared session values and the active Review screen's values. This original example's inputs are unbound and keep their independent lifetime. The [input-state workshop](INPUT_STATE_BINDINGS.md#workshop) demonstrates inputs that follow state changes and resets automatically.

`tools/test-application-state.mjs` targets only an authenticated disposable gateway at loopback port 5091. It checks definition bounds, binding scope, placement checks, publication isolation, package round-trips, rejection of malformed imports, legacy projects and rejection of implicit browser-state authority in gateway actions. The separate Python UI bridge validates its bounded presentation snapshot; it does not make raw browser state authoritative. Frontend and browser evidence is recorded with the increment in [PARITY.md](PARITY.md).
