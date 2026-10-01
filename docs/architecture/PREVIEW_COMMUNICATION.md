# Preview communication

Designer Preview starts in **Live read-only** mode. The browser can read live tags and saved named-query definitions, edit native local form values, evaluate pure property bindings and navigate among unsaved screen layouts. The gateway rejects Python execution, named updates, table commits and other mutations from this preview. Authored input and component browser events are blocked at their execution boundary because JavaScript has the page's privileges and could otherwise initiate network writes. The system does not attempt to classify code as safe: even a script that only appears to read data is blocked.

The **Live actions** toggle is in the Designer footer, alongside screen dimensions, locale selection when configured, and Project diagnostics. **Off** means read-only; **On** means live actions are enabled. The footer reports an unavailable preview session, and actual script diagnostics remain visible above the canvas when present. Screen parameters remain editable through **Project settings**.

An authenticated gateway administrator can select **Live actions** while Off and explicitly confirm **Enable live actions**. The gateway issues a new capability permitting draft Python for that engineering session and project; authored browser events can now run as well. Script buttons inside templates and popups use the same boundary. Python and browser JavaScript execute as trusted code; neither is sandboxed. Completed tag, database, file or network effects cannot be undone by leaving Preview. Table commits remain available only through the published operator application.

Changing modes cancels pending preview requests, revokes the old capability and resets the preview form and popup. A late response from the old mode cannot update the new preview. Cancellation cannot roll back an action that already completed, nor terminate arbitrary external work a previously trusted browser script started outside the supplied helpers. Leaving Preview closes the capability; reopening always starts read-only. Each capability expires after 15 minutes, is kept only in browser memory, and disappears on gateway restart. An unavailable or expired capability fails closed.

## Gateway contract

- `POST /api/projects/{projectId}/preview/sessions` accepts `{ "mode": "read-only" }` or `{ "mode": "live-actions" }`. Both require engineering design permission and CSRF; live actions additionally require gateway administration permission.
- The returned random capability travels in `X-SPARK-PREVIEW`. It is bound to the exact authenticated engineering session and project, and has a server-owned mode and expiration. A client label or Boolean cannot grant action permission.
- `POST .../preview/queries/{id}/execute` uses the guarded read path and rejects update definitions in both modes. SQLite uses its read-only connection and native authorizer. SQL Server retains the documented query guard and must use appropriately restricted database permissions; its query screen is not a complete SQL authorization boundary.
- `POST .../preview/scripts/run` requires a live-actions capability and current administrator permission before starting Python. Read-only capabilities cannot start the worker or invoke its tag/database functions.
- `DELETE .../preview/session` revokes the capability and cancels work using it. Requests carrying a preview capability cannot bypass this contract by using generic script, publication, configuration, administration or operator write endpoints. Unknown endpoints stay unavailable.

This capability restricts preview requests. It does not remove an administrator's existing ability to leave Preview and deliberately use the separately authorized engineering APIs. Caption locale selection is available through D12. Simulation fixtures, viewport emulation and a complete draft query/script snapshot remain later D08 increments.

## Workshop

Import the independently authored `preview-communication.sparkproj` from the companion workshop bundle, or use `examples/preview-communication.json` to build it. It contains a main screen, a popup, one shared template and a built-in sample query. It has no external connection, asset or tag dependency and performs no gateway data writes. Python is optional for read-only checks and required for the deliberately enabled message actions.

1. Open **Preview communication** in Designer and enter Preview. Confirm the footer shows **Live actions Off** and the built-in sample table loads.
2. Edit **Local preview note**. The adjacent caption follows the local value. Open and close the popup; these local interactions remain available.
3. Click the screen and nested Python message buttons, then the popup's Python button. Each is rejected without starting Python. The local note and sample table continue to work.
4. As a gateway administrator, select **Live actions**. First choose **Keep read-only** and verify the toggle stays Off. Open it again and confirm **Enable live actions**. The toggle turns On, form values reset and the popup closes.
5. Run each of the three message buttons. Each returns its distinct message; the authored scripts make no tag, database or filesystem writes.
6. Select **Live actions** while On to return directly to read-only. The toggle turns Off, the form resets, and all three Python buttons are denied again. Exit and reopen Preview to verify that live-action mode is never remembered.
7. Publish the workshop explicitly and open its operator link. The operator application follows its own authenticated publication and action permissions; switching Designer Preview modes does not alter that publication.

The workshop is a functional demonstration, not a security penetration test. The automated gateway suite separately verifies denied and forged requests, cross-session and cross-project capabilities, revoked capabilities, update-query rejection, arbitrary-Python denial and cancellation using disposable synthetic resources.
