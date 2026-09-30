# Component messaging

Component messages route a JSON object to mounted components in the current browser project run. A button can send a saved message and browser JavaScript can call `app.sendMessage`. Receivers use their own form, parameter and state context. Supported components may receive in JavaScript or Python; Python executes saved code on the gateway with Operate permission and validated UI effects. Password controls and template/repeater wrappers remain JavaScript-only. Routing remains local to the browser run regardless of receiver language. See [Python component events](PYTHON_COMPONENT_EVENTS.md).

## Send from a button

Select a Button, choose the **Send message** action, and set its message type, scope and JSON object payload. For a button-to-label example, use type `workshop.note`, scope `screen`, and payload `{ "text": "Hello", "from": "Button" }`. Its saved properties are:

```json
{
  "action": "message",
  "message": {
    "messageType": "workshop.note",
    "scope": "screen",
    "payload": { "text": "Hello", "from": "Button" }
  }
}
```

The payload is literal JSON. Use a browser event when it needs current input or state values. Native message actions are available only on Button components.

## Send from JavaScript

JavaScript input events, component lifecycle/message handlers and browser startup/screen-open scripts receive `app.sendMessage`. Python message-send helpers are not included. For example, a template input's JavaScript commit event can send its new value to another control in that same template instance:

```javascript
const receipt = app.sendMessage(
  "workshop.note",
  { text: event.value, from: parameters.station },
  { scope: "instance" }
);
app.notify("Queued for " + receipt.accepted + " handler(s).");
```

The call returns `{ messageId, accepted }` synchronously. `accepted` counts receiver handlers admitted to their execution queues; it does not report successful completion or a handler return value. Authored receiver code executes later, in its component's serial queue. No matching receivers produces zero accepted deliveries. Omitting the payload uses `{}`; omitting scope uses `screen`. Options accept only `scope`.

| Scope | Receivers |
| --- | --- |
| `instance` | Components in the sender's exact form instance. Each template placement and repeated row has its own identity. A nested template has a separate identity from its parent. Root-screen components share the root form. |
| `screen` | Components on the sender's screen, including its nested templates and repeated rows. An open popup has its own screen identity. |
| `session` | Mounted components in the current operator browser tab, including its current screen and open popup. Another tab, browser, user or project run has a separate bus. |

Subscriptions match both message type and scope exactly. A screen listener does not receive a session send merely because it is on the same screen. Message types are case-sensitive. Routing identities come from the active runtime; authors do not supply arbitrary component IDs or another browser's session ID.

## Receive in a component

Select the receiving component and choose **Edit message handlers**. Use **Add handler** to create a stable ID, then set the message type, scope and language. New supported handlers default to Python; existing JavaScript remains unchanged. The language selector keeps separate source drafts and applies only the selected language. Apply, save and publish. IDs are unique within the component. A component may listen for the same type at different scopes, but cannot repeat the same type-and-scope pair.

A Python receiver can change its unbound text directly:

```python
self.text = str(event.payload["text"])
```

Python requires Operate permission in the published application or administrator-enabled Live actions in Preview. Password controls and template/repeater wrappers cannot own Python handlers; their ordinary child components can. Mount/unmount remains JavaScript-only.

For a JavaScript receiver, declare a string state key such as screen `note`, bind the label's Text to that key, and use this body:

```javascript
app.state.set("screen", "note", String(event.payload.text));
```

For private template or repeater state, declare the key in the template's `instanceState`, bind Text to its Instance state reference, and use `app.state.set("instance", "note", ...)`. The handler controls its own declared state or form through the usual helpers. A message itself does not assign a target component's arbitrary properties.

The saved definition is `props.messageHandlers`, an array of objects containing exactly `id`, `messageType`, `scope`, `language` and `code`. `language` is `javascript` or `python`. Operator project responses retain the language and subscription metadata but omit Python source; the gateway resolves saved code by handler ID. Each handler receives:

| Value | Meaning |
| --- | --- |
| `event.type` | `message` |
| `event.messageType` | Exact sent type |
| `event.scope` | Exact sent scope |
| `event.messageId` | Delivery identifier shared by recipients of this send |
| `event.payload` | Detached JSON object for this receiver; recursively frozen in JavaScript and exposed with dictionary/attribute access in Python |
| `inputs`, `parameters` | Receiver form and parameter snapshots; automatic-event password restrictions apply |
| `app` | JavaScript receiver's state, local input, notification, cleanup and message helpers |
| `self`, `system.ui` | Python receiver's component and scoped presentation/state helpers |

Each recipient gets its own payload copy. Mutating a sender's object after sending cannot alter a queued delivery. Editing a local snapshot does not update the form.

## Bounds and lifecycle

Each component supports at most 16 handlers. Handler IDs contain 1–80 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore. Message types are trimmed text of 1–80 characters without control characters. Bodies are nonempty source text of at most 65,536 characters. Saving validates the definition shape; the editor additionally checks JavaScript syntax without execution. CPython checks Python syntax when the live event executes. Unknown fields, unsupported scopes/languages and misplaced definitions are rejected before saving or importing.

Payloads must be JSON objects with at most 64 KiB of serialized UTF-8 JSON, 4,096 nodes and 16 nested levels. The root is depth zero and counts as one node. Arrays, objects, primitive values and null each count; object keys do not. Numbers must be finite, and integer values must be exactly representable as safe JavaScript integers. The browser rejects cycles, non-JSON values, class instances, getters, sparse arrays and hidden or symbol properties before serialization.

One project run supports up to 4,096 registered handlers. Each component shares a 32-item serial queue for automatic lifecycle, property and message events. JavaScript has a two-second asynchronous deadline. Python has a two-second gateway execution limit and a three-second browser response guard including transport. A shared coordinator limits continuous property/message cascades to 128 events and event rate to 512 per second; message sends also have a 512-per-second limit. Queue rejection or a loop guard reduces accepted delivery counts and emits diagnostics. Reopen the screen or restart Preview after correcting a sender loop.

Unmounting a component, closing its popup, leaving the screen, switching Preview mode or replacing the project run retires its subscriptions. Stale helpers cannot send into a new run, and timed-out handlers cannot use helpers to write late results. There is no persistence, replay or delivery to a screen that is not mounted.

Designer Preview starts in **Live read-only** with authored JavaScript and message delivery blocked. Enable **Live actions** explicitly to exercise handlers there, or use the published operator application. Mounted hidden or disabled components still receive messages; disabling user interaction does not disable an automatic listener. Browser code is authored by trusted project designers and runs with the page's privileges; helper limits do not make arbitrary JavaScript a security sandbox or preempt synchronous infinite loops.

Python receiver invocations share the component's bounded Python queue and retain gateway permission, deadline and concurrency checks. Failed, expired or conflicting UI responses do not apply partial effects. Gateway tag/database writes are immediate and cannot be rolled back by discarding a UI response. Browser and Python scripts are trusted authored code, not sandboxes.

The `app.sendMessage` API routes inside the browser. It may invoke a saved Python component receiver through the gateway, but does not invoke gateway message resources, deliver across browser tabs or gateways, or target remote servers. Gateway-to-operator push is outside this feature. See [gateway events](GATEWAY_EVENTS.md) for Python gateway message request handlers.

## Workshop

The [Python component events workshop](../../examples/python-component-events.json) adds a native message button invoking a Python receiver alongside input and property-change handlers. It requires CPython and the companion gateway build. The original workshop below retains its JavaScript definitions and does not require Python.

The independently authored [component messaging workshop](../../examples/component-messaging.json) is portable and requires no Python runtime, tags, devices, external databases or internet connection. Use the companion build with component messaging support; an earlier build supporting only gateway messages is insufficient. Import its `.sparkproj`, review it, and explicitly publish the project. Imported definitions remain unpublished until then.

1. Open the operator application. Station A, Station B, Row 1 and Row 2 start with separate Instance, Screen and Session receiver lines.
2. Press **Send instance** in Station A, then edit its Message text and commit it. Only that station's Instance line changes. Repeat in Row 1 and verify Row 2 remains unchanged.
3. Toggle **Send screen** in any station, or use **Send screen from button**. The main receiver and all four Screen lines change; Instance and Session lines retain their previous values.
4. Open the popup. **Send popup screen** or a committed popup input changes only its Screen line. **Send session from popup** reaches every Session line in the main screen and popup.
5. Open the application in a second browser tab and verify it receives nothing from the first tab. Session means the current tab's runtime.
6. Close the popup, choose **Leave and test cleanup**, and toggle **Send session with no receivers**. The receipt reports `Accepted 0 handler(s).` Return to fresh stations: their initial values show that messages are not replayed.
7. Inspect the sender actions, input events and receiver handlers in Designer. Receiver labels update declared state, with separate state for each template row and for the popup. Save, export and re-import; these definitions remain editable and the imported project remains unpublished.

The offline Gateway.Tests harness checks server validation, rejected-save atomicity and save/publish/export/import preservation. Browser message model and lifecycle tests cover routing, payload isolation, queue admission and cleanup. The release workshop check additionally imports the generated package into a disposable authenticated gateway, explicitly publishes it and re-exports it. Generated packages and verification artifacts belong under ignored local artifact directories.
