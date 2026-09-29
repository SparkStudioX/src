# Private template-instance state

A shared template can declare typed internal values while each placed copy keeps its own current values. Use this for a machine panel's draft note, local readiness flag or temporary selection. Public template parameters remain the caller's inputs; private state is local mutable memory; property expressions derive presentation from those values.

## Authoring

Open a shared template from **Project → Templates**, select its document property sheet, and edit **Private instance state**. Declare Text, Number or Boolean defaults, then Apply. Cancel leaves the definition unchanged; Apply participates in normal Undo/Redo. Removing, renaming or changing the type of a key used by a structured binding in that template is rejected until those references are changed. Script text references are not statically refactored.

Inside that template, the component property **fx** picker includes **Instance state**. Input **Data → Value → fx** can bind directly to an instance key. The key and input must have the same type. A valid edit updates mirrored inputs and presentation bindings only in that instance; invalid intermediate drafts stay local to the edited field. An explicit reset discards those drafts even when the accepted value already equals its default. Synchronization does not generate user input events.

```json
{
  "instanceState": {
    "quantity": { "type": "number", "value": 2 },
    "note": { "type": "string", "value": "" },
    "ready": { "type": "boolean", "value": false }
  }
}
```

This is a fragment of a template definition. Component expressions use `{ "kind": "instanceState", "key": "note" }`; input value bindings use `{ "scope": "instance", "key": "quantity" }`. Templates continue to reject `state`, which belongs to screens and popups. Screens and popups cannot declare `instanceState`; place a template to obtain an instance scope.

Declarations follow the existing state limits: 64 keys, case-sensitive ASCII identifiers of 1–64 characters, scalar defaults only, text up to 4,096 characters, finite numbers with safe integers, and native Booleans. Reserved prototype names, null maps, unknown declaration fields and mismatched defaults are rejected. Only declarations and defaults are saved, published or exported in `.sparkproj`; live operator values are never serialized into the project.

## Scope and lifetime

| Situation | Behavior |
| --- | --- |
| Two copies of one template | Separate private maps, even with identical parameters and key names. |
| Nested template | A new private map. It does not inherit or expose the parent's private keys. |
| Saved or query-fed repeater | One private map per stable row ID and effective form context. Reordering unchanged rows preserves it; removing a row disposes it. Reintroducing a removed row starts from defaults. |
| Parameter, definition or binding-context change | The affected form gets fresh private state; pending callbacks from its old context expire. |
| Hidden or disabled instance | Its existing values remain while it stays mounted; existing interaction gates apply. |
| Screen navigation | Leaving disposes the screen's instances. Returning creates fresh values. |
| Popup | Its templates start fresh on each opening. Closing disposes their private state and leaves the underlying screen's instances intact. |
| Publication change, user change, reload or Preview restart | A new application run starts from defaults. |

Session and containing-screen state remain accessible from templates. Resetting one template's private values does not reset those shared scopes, a sibling or a nested template. A child cannot read another template's private map. Its caller can explicitly pass a value through a public parameter fx binding that reads the immediately containing template's private state. See [state-driven parameters](TEMPLATE_PARAMETER_STATE.md).

## Browser scripts and gateway actions

Input event handlers in a template receive its current private scope:

```javascript
const quantity = app.state.get('instance', 'quantity');
app.state.set('instance', 'quantity', quantity + 1);
app.state.reset('instance', 'note'); // One declared default.
app.state.reset('instance');         // This template's own defaults.
```

Assignments must match declared types and bounds. A live call to an unavailable scope or undeclared key fails through the existing script diagnostic path. Helpers captured from a removed instance cannot later write its replacement or shared screen/session state. Browser startup and screen-open resource scripts do not acquire a template instance scope. Browser JavaScript remains trusted application code; private scope is an application-state boundary, not a JavaScript sandbox or an authorization mechanism.

Gateway actions receive validated form inputs and reconstructed published parameter context. Private maps are not implicit Python variables, query parameters or permission inputs. A state-bound field submits its current value as ordinary user input; the gateway validates its published field definition. A parameter expression can explicitly read containing-form parameters, inputs, custom properties or typed state. Only referenced state values are submitted in a separate sparse snapshot; the gateway checks their published types and reconstructs parameters. These values remain untrusted user data and grant no permission.

Individual components display their live binding diagnostics. The saved-graph health summary does not evaluate private-state-owned forms from defaults, just as it does not summarize live query rows; those defaults cannot establish the health of their current values.

## Workshop

The independently authored [instance-state workshop](../../examples/instance-state.json) contains two shared templates, two screens and a popup. It needs no database, tags or equipment. Load it with the existing authenticated example-loader workflow, or import the generated local-only `artifacts/examples/instance-state.sparkproj`:

```powershell
node tools/load-example.mjs instance-state
```

Edit the left panel, compare its mirrored quantity and the untouched right panel, and edit the nested note with the same private key name. Change the left machine context, reset one panel, open and close inspection, and navigate to the repeated panels. Preview submissions run read-only Python and report only the local form fields. The shared shift intentionally demonstrates session state alongside private values.

Verification is recorded in [PARITY.md](PARITY.md). [Property-change and mount/unmount events](COMPONENT_LIFECYCLE.md) now use this private-state lifetime and reject stale helper writes. Derived mutable custom properties, durable state, nested query sources and atomic multi-resource publication remain separate roadmap items.
