# Drawing and equipment symbols

SparkStudio's first drawing set contains **Line**, **Rectangle**, **Ellipse**, **Polyline**, **Pipe** and **Equipment symbol**. They use the fixed canvas, stored X/Y positions, selection, move/resize, alignment, flat groups, duplication and Undo/Redo. Templates and repeaters can contain drawings; their bindings use each instance's form and parameter context. Popup drawings use the popup's context.

## Place and edit geometry

Choose a drawing from the palette and position its component box. A line has two endpoints. Polyline and pipe routes have 2–64 ordered points connected by stroke segments. In **Drawing points → Edit points**, X runs left to right and Y top to bottom from 0 to 100% inside the component. Finite fractional coordinates are allowed. Consecutive points must differ; crossing segments and returning the final point to the first are allowed. Closing a route this way draws an outline, without a polygon fill.

Change the numeric X/Y fields to move a point. **Insert after** places a midpoint on the next segment; **Add point** extends the final point by ten horizontal percentage points, inward when it is near the right edge. Arrow buttons change route order, and Remove keeps at least two points. The numbered preview shows the local route before rotation. Apply points saves the whole route as one history step. Cancel or Escape discards the local draft; Ctrl/Meta+S applies a valid open draft. Moving/resizing the component box keeps the normalized points intact. Point dragging directly on the main canvas is not included.

Rectangle corner radius is a static finite number from 0–50% of the shorter side, changed through **Edit corners**. An equipment component uses **Choose symbol** to select the supplied pump, valve or motor. Radius and symbol edits also use Apply/Cancel. Ellipses need only their component box and appearance settings.

## Property sheet

Every supported scalar has a static value and an fx button. The existing expression editor supports named tags, form inputs, parameters and custom properties with the same scope and error rules as [other bindings](PROPERTY_BINDINGS.md).

| Property | Supported drawings | Values and defaults |
| --- | --- | --- |
| Stroke color | All six | Hex color; default `#64748b` |
| Stroke width | All six | Finite 1–32 pixels; default 2, or 12 for Pipe |
| Rotation | All six | Finite 0–360 degrees; default 0 |
| Fill color | Rectangle, Ellipse, Pipe, Equipment symbol | Hex color or exact `none`; default `none` for shapes, `#334155` for Pipe, `#64748b` for equipment |
| Flowing | Pipe | Boolean; default false |
| Reverse flow | Pipe | Boolean; default false; reverses flow along point order |
| Active | Equipment symbol | Boolean; default false |
| Accent color | Existing common property | Flow marks and active equipment outline; default follows the theme |

Hex colors allow 3, 4, 6 or 8 digits. Fill controls the pipe interior and equipment body as well as filled shapes. A pipe shows moving flow marks in Preview/operator runtime only when Flowing is true; designer placement keeps those marks still. Reduced-motion preferences stop the animation. Active and flow indications display the state you supply; they do not simulate a process or send device commands.

The common Text row is labeled **Accessible label** for drawings. It names the shape or route for assistive technology and supplies a visible caption beneath equipment. Pipe/equipment accessible state includes stopped/flowing direction or inactive/active. Normal Text color and Font size affect captions. Points, corner radius and symbol choice remain structural values without fx controls.

Rotation is applied inside the authored box, with the geometry scaled to fit. Stroke stays within the box; very small boxes may reduce its rendered width. This preserves canvas bounds but means rotating a wide route can reduce its visible size. Common layout bindings can change the runtime box while designer handles continue to use stored geometry.

Invalid drawing configuration, unavailable drawing bindings or bad/missing tag quality produce **Graphic unavailable** and a diagnostic. An unavailable binding does not reuse a saved active/flow state. Ordinary binding errors also block interaction. Visibility and enabled bindings keep their common behavior and do not grant permissions.

## Equipment navigation

An equipment symbol's **On click** setting defaults to **None**. Choose **Open a screen** and a normal destination screen, or **Open a popup** and a popup screen. Popup overrides use only parameters declared by the target; existing parameter resolution and instance/row provenance apply. Save and Publish release the configured destination with the project. Buttons remain the component for authored Python actions and Close popup.

Configured symbols act as keyboard-accessible buttons in Preview/operator runtime and stay inactive during canvas placement or when their scope is locked. Popup-to-popup opening follows the existing popup restrictions. Changing the action clears its old target and overrides, so choose the new destination before saving.

## Example and limits

```powershell
node tools/load-example.mjs process-graphics
```

Use the independently authored example on an authenticated local development gateway, review the loaded draft in Designer, and publish when ready. The general example loader preserves existing resource IDs and backs up the draft; see the [example workflow](../../README.md#build-an-application). Drawing checks are available through `node apps/web/check-drawing-authoring.mjs`; the [verification ledger](PARITY.md) records the checks and browser coverage actually completed.

This set uses original built-in SVG primitives and typed point arrays. It does not accept arbitrary SVG markup, external URLs, path strings or scripts. Filled polygons, curves, arrowheads, automatic routing, attached connectors, pipe joints/networks, imported symbol libraries, paintable canvas and equipment command/acknowledgment behavior remain future work. Supplied-data charts are a separate next palette family; these drawings do not implement history, alarms or charts.
