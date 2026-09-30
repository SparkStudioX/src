# Component interaction events

Components can save `focus`, `blur`, `keyDown`, `keyUp`, `doubleClick`, `pointerDown` and `pointerUp` handlers alongside mount, unmount and property-change handlers in `props.componentEvents`. Each definition has `language` (`javascript` or `python`) and nonempty `code` of at most 65,536 characters. The common **Actions & Events** dialog stages every handler and applies the complete draft as one undo step. Clearing a handler removes it. Save and review publication before operators use a change.

## Interaction contract

The browser observes native events at the component boundary. It does not cancel editing, browser shortcuts, focus, gestures, click actions or native pointer capture. A double-click handler supplements any normal clicks. Pointer up runs only when the release is delivered to the component; moving outside it does not introduce new pointer capture. Focus and blur represent entering or leaving the component, so moving between controls inside a table or spinner does not produce duplicate focus events. An interaction belongs to its nearest authored component; template and container wrappers do not also receive a child's event.

Handlers receive detached, frozen JavaScript snapshots or typed Python event objects:

| Event | Additional fields |
| --- | --- |
| All | `type`, `componentId`, `origin` (`user`) |
| Focus / blur | No DOM target, related target or input value |
| Key down / up | `key` (128 characters), `code` (64), `repeat`, `isComposing`, `redacted`, `altKey`, `ctrlKey`, `metaKey`, `shiftKey` |
| Double click | `button`, `buttons`, `clientX`, `clientY`, modifier flags |
| Pointer down / up | Double-click fields plus `pointerType` (mouse, pen, touch or empty) and integer `pointerId` |

Coordinates are CSS viewport pixels bounded to ±10,000,000. Button values range from -1 to 5; the pressed-button bitmask ranges from 0 to 63. Events contain no native methods such as `preventDefault`, no DOM objects, and no executable source from the request. These are untrusted presentation inputs, never proof of user identity or device state.

Password keyboard handlers receive empty `key` and `code` with `redacted=true` in both languages. All interaction form snapshots omit password fields. Python component proxies also exclude password text and values. JavaScript remains trusted browser code; the event API is not a browser sandbox.

## Lifetime and permission

Disabled, hidden, read-only and inactive container controls suppress interactions. Authored static displays gain a tab stop only if they have focus or keyboard handlers; native inputs and buttons keep their existing tab stops. Availability is a browser presentation rule. Gateway authorization remains the authenticated project Operate grant, saved handler identity, publication stamp and Preview capability; a UI flag is not an authorization boundary.

Interactions join the component's existing serial queue, with at most 32 pending events, a shared 512-events/second circuit breaker, a two-second JavaScript helper deadline and the existing Python gateway budget. The Python gateway uses four workers and 32 waiting requests per project, 16 workers and 128 waiting requests gateway-wide, plus rate limits. Browser Python responses have a three-second transport budget. Overflows and errors appear in event diagnostics. Native editing continues when a handler is skipped.

Changing scope, publication, permission or interaction availability revokes running helpers and discards queued work for the retired context. Inactive retained panes preserve form and private state while their event owners suspend: messages unsubscribe, pending authority is cancelled, property baselines advance silently, and resuming does not replay changes or rerun an already completed mount. A pane first activated later runs its first mount then. Authored unmount does not run for an inactive pane; registered JavaScript disposal callbacks still run on actual removal to release resources. Aborted signals revoke helpers; trusted JavaScript must still release timers and external listeners responsibly.

Python resolves the saved published handler on the gateway. Live Preview requires administrator-enabled live actions and uses the saved draft. Read-only Preview runs neither JavaScript nor Python event code. Python UI effects apply atomically to the receiving browser context; failures and stale responses cannot replace newer local edits. Instance and popup events retain their own form, parameters and private state. Gateway writes made by trusted Python are shared operations and are not rolled back with local UI effects.

## Portable workshop

`examples/component-interactions.json` is independently authored and needs no tags, connection, database or external service. Import its generated `.sparkproj`, inspect the handlers in Actions & Events, save, review and explicitly publish. The bundled Python runtime and runtime Operate permission are required for the Python demonstrations.

1. Focus **Station note**, type a short note and use arrow keys or Tab. Focus and key status change while native editing works.
2. Type a few slow characters in **Disposable password sample**. Its Python counter increments; no key or password value appears in event context or diagnostics. Rapid key releases remain subject to queue and stale-response protection.
3. Press and release the purple pad. Double click it and verify the Python count increases. Disable the pad, then hide it; neither state should dispatch pad handlers.
4. Type separately in station A and B. Their displayed last keys remain private. Clicking a child input does not trigger the station A wrapper's background handler; clicking its padding does.
5. Open a second operator tab. Counters and form drafts are independent. Re-export and import the workshop into another project; the complete authored handlers transfer but remain unpublished until reviewed there.

Validation covers the seven gateway schemas, real CPython execution, strict payload limits and password rejection, complete package roundtrip, browser FIFO/lifetime rules, native-boundary ownership, inactive-pane suspension, and staged authoring. This workshop contains no physical-device writes.
