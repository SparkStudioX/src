# Component messaging

Component messages route a JSON object to mounted components. A native message button and browser JavaScript `app.sendMessage` route within the current browser project run. Gateway Python `system.ui.sendMessage` can instead send to active operator tabs for the same project, or one selected tab. Both routes invoke the same saved component receivers in their own form, parameter and state context. Components, including template/repeater wrappers, may receive in JavaScript or Python; Python executes saved code on the gateway with Operate permission and validated UI effects. Password-control message handlers can change appearance or flags but cannot read or write password text/value; their automatic input snapshot excludes secrets. See [Python component events](PYTHON_COMPONENT_EVENTS.md).

## Send from a button

Select a Button, choose **Edit actions & events → On click**, select the **Send message** action, and set its message type, scope and JSON object payload. For a button-to-label example, use type `workshop.note`, scope `screen`, and payload `{ "text": "Hello", "from": "Button" }`. Its saved properties are:

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

JavaScript input events, component lifecycle/message handlers and browser startup/screen-open scripts receive `app.sendMessage`. This local helper does not contact other browser tabs. For example, a template input's JavaScript commit event can send its new value to another control in that same template instance:

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

Select the receiving component and choose **Edit actions & events → Messages**. Use **Add handler** to create a stable ID, then set the message type, scope and language. New supported handlers default to Python; existing JavaScript remains unchanged. The language selector keeps separate source drafts and applies only the selected language. Apply the complete action/event draft, save and publish. IDs are unique within the component. A component may listen for the same type at different scopes, but cannot repeat the same type-and-scope pair.

A Python receiver can change its unbound text directly:

```python
self.text = str(event.payload["text"])
```

Python requires Operate permission in the published application or administrator-enabled Live actions in Preview. Wrappers use their containing form; ordinary child components use their template instance or repeater row. Password-control receivers retain redacted text/value access. Mount/unmount also support Python, subject to their separate lifecycle and teardown rules.

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

Each component supports at most 16 handlers. Handler IDs contain 1–80 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore. Message types are trimmed text of 1–80 characters without control characters. Bodies are nonempty source text of at most 65,536 characters. Saving validates the definition shape. **Check syntax** in the shared source editor parses JavaScript locally or asks CPython to compile Python without executing it; failures show diagnostics and positions. Syntax validation is not proof of successful execution. Unknown fields, unsupported scopes/languages and misplaced definitions are rejected before saving or importing.

Payloads must be JSON objects with at most 64 KiB of serialized UTF-8 JSON, 4,096 nodes and 16 nested levels. The root is depth zero and counts as one node. Arrays, objects, primitive values and null each count; object keys do not. Numbers must be finite, and integer values must be exactly representable as safe JavaScript integers. The browser rejects cycles, non-JSON values, class instances, getters, sparse arrays and hidden or symbol properties before serialization.

One project run supports up to 4,096 registered handlers. Each component shares a 32-item serial queue for automatic lifecycle, property and message events. JavaScript has a two-second asynchronous deadline. Python has a combined two-second gateway queue-and-execution limit and a three-second browser response guard including transport; gateway admission is bounded separately as described in [Python component events](PYTHON_COMPONENT_EVENTS.md). A shared coordinator limits continuous property/message cascades to 128 events and event rate to 512 per second; message sends also have a 512-per-second limit. Queue rejection or a loop guard reduces accepted delivery counts and emits diagnostics. Reopen the screen or restart Preview after correcting a sender loop.

Unmounting a component, closing its popup, leaving the screen, switching Preview mode or replacing the project run retires its subscriptions. Stale helpers cannot send into a new run, and timed-out handlers cannot use helpers to write late results. There is no persistence, replay or delivery to a screen that is not mounted.

Designer Preview starts in **Live read-only** with authored JavaScript and message delivery blocked. Enable **Live actions** explicitly to exercise handlers there, or use the published operator application. Mounted hidden or disabled components still receive messages; disabling user interaction does not disable an automatic listener. Browser code is authored by trusted project designers and runs with the page's privileges; helper limits do not make arbitrary JavaScript a security sandbox or preempt synchronous infinite loops.

Python receiver invocations share the component's bounded Python queue and retain gateway permission, deadline and concurrency checks. Failed, expired or conflicting UI responses do not apply partial effects. Gateway tag/database writes are immediate and cannot be rolled back by discarding a UI response. Browser and Python scripts are trusted authored code, not sandboxes.

The `app.sendMessage` API routes inside the browser. It may invoke a saved Python component receiver through the gateway, but does not invoke gateway message resources or deliver across tabs. For gateway-to-operator sends use the Python API below. See [gateway events](GATEWAY_EVENTS.md) for the separate `system.util.sendMessage`/`sendRequest` API that invokes gateway message resources.

## Send from gateway Python to operator tabs

Project gateway events, published Python button/component handlers, libraries called by those handlers, and authorized Python console/Live Preview executions can use:

```python
# Every currently connected operator tab of this project.
receipt = system.ui.sendMessage("orders.changed", {"orderId": "WO-104", "text": "Order updated"})
print(receipt["status"], receipt["queued"], receipt["dropped"])

# Inventory contains only active operator tabs of this project.
sessions = system.ui.getSessionInfo()
for session in sessions:
    print(session["sessionId"], session["username"], session["publishedAt"])

# Send to one server-issued tab identity from that inventory.
if sessions:
    receipt = system.ui.sendMessage("orders.changed", {"text": "Selected station"}, sessionId=sessions[0]["sessionId"])
```

`sendMessage(messageType, payload=None, sessionId=None)` defaults the payload to `{}` and recipients to every active same-project operator tab. `getSessionInfo()` returns a list containing `sessionId`, `projectId`, `publishedAt` and `username`. No project override is accepted: the running script's project supplies routing authority. Tabs of another project are not listed and cannot receive, even if their ID is known. Designer Preview can send deliberately through Live actions, but it does not register itself as an operator recipient.

Gateway messages always enter each recipient's local bus with scope **session**. Configure the receiving component's handler with that exact type and scope. Current main-screen, template-row and popup receivers participate; unmounted screens do not. The gateway does not execute or return a receiver's result synchronously. Each recipient still uses its own state, current form and permissions. A viewer can run permitted local JavaScript receivers, but receipt of a message never grants Operate permission to execute a Python receiver.

The returned receipt has `messageId`, `eligible`, `queued`, `dropped` and `status`. Status is `queued`, `queueFull` or `noRecipients`. `queued` means admitted to an in-memory tab mailbox, not delivered, executed or committed. A disconnected target returns `noRecipients`; a full queue reports dropped recipients. Messages are best effort: no durable queue, acknowledgement of browser execution, replay, retry or exactly-once guarantee is supplied. A message already sent is an immediate gateway side effect; a later script error or discarded UI response does not retract it. Use authoritative tags/database records for application state and use messages as notifications to refresh or display that state.

### Session transport and boundaries

The runtime registers with `POST /api/projects/{projectId}/runtime/sessions` and the current `publishedAt`. The server issues a fresh random tab ID bound to that project, publication, account and authenticated operator login. This is distinct from the authentication cookie and from browser-local state. The runtime opens authenticated SSE at `/runtime/sessions/{sessionId}/messages`; it multiplexes `ready`, `tags` and `message` events on one connection. Cleanup uses `DELETE /runtime/sessions/{sessionId}`. Registration and deletion require the usual operator View permission and CSRF token. Reads require the same authenticated owner, project and live permission. There is no anonymous or browser-authored broadcast endpoint.

Disconnect closes the mailbox and discards queued work. Reconnect registers a new ID; IDs must not be saved as durable station identifiers. Revoked login, account/permission changes, project archive or publication replacement retire the old connection. Browser identity and publication guards discard late stream events after navigation or replacement. A same-project screen change leaves the tab connection active and routes subsequent messages to the new mounted listeners. Changing projects or reloading replaces the connection.

Payload shape, type and 64 KiB/4,096-value/16-level limits match local messages. Each tab mailbox holds at most 32 messages, with 512 pending gateway-wide. Sends are limited to 128 per project per second and 512 per gateway per second; exceeding a send limit raises a Python error. A queued message expires after five seconds. Pending or stalled connections expire after 30 seconds without stream progress. Registration is bounded to 32 tabs per operator login, 256 per project and 1,024 gateway-wide. These bounds prevent unbounded backlog; they are not a recommended production sizing claim.

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
