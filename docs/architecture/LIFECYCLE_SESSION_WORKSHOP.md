# Lifecycle and session messaging workshop

This independently authored, offline example combines Python component lifecycle events, a shared Actions & Events editor and gateway-to-operator messaging. It changes only transient UI values. It creates no device connections, database records or gateway tags.

## Open and publish

Use the companion SparkStudio **0.2.0-preview.9** release or a newer compatible gateway containing Python mount/unmount and `system.ui.sendMessage`/`getSessionInfo`. The bundled Python runtime must be available. Import `lifecycle-session-messaging.sparkproj` from the downloaded workshop ZIP's `projects/` folder, or the local maintained `artifacts/sparkproj/` folder, then explicitly publish the project. Sign into its operator application with Operate permission in two tabs. View-only accounts can see the screens but cannot execute their Python handlers or buttons.

Each receiver should say **Mounted receiver A** or **Mounted receiver B**. Mount runs before that component's later automatic events. Python executes at the gateway against the saved component definition; its returned UI effects apply only to the originating component instance.

## Try the workflows

1. Enter a message and choose **Broadcast to this project's operator tabs**. Both receiver cards in both tabs show it. The sender reports how many tab queues accepted the message, not how many handlers completed.
2. Choose **Identify open tabs**. Each tab displays its own server-issued identity. Copy one into **Target session ID**, change the message and choose **Send to the target tab only**. Only that tab changes. Reloading or reconnecting creates a new identity; identify tabs again. IDs are not login credentials and cannot grant access.
3. Choose **Rename this button with self.text**, then **Leave this screen**. Unmounted handlers record captured receiver text in component event diagnostics. Send from the other tab while this tab is away, then return: fresh mount text appears, with no replay of a message sent while the handler was absent.
4. Choose **Populate the message field with Python**. Message text becomes **Prepared by Python** in this tab. Broadcasting reads that new value. This uses `self.getSibling("note").value`; `self.text` changes the caption, while `self.value` changes a writable, unbound input. Programmatic assignments do not recursively fire another input event.

In Designer select the rename button and choose **Edit actions & events**. On click, input events where supported, Mounted, Property changed, Unmounted and Messages share one dialog. All settings remain a draft until **Apply actions & events**; Cancel discards them, and one Undo reverses an Apply. Select the receiver within the **Python lifecycle receiver** template to inspect its mount, cleanup and session-message scripts.

## Check source without running it

Every shared script editor includes **Check syntax**. In the rename button's Python editor, temporarily enter `if True` and check it: the error identifies the line and column. Enter `self.text = "Syntax check only"` and check again: valid syntax does not rename the component, run a gateway action or save the edit. Cancel to retain the original source. Python checking uses the gateway's CPython compiler; JavaScript checking uses the browser's parser. Both compile without executing authored statements. Syntax checking cannot confirm that a tag exists, a query succeeds or an API is available in a particular runtime context.

The same compiler check and Python system-API completions are available in Scripting and the table commit editor. Context help distinguishes component `self`/`event` from gateway resources and row-oriented table commits, so a completion does not imply a calling component where none exists.

## Send from a gateway event

The imported script **Workshop broadcast** is disabled. Review it in Scripting, enable it deliberately, save and publish scripts. Use **Test published handler** with `{"text":"Gateway event broadcast"}` while the operator tabs are open. Both tabs receive the notification without a browser button initiating the send. Disable and republish the script after the exercise. Project publication and script publication are separate operations.

```python
# Available in gateway events, Python buttons and component handlers.
receipt = system.ui.sendMessage("workshop.notice", {"text": "Shift ready"})
sessions = system.ui.getSessionInfo()  # active tabs of this project only
if sessions:
    system.ui.sendMessage("workshop.notice", {"text": "Targeted"},
                          sessionId=sessions[0]["sessionId"])
```

Receiving handlers select **Session** scope and read `event.payload`. `app.sendMessage` remains the browser-local JavaScript API; it does not broadcast to other tabs. The new Python API always addresses operator tabs of the executing project and does not send to Designer Preview.

## Boundaries

Unmount receives read-only `self`, properties and state captured from the departing component. It can perform trusted gateway-side cleanup, but cannot update a closed UI. Closing the browser, losing connectivity or retiring a dynamic query row can prevent cleanup; use gateway-managed expiry or events for required durable work. Auth, publication and permission checks continue to apply.

Session messaging is transient and bounded. Disconnected tabs lose pending messages, reconnect with fresh identities and do not replay old work. Queued messages expire after five seconds; per-tab queues, project rate limits and component cascade guards prevent unbounded fan-out. Use tag/database bindings when other clients need durable, shared application state.
