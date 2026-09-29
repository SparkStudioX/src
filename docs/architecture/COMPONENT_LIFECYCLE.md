# Component property and lifecycle events

Select a component and open **Component events → Edit lifecycle & property events** in its property sheet. The editor stages three JavaScript handlers: **Mounted**, **Property changed**, and **Unmounted**. Apply records one Designer undo step; Cancel discards the draft. Save and publish to deploy the definitions to operators. Designer authoring and default read-only Preview do not execute these scripts. An administrator must explicitly enable [live-actions Preview](PREVIEW_COMMUNICATION.md) to exercise them there; the published operator application retains its normal event behavior.

These handlers add automatic local behavior to all component types, including template and repeater wrappers. They are separate from explicit user input change/commit events and gateway Python button actions. The application supplies browser state and form helpers, not gateway query or equipment command helpers. Author scripts remain trusted JavaScript and are not a security sandbox.

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

Each configured handler requires nonblank JavaScript of at most 65,536 UTF-16 code units. The gateway rejects unknown fields, languages, unsupported watch targets and misplaced definitions. Property-change handlers observe 1–16 unique properties in authored order. An empty events object is valid. Only saved definitions enter projects, publications and `.sparkproj` packages; execution queues, operator values and diagnostics do not.

## What changes are observed

The watch list offers the component's supported scalar property-binding targets. Non-password inputs additionally expose their actual `value`. Geometry uses authored or evaluated component values, not browser pixel measurements. Text and unit parameter substitutions are resolved. Enabled and visible default to true. Other omitted properties remain unavailable even if a renderer uses a convenience default; tag-derived display values require an explicit property binding to be observed.

The first committed snapshot establishes a silent baseline. Mounted runs before property-change work for that component. Later differences in value, availability or diagnostic produce an event; equal snapshots are suppressed. Programmatic assignments may produce property-change events, but never synthesize explicit user input change/commit events.

All payloads contain `type` and `componentId`. Property-change payloads also contain `property`, `value`, `previousValue`, `available`, `previousAvailable`, `error` and `previousError`. An unavailable value is `null` with `available: false`; display fallbacks are not reported as successful values. Check availability before doing calculations.

Hidden and disabled components remain mounted and keep observing changes. Automatic local events also run for read-only operators; this does not enable interactive inputs or authorize server actions. A wrapper's events use its containing form. Components inside a template use that template's own parameters, inputs and private state. Stable repeater identities preserve their lifetime through reordering.

## Helpers and snapshots

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

Changing the effective component/form context, removing an instance, navigating, closing a popup, replacing a publication or restarting Preview disposes the old context. Pending work is canceled and old helpers lose write authority before Unmounted and registered cleanup callbacks run. Cleanup reads a captured state snapshot; state writes, input assignments and notifications do nothing. Its signal is already aborted. Cleanup errors remain visible in the owning application after the leaf component disappears.

Handlers run serially per component, with at most 32 pending/running events. Each asynchronous invocation has a 2-second deadline; a timed-out invocation loses its helpers even if its promise later resolves. Cleanup has a shared 1-second deadline. Execution is scheduled outside React's effect stack. Synchronous infinite loops cannot be interrupted by these limits.

A shared application-run breaker stops automatic mount/property work at 512 invocations in a rolling second or after 128 property changes without a quiet break. A quiet break requires 50 milliseconds with no queued or running automatic handlers, including awaited work. This also catches slow asynchronous feedback loops. Instance or popup churn does not reset the breaker. Main-screen navigation, a new application/publication run or Preview restart resets it. Cleanup still runs when the breaker is open. Ordinary diagnostics retain the latest 20 messages; dismissing one does not reset a latched breaker.

## Workshop and remaining work

The independently authored [component-event workshop](../../examples/component-events.json) demonstrates independent template counters, programmatic versus user changes, hidden-instance lifetime and popup cleanup. Its separate diagnostics screen deliberately exercises timeout and feedback-loop errors using browser state only. It has no database, tag or equipment dependencies. Load it with the authenticated example loader or import the generated local-only `artifacts/examples/component-events.sparkproj`.

This is the property-change and lifecycle portion of D03. Focus, keyboard and pointer events, a unified action editor, automatic server/query actions and broader property dependency graphs remain separate roadmap work. Existing gateway actions keep their published-definition and permission checks.
