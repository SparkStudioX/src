# Two-way input and application-state bindings

An input can bind its value directly to declared session, screen or private template-instance state. A valid edit updates the state and every control that reads it in that scope. Changing that state through a browser script updates the bound inputs too. A pair of quantity inputs, a selection used across screens, or a reusable form can share values without change handlers that copy one field into another.

## Authoring

Declare a Text, Number or Boolean value in the project's **Session state** editor or a screen's **Screen state** editor. Select an input and choose **fx** beside **Data → Value** in the property sheet. In **Bind input value**, choose the scope and state property, then Apply. Cancel leaves the existing binding unchanged; **Remove binding** returns the control to its ordinary form-value behavior. Save and Publish retain the usual separation between the Designer draft and operator publication.

The saved input property is a direct reference, not an expression:

```json
{
  "type": "spinner",
  "props": {
    "text": "Quantity",
    "fieldKey": "quantity",
    "defaultValue": 24,
    "min": 1,
    "max": 1000,
    "step": 1,
    "stateBinding": { "scope": "session", "key": "selectedQuantity" }
  }
}
```

The fragment omits the component ID and geometry. Its project must declare `sessionState.selectedQuantity` as a Number whose default is accepted by the input. `stateBinding` contains exactly `scope` and `key`. The supported scopes are `session`, `screen`, and `instance` inside a template; keys must name declared state in the relevant scope. The value uses the state's declared type, with no text/number/Boolean coercion.

| Input | Required state type |
| --- | --- |
| Number field, spinner, slider | Number |
| Checkbox, toggle | Boolean |
| Text field, text area, dropdown, radio group, multi-state button, list, tree, date/time input | Text |

Password fields cannot bind to application state. A state-bound input cannot also use an initial-value tag path, a named-query option source or selection-field mappings. Static choice controls require the state default to match one of their available values. Date/time values use the existing local wall-clock text format; this binding does not add time-zone conversion. Numeric bounds, text bounds and the input's other validation still apply.

Session bindings inside templates reference the project's declaration. A template's screen binding references its containing screen or popup; every placed instance must have a compatible declaration there. An instance binding references that template's own `instanceState` declaration, with separate current values for every placement and row. Nested templates do not inherit a parent's private keys. A screen binding may be authored in an unplaced template, but its compatibility is checked when it is placed and published. See [private instance state](INSTANCE_STATE.md).

## Editing and synchronization

The state is the source of the bound control's valid value. Input defaults remain authored metadata; opening another bound form does not replace an existing session choice with its default. Two controls may reference the same key, including controls in different nested templates or repeater rows.

An invalid intermediate edit stays local to the edited input. For example, clearing a numeric field or typing a value beyond its maximum does not overwrite a valid shared number or force the same invalid draft into another control. Correct the draft before submitting that form. Other controls continue to display the valid state value. A subsequent change or explicit reset of that state key refreshes the input from its source and clears the obsolete local draft.

Synchronization does not generate synthetic user-input events on the receiving controls. The control being edited retains its normal change and commit behavior. State assignments and resets use the existing typed `app.state` API. Disabled, hidden, read-only or interaction-locked controls cannot write through an operator gesture; state can still be updated by another active control or a browser resource.

Bindings on labels, colors, visibility and geometry can read the same state with **Session state**, **Screen state** and template-only **Instance state** fx references. Those expression bindings remain read-only. Input state binding is a separate value connection and adds no arbitrary expression writeback. Authors can separately configure a [component property-change handler](COMPONENT_LIFECYCLE.md) to observe accepted value changes, including programmatic updates; it does not turn them into user change/commit events.

## Lifetime and gateway behavior

The existing [application-state lifetime](APPLICATION_STATE.md#scope-and-lifetime) applies:

- Session values are shared by screens, popups and templates in one application run and browser tab. Navigation preserves them; a reload or replacement application run resets them.
- Screen values are shared by that screen and its templates. Leaving and returning starts fresh defaults.
- A popup owns a fresh screen scope on each opening. It shares session state with its opener and does not replace the opener's screen state.

Only declarations and defaults are saved or exported in a `.sparkproj` package. Operator edits remain in memory. Bound values are ordinary form inputs when a form is submitted: the gateway validates them against the published input definitions, just as it validates unbound inputs. The browser state map is not implicitly transmitted to Python, named queries, device writes or access checks. A state binding grants no permission and performs no database or device write.

## Workshop

The independently authored [input-state-bindings example](../../examples/input-state-bindings.json) includes two screens, a popup and two nested templates. It requires no external database, OPC UA connection or device.

```powershell
node tools/load-example.mjs input-state-bindings
```

Use an authenticated local development gateway, review the resulting draft, then publish. The loader preserves existing resources, adds the example resources and merges its three session defaults. Conflicting existing defaults cause it to stop before writing.

1. On **Input state bindings**, change **Quantity** or **Quantity mirror**. The other quantity field and **Nested quantity** follow. Change **Station**, **Ready** or **Screen note** and observe the corresponding nested input.
2. Use either preview button. The screen submission reports six declared fields; the nested submission reports only its four inner fields. Both actions run read-only Python and return the actual submitted values.
3. Open **Review**. Quantity, station and readiness carry over, while the screen note starts empty. A note written here belongs only to this visit to Review.
4. Open **inspection** and edit a shared choice. The underlying application follows. A popup note remains separate; closing and reopening inspection starts it empty again.
5. Clear a quantity or enter `1001`. The local invalid draft does not change the shared valid number. Correct it before submitting.
6. Return to the first screen and activate **Reset workshop defaults**. Its existing input-change script resets the three shared choices and the active screen's note. This reset control is the workshop's only browser input handler; value synchronization uses bindings.

See [PARITY.md](PARITY.md) for recorded verification and current limitations.
