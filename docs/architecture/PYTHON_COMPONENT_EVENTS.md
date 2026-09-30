# Python component events

## Supported handlers

Input **change** and **commit**, component **mount**, **unmount**, **property change**, and **message** handlers can use Python 3 or JavaScript. New supported handlers default to Python; existing JavaScript definitions retain their language and source. Switching the editor's language selects a separate draft, not a translation of the current code. Apply saves the selected draft; Cancel discards changes. Template/repeater wrappers support all automatic Python event families in their containing form. Password controls support Python mount, unmount, property and message handlers with password text and values excluded; their input change/commit handlers remain JavaScript-only. Ordinary components inside templates and repeater rows support all Python event families.

Python executes on the gateway with the same scoped `self` and `system.ui` interface as [Python button actions](PYTHON_UI.md). An operator must have Operate permission. Designer Preview starts read-only; a gateway administrator must enable Live actions to test Python against saved handler definitions. Save handler changes before testing; publish them for operators. Compile-only syntax checks can run without enabling Live actions.

## Mounted and Unmounted

Mounted receives `event.type == "mount"` and the saved `event.componentId`. It can initialize declared local state or unbound presentation properties using the same API as a button:

```python
self.text = "Ready"
print("Mounted", self.id)
```

The initial property snapshot remains silent. Mounted runs before that component's queued Python input, property-change and message events. A wrapper's `self` is the wrapper itself and its parent is the containing screen/template; it does not address each repeated row or navigate into child forms.

Unmounted receives `event.type == "unmount"`, captured departing values and a bounded gateway invocation after pending live work is canceled:

```python
print("Closed", self.id, "with heading", self.text)
```

`self` and `system.ui` reads use that captured form. Local UI assignments fail explicitly because the component has retired; no cleanup effects are applied. Authorized gateway operations remain available, but cleanup delivery is best effort. Current permissions, publication and Preview checks still apply; stale publications and query rows removed from the authoritative source can reject it. Browser close, crashes or network loss cannot guarantee cleanup. Use gateway events or durable records for critical work. See [component lifecycle](COMPONENT_LIFECYCLE.md) for exact bounds and JavaScript cleanup behavior.

## Input events

Select an input and open its event editor. `event.type` is `change` or `commit`; `event.componentId` and `event.fieldKey` identify the source. `event.value` and `event.previousValue` are typed scalar values. The first previous value can be `None`. `event.origin` identifies a user input event.

```python
self.getSibling("note-preview").text = "Note: " + event.value
print("Changed", event.previousValue, "to", event.value)
```

Use commit for work that should happen after an edit is committed rather than for every keystroke. Input events can inspect incomplete forms without requiring unrelated mandatory fields to be filled. Numeric controls may supply bounded text for incomplete edits, such as an empty string. An unrelated unavailable tag-bound input appears as `None`; it does not block the event. Check the value type before arithmetic; this snapshot is not a validated form submission. Other inputs retain their declared scalar types and transport bounds. Programmatic state synchronization does not synthesize user input events. Password input change/commit handlers use JavaScript, and password field values are excluded from every automatic Python handler's input snapshot. Existing explicit Python button submissions retain their existing form-validation/password behavior.

`self.value` reads the captured value of a non-password input. Assigning it updates an unbound field in the same live form after the complete UI response passes validation. Assign through declared state for state-bound fields; tag, query, selection and read-only fields retain their source ownership. A later operator edit, expired instance or invalid effect discards the entire UI response. This applies to button, input, lifecycle, property and message Python handlers; Unmounted permits captured reads only.

## Property changes

Select a component, open **Edit actions & events**, select **Property changed** and choose the properties to watch. `event.property` names the changed property. The payload contains scalar `value` / `previousValue`, `available` / `previousAvailable`, `error` / `previousError`, and `origin`.

```python
if event.available:
    self.getSibling("event-log").text = (
        event.property + " changed to " + str(event.value)
        + " (" + event.origin + ")."
    )
```

These are SparkStudio scalar samples, not qualified tag values. Origin describes the presentation change and is diagnostic context, not proof of operator identity or authorization. Read authoritative process values through `system.tag` or `system.db`. Equal samples do not generate additional change events. A handler that writes its own watched property can cause a loop; event queues and feedback limits stop uncontrolled cascades.

Password Python handlers may watch appearance and flags such as `enabled`, but cannot watch `text` or `value`, read `self.text`/`self.value`/`defaultValue`, or receive password inputs. Existing JavaScript password caption watchers remain valid; password input values are excluded from property watchers in both languages. Wrapper property and message handlers address the wrapper's containing form, never its child forms or all repeated rows.

A bound property remains owned by its binding. To change it, update its source state instead of assigning over the binding:

```python
self.parent.custom.part = "Mounting bracket"
```

Inside a template this updates declared private instance state; outside a template it updates declared screen state. The state binding then updates the display and its property-change handler can respond.

## Component messages

Open a component's message handlers, select Python, and choose the message type and scope. The receiving handler gets its own component context and `event.messageType`, `event.scope`, `event.messageId`, and `event.payload`.

```python
self.text = event.payload["reason"]
self.parent.custom.quantity = self.parent.custom.target
print("Received", event.messageType, "in", event.scope)
```

Native Send message buttons and existing JavaScript `app.sendMessage` send to either language. Instance, screen and session retain the [local routing rules](COMPONENT_MESSAGING.md). Session means one browser tab. Python receivers execute on the gateway, but local component messages are not thereby broadcast to other tabs. For explicit delivery to operator tabs, use the separate gateway `system.ui.sendMessage` API described in [component messaging](COMPONENT_MESSAGING.md).

## Execution and authority

The browser sends an event selector and bounded event data, not executable Python. The gateway finds the handler in the requested published component, reconstructs its parameters and instance/row context, checks permission and publication, and runs that saved code. Preview uses the saved draft and its existing project/session-bound capability. Event payloads and UI snapshots are untrusted inputs; they cannot replace the published script or grant access to a different project or instance.

Input events and automatic component events preserve their separate ordered queues, each bounded to 32 waiting events. Dispatched Python work also uses a shared component queue; this is not one aggregate 32-event budget across the outer queues. The gateway runs at most four events per project and sixteen gateway-wide. Bursts wait asynchronously for capacity, bounded to 32 waiting events per project and 128 gateway-wide; a full admission queue rejects additional requests. Its two-second deadline includes queue time and execution, and canceled or expired waiters cannot begin a script later. The browser allows three seconds for the response, including transport overhead. Navigation, removed components, expired Preview sessions and changed publications invalidate pending local results. A successful result applies its validated UI effects atomically to the original live owner. Conflicting newer edits cause rejection rather than silent overwrite. Exceptions, invalid UI effects and timeouts apply no staged UI changes. Gateway tag/database writes remain immediate and cannot be undone by discarding the UI response.

Python exceptions and bounded output are shown in the event's diagnostics. `print()` helps inspect event values; avoid printing credentials or sensitive data. Event history is diagnostic output, not a durable business record.

## Workshop

Import the independently authored `python-component-events.sparkproj`, review it and publish it. It contains synthetic work orders and local drafts; it requires the companion gateway build and CPython, but no database, device or internet connection. It performs no gateway data writes.

1. In Station A, select WO1002. The Python commit handler loads the part and target and updates the quantity through private state bindings. Station B stays unchanged.
2. Inspect the event line: the part's property-change handler records the bound property change.
3. Enter quantity 0 or a value greater than the target. The Python change handler reports the problem and disables Store session draft. Correct the quantity and store a local draft.
4. Edit Operator note. Its Python change handler updates the neighboring note preview.
5. Press Reset through message. The native instance message invokes the label's Python receiver and resets only this form.
6. Open Try repeated stations, repeat the exercise in Row 1, and confirm Row 2 is independent. Return to the first screen to see fresh local defaults.
7. Open a second operator tab. Local form changes do not affect it. Export and re-import to preserve handler definitions and authored defaults, not live drafts.

For shared production records, replace the synthetic lookup with a named query and add a deliberately authorized transactional save. This portable example does not imply database persistence or multi-operator transaction handling.
