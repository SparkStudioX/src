# Component property and lifecycle events

Select a component and open **Component events → Edit lifecycle & property events** in its property sheet. Mounted and Unmounted use JavaScript; Property changed can use JavaScript or Python on supported components. Password controls and template/repeater wrappers remain JavaScript-only. Apply records one undo step; Cancel discards the draft. Save and publish to deploy definitions. Authoring and default read-only Preview execute no authored scripts. Administrator-enabled [Live actions Preview](PREVIEW_COMMUNICATION.md) can exercise saved Python handlers; save changes before testing them. See [Python component events](PYTHON_COMPONENT_EVENTS.md).

These handlers add automatic behavior to component instances and are separate from explicit user input change/commit events. The JavaScript contract below provides browser state/form helpers. Python property handlers execute saved code on the gateway with scoped `self`/`system.ui`, require Operate authority in the operator application and retain their separate transport/deadline rules. Both languages are trusted author code, not a security sandbox.

New supported property-change handlers default to Python; existing JavaScript remains unchanged. Each language has a separate source draft; switching languages does not translate code. Ordinary child components inside templates and repeated rows can use Python even though the wrapper itself cannot.

## Saved definition

```json
{
  "props": {
    "componentEvents": {
      "mount": {
        "language": "javascript",
        "code": "app.state.set('screen', 'ready', true);"
      },
      "propertyChange": {
        "language": "javascript",
        "properties": ["value", "enabled"],
        "code": "if (event.available) app.notify(event.property + ': ' + event.value);"
      },
      "unmount": {
        "language": "javascript",
        "code": "console.info('Component closed:', event.componentId);"
      }
    }
  }
}
```

Each configured handler requires nonblank code of at most 65,536 UTF-16 code units. Mount/unmount require JavaScript; propertyChange also accepts Python where the component supports it. The gateway rejects unknown fields, languages, unsupported watch targets and misplaced definitions. Property-change handlers observe 1–16 unique properties in authored order. An empty events object is valid. Only saved definitions enter projects, publications and `.sparkproj` packages; execution queues, operator values and diagnostics do not.

Python source is omitted from operator project responses and resolved from saved handler identity when invoked. To use Python for a property handler, select Python and author:

```python
if event.available:
    self.getSibling("event-log").text = event.property + ": " + str(event.value)
```

The receiving form must contain an unbound component with ID `event-log`. For a bound target, update its declared state or data source instead. CPython checks syntax when a live event executes; the editor checks JavaScript syntax without execution.

## What changes are observed

The watch list offers the component's supported scalar property-binding targets. Non-password inputs additionally expose their actual `value`. Geometry uses authored or evaluated component values, not browser pixel measurements. Text and unit parameter substitutions are resolved. Enabled and visible default to true. Other omitted properties remain unavailable even if a renderer uses a convenience default; tag-derived display values require an explicit property binding to be observed.

The first committed snapshot establishes a silent baseline. Mounted runs before property-change work for that component. Later differences in value, availability or diagnostic produce an event; equal snapshots are suppressed. Programmatic assignments may produce property-change events, but never synthesize explicit user input change/commit events.

All payloads contain `type` and `componentId`. Property-change payloads also contain `property`, `value`, `previousValue`, `available`, `previousAvailable`, `error`, `previousError` and `origin`. Origin describes the source as `input`, `binding`, `script` or `configuration`; it is diagnostic presentation context, not trusted identity. An unavailable value is `null` (`None` in Python) with false availability; display fallbacks are not reported as successful values. Check availability and scalar types before doing calculations; numeric input drafts may temporarily contain empty or invalid text.

Hidden and disabled components remain mounted and keep observing changes. Automatic JavaScript events also run for read-only operators; this does not enable interactive inputs or authorize server actions. Python events require Operate permission and the gateway checks their saved identity and context. A wrapper's events use its containing form. Components inside a template use that template's own parameters, inputs and private state. Stable repeater identities preserve their lifetime through reordering.

## JavaScript helpers and snapshots

- `inputs` and `parameters` are frozen snapshots captured when the event is queued. Password inputs are omitted.
- `app.setInput(field, value)` validates and assigns a non-password input in the current form without producing user input events.
- `app.state.get/set/reset(scope, key, value)` uses declared session, screen or private instance state. The `value` argument applies to `set` only.
- `app.notify(message)` records a local informational message. Preview displays information and errors; the operator application displays event errors.
- `app.signal` is aborted when the context closes, an invocation times out, or the automatic-event breaker stops the context.
- `app.onCleanup(callback)` registers up to 16 callbacks for releasing timers and listeners.

Successful handlers may retain their local helper closures until their context closes. For example, a Mounted handler can create an interval and register its disposal:

```javascript
const timer = setInterval(() => {
  if (!app.signal.aborted) {
    app.state.set('instance', 'ticks', app.state.get('instance', 'ticks') + 1);
  }
}, 1000);
app.onCleanup(() => clearInterval(timer));
```

Declare the numeric `ticks` key first. Awaited work should pass `app.signal` to abortable APIs and release resources explicitly. Revocation protects the supplied local helpers; it does not stop arbitrary JavaScript or undo external side effects authored through browser APIs.

## Disposal and execution limits

Python uses the same UI ownership and conflict rules as [Python UI actions](PYTHON_UI.md). Input events and automatic property/message events retain separate 32-item waiting queues; dispatched Python calls share another bounded component FIFO. This is not a single aggregate 32-event cap. Gateway execution has a two-second limit and the browser allows three seconds for the response including transport. Exceptions, timeouts, canceled contexts and conflicting newer edits apply no staged UI changes. Gateway tag/database writes remain immediate and cannot be rolled back by discarding the UI response. Local effects do not broadcast across operator tabs.

Changing the effective component/form context, removing an instance, navigating, closing a popup, replacing a publication or restarting Preview disposes the old context. Pending work is canceled and old helpers lose write authority before Unmounted and registered cleanup callbacks run. Cleanup reads a captured state snapshot; state writes, input assignments and notifications do nothing. Its signal is already aborted. Cleanup errors remain visible in the owning application after the leaf component disappears.

Handlers run serially per component, with at most 32 pending/running events. Each asynchronous JavaScript invocation has a 2-second deadline; a timed-out invocation loses its helpers even if its promise later resolves. Cleanup has a shared 1-second deadline. Execution is scheduled outside React's effect stack. Synchronous infinite loops cannot be interrupted by these limits.

A shared application-run breaker stops automatic mount/property work at 512 invocations in a rolling second or after 128 property changes without a quiet break. A quiet break requires 50 milliseconds with no queued or running automatic handlers, including awaited work. This also catches slow asynchronous feedback loops. Instance or popup churn does not reset the breaker. Main-screen navigation, a new application/publication run or Preview restart resets it. Cleanup still runs when the breaker is open. Ordinary diagnostics retain the latest 20 messages; dismissing one does not reset a latched breaker.

## Workshop and remaining work

The independently authored [component-event workshop](../../examples/component-events.json) demonstrates independent template counters, programmatic versus user changes, hidden-instance lifetime and popup cleanup. Its separate diagnostics screen deliberately exercises timeout and feedback-loop errors using browser state only. It has no database, tag or equipment dependencies. Load it with the authenticated example loader or import the local `artifacts/sparkproj/component-events.sparkproj` (when present after consolidation; fresh versioned builds use `artifacts/workshops/<version>/projects/`).

The [Python component events workshop](../../examples/python-component-events.json) demonstrates Python input, property and message handlers with independent template and repeater state. It requires CPython but no database or device.

This is the property-change and lifecycle portion of D03. Focus, keyboard and pointer events, a unified action editor, Python mount/unmount and broader property dependency graphs remain separate roadmap work. Python input, property-change and message handlers can now use gateway tags and named queries while retaining published-definition and permission checks.
