# Python UI actions

## Contract

A button's **Run Python script** action executes CPython on the gateway. Python input change/commit, mount/unmount, property-change and component-message handlers use the same scoped UI bridge; see [Python component events](PYTHON_COMPONENT_EVENTS.md) for their event data and saved-handler invocation contract. The gateway can return a validated batch of presentation, form-value and state changes to the calling browser; unmount is read-only because its component has retired. This lets an application author use Python for both a local heading change and a shared data update without executing Python in the browser.

The UI context belongs to the calling component's current screen, popup or concrete template/repeater instance. A message handler uses its receiving component's context. It is not a global component tree. A property assignment does not change the saved project, the publication or another operator's screen. Shared application data belongs in gateway tags or database records, with each interested screen binding to that data.

This increment uses a request snapshot and response effects. It does not maintain a continuously synchronized server-side copy of every browser component. Values supplied by the browser are untrusted presentation inputs, never identity, authorization or authoritative process data. Read authoritative data through `system.tag` or `system.db` inside the gateway action.

## Authoring

Select a button, choose **Edit actions & events → On click → Run Python script**, and edit its source alongside the component's lifecycle and message handlers. Apply records all action/event changes in one undo step; Cancel discards them. Save before testing a new component in Designer Live Preview. Publish to make the action available to operators.

**Check syntax** compiles Python on the gateway without executing it; JavaScript is parsed locally. Use Live Preview to check runtime behavior and component context.

To change the calling button's text:

```python
self.text = "hi"
```

`self.props.text = "hi"` is equivalent. Both read and write the same validated presentation property; writes are visible to subsequent reads in that invocation. Unknown properties and attempts to replace read-only navigation members report an error instead of creating an ineffective Python attribute.

An unbound heading with component ID `direct-title` can be updated in the same screen or template:

```python
self.getSibling("direct-title").text = inputs["title"]
result = {"message": "Updated this session's heading"}
```

Component navigation uses stable component IDs, not displayed captions. `self` is the calling component: the button for a click action, the source component for an input/property event, or the receiver for a message. `self.parent` is its containing screen or template root. `self.parent.getChild("direct-title")` resolves the same local component as `getSibling`. Navigation cannot escape to another template instance, repeater row, popup or browser session.

For a heading bound to declared state, update the state instead:

```python
system.ui.setState("screen", "title", inputs["title"])
```

Inside a template, this shorthand updates a declared private instance value:

```python
self.parent.custom.title = inputs["title"]
```

Outside a template, `self.parent.custom` refers to screen state. A popup has its own screen state. The explicit `session` scope means this application's browser tab, shared by its screens and popups; it does not mean every logged-in operator. Missing declarations and incorrect value types fail the action.

| API | Behavior |
| --- | --- |
| `self.id`, `self.name` | Calling component ID; the initial name is the ID |
| `self.text`, `self.props.text` | Equivalent read/write access to an allowed, unbound property on the calling component |
| `self.getSibling(componentId)` | Resolve a component in the same screen/template |
| `self.parent.getChild(componentId)` | Resolve a component under the current form root |
| `self.parent.custom.key` | Read/write declared screen or private instance state |
| `system.ui.getState(scope, key)` | Read the submitted typed state snapshot, including this invocation's writes |
| `system.ui.setState(scope, key, value)` | Stage a typed state change for `session`, `screen` or `instance` |
| `system.ui.getProperty(componentId, property)` | Read an authored unbound scalar or prior runtime override, including this invocation's writes |
| `system.ui.setProperty(componentId, property, value)` | Stage an allowed property change in the calling form |
| `self.value`, `self.props.value` | Read the captured non-password input value, or stage a validated edit to an unbound writable input |

Presentation property support is deliberately explicit: `text`, `enabled`, `visible`, `color`, `backgroundColor`, `foregroundColor`, `borderColor`, `borderWidth` and `fontSize`. Text is at most 4,096 characters. Flags require Boolean values; colors require a hex color; border width is 0–32 and font size is 1–256. Password components expose appearance and flags, but text/value are blocked. Template/repeater wrappers expose this same presentation subset within their containing form; their template IDs, row data and child forms remain inaccessible.

Template/repeater wrappers support Python lifecycle/property/message handlers in their containing form; `self.parent.custom` refers to that form's screen/template state. Ordinary child components retain private instance/row context. Password controls permit redacted lifecycle/property/message Python but not Python input change/commit. Explicit button submissions validate their form before execution and can carry deliberately submitted passwords through `inputs`; `self` never exposes password text/value. Automatic Python events receive bounded snapshots of incomplete form edits, including empty numeric text, so their scripts can implement validation; those snapshots omit password fields and are not validated submissions.

## Local input values

For non-password inputs, `self.value`, `self.props.value` and `system.ui.getProperty(componentId, "value")` read the invocation's captured input value. Reads may return `None` or incomplete numeric text from an automatic edit. Assignments validate the target's scalar type, numeric range, static choices and date format; text is limited to 4,096 characters. For example:

```python
self.getSibling("quantity").value = 12
self.getSibling("note").value = "Ready for inspection"
```

The change is staged as a dedicated input effect and applied atomically with the invocation's other UI effects. It does not synthesize change/commit events, submit another action or alter saved defaults. Subsequent `self.value` reads see staged writes; `inputs` remains the original snapshot. Targets must be in the same form. Password, non-input, read-only, tag-seeded, state-bound, query-choice/mapped or expression/query-bound values reject assignment; update their source explicitly. A newer edit to any targeted field invalidates the whole response, including edits away and back to the original value. Unrelated field edits are preserved. Forms in separate popups, template placements and repeater rows remain independent. Unmount input assignments are rejected along with all other retired UI changes.

Reading or writing a presentation property with an expression or query binding is rejected. Update its state, tag or query source instead. This prevents a Python assignment from silently detaching or hiding a live binding. Property reads do not promise computed CSS or browser DOM values. Non-password input `value` reads use the captured form value even when it has a binding; assignments still reject bound targets.

Generic gateway events and the script console have no calling UI context. The state/property helpers above report that the UI context is unavailable there; they do not guess a browser session or broadcast a local effect. The separate notification helpers `system.ui.sendMessage` and `system.ui.getSessionInfo` are available in the executing project's Python context even without a calling component. They address active same-project operator tabs and invoke session-scoped handlers, as described in [component messaging](COMPONENT_MESSAGING.md).

## Shared changes across operators

Create a configured String memory tag at `[default]Workshops/PythonUi/SharedTitle` in an isolated workshop gateway. Bind each shared heading's Text property to this tag. Then add a Python button that writes it:

```python
quality = system.tag.writeBlocking(
    ["[default]Workshops/PythonUi/SharedTitle"],
    [inputs["title"]],
)[0]
if not quality.isGood():
    raise RuntimeError(str(quality))
result = {"message": "Updated the shared heading"}
```

All authorized sessions observing the tag receive its new value through the existing tag stream, normally at the next one-second snapshot, with polling fallback. Configured memory-tag writes are persisted by the gateway. For equipment names, orders and other business records, use a named-query update and bind the display to the corresponding query; other sessions refresh according to that binding's polling configuration.

Avoid using a shared tag for personal form drafts, selections or popup visibility unless sharing those choices is intentional. Database actions that depend on the prior value should use a transaction or version check; local UI effects do not provide database concurrency control.

## Execution, ownership and failure

1. The browser captures typed state, current form values and existing property overrides for the calling form at click time.
2. Runtime resolves the button, source code, declarations and target components from one published project snapshot. Operate permission, operator audience, CSRF and publication checks remain in force.
3. CPython runs on the gateway. Every UI helper call is validated against that captured project context. Valid writes are staged and visible to later reads within the invocation.
4. Only a successful action returns the staged `uiEffects`. The browser validates the complete batch before applying any change.
5. The response must still belong to the same live application, screen, popup and template instance. Target values changed by a newer local operation cause a conflict instead of being overwritten. A disposed or replaced context cannot be revived by a late response.

Designer Live Preview uses the existing administrator-only script endpoint with a saved-draft component identity. The gateway resolves that identity against its saved project and validates the same UI contract. Both saved screens and standalone templates can be previewed; a standalone template has private instance state and no containing screen declarations. Save structural changes before testing. Read-only Preview does not execute the Python action. Preview effects belong only to that Preview run.

The steps above describe button requests. Automatic Python events send a handler selector and event snapshot through their runtime or Preview event endpoints; they never submit executable Python from the browser. The gateway resolves the saved handler and its context, while retaining the same atomic effects, permission, publication and lifetime checks. Unmounted is a bounded exception to live ownership: it reads the captured departing form, and property/form-value/state assignments fail at the gateway rather than modifying retired UI. Cleanup retains authorization and revision checks and is best effort on navigation, tab close or connection loss. Their bounded queues and execution limits are described in [Python component events](PYTHON_COMPONENT_EVENTS.md).

Failed scripts, invalid UI operations and timeouts discard staged UI effects. Tag writes and database updates retain their existing immediate behavior and are not rolled back by a later Python failure or a discarded browser response. Consequently an action must not treat a local UI acknowledgement as evidence that a business transaction was committed or reversed.

UI state and overrides reset with their owning scope. Screen properties reset on navigation; popup properties reset on close/reopen; template and repeater state belongs to each concrete placement. Session state lasts through navigation in the current tab. Reload, changed user or replaced publication creates a new application lifetime.

## Wire format and limits

Existing Python button requests optionally include `ui`:

```json
{
  "state": {"session": {}, "screen": {"title": "My heading"}},
  "properties": {"direct-title": {"text": "Previous local override"}}
}
```

`instance` is present in state only for a template context. Property entries contain previous local overrides, not client-defined component schemas. Unknown fields, undeclared keys, unknown targets, invalid scalar values and inappropriate scopes are rejected. The UTF-8 snapshot limit is 256 KiB.

Successful responses can include up to 128 changed targets, bounded to 64 KiB. Repeated assignments to a target are coalesced to its final value; subsequent Python reads observe the latest staged value:

```json
[
  {"kind": "state", "scope": "screen", "key": "title", "value": "Ready"},
  {"kind": "property", "componentId": "direct-title", "property": "text", "value": "Ready"},
  {"kind": "input", "componentId": "note", "value": "Prepared by Python"}
]
```

The gateway generates these validated effects separately from the script's `result`. An arbitrary returned object cannot create UI effects. This response applies only to its originating form. Cross-session notifications use the explicit `system.ui.sendMessage` API and saved component receivers; they do not broadcast arbitrary property assignments or returned UI effect batches.

Input values stay in the existing request `inputs` snapshot, not in `ui.properties`. An input effect names a captured component; the saved component definition supplies its field key, type and constraints. The browser rechecks its current definition and field revision before committing the batch.

## Workshop and acceptance

The independently authored [Python UI workshop](../../examples/python-ui.json) packages the local exercises with no gateway writes. It demonstrates direct heading properties, screen state, private template/repeater state and an optional shared-tag display. The shared-write exercise above requires deliberate gateway setup and is not executed by the portable package.

Import, explicitly publish, and open the operator link in two tabs. Change the first tab's heading and confirm the second is unchanged. Change one template/row and confirm its neighbors are unchanged. With the optional tag and writer configured, change the shared heading and confirm both tabs receive it. Close/reopen or navigate away/back to verify local reset behavior. Export and re-import to retain the authored scripts and defaults, not the live overrides.

Required checks cover CPython helper execution, published/draft identity resolution, malformed snapshots, scope and binding rejection, discarded failed effects, atomic browser application, late-response invalidation, conflicts, two-session shared tags and portable import/publication/re-export. The parity log records actual verification results for each build.
