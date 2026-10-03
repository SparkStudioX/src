# Canvas precision workshop

Source: `examples/canvas-precision.json`. The portable package needs the companion Designer build with **Select type…**, **Match size…** and the numeric grid control. No gateway tags, external database, image assets or scripts are required.

The Designer edits authored coordinates. Runtime bindings can resolve different coordinates in Preview and the operator application; arranging a component does not rewrite its bindings.

1. Import the workshop as a new project and open **Precision desk**. In the arrangement toolbar choose **Select type… → Rectangle**. The three cards become selected; the captions remain unselected.
2. Choose **Match size… → Same width**. Each card becomes 180 pixels wide, retaining its own origin and height. The reference is the first selected object in layer order, regardless of click order. One Undo restores all three original widths.
3. Repeat with **Same height**, then **Same width and height**. Undo each command. Matching sizes does not round to the current grid.
4. Choose **Select type… → Ellipse**. The saved two-circle group and independent circle are selected. The group is one arrangement object with bounds 150 × 50. Matching both dimensions makes the independent circle 150 × 50. Undo once.
5. Select one rectangle, focus the canvas, and press **Ctrl+Shift+A** (Command+Shift+A on macOS) to select its type. Saved groups always include every member, even if the members have different component types. The shortcut uses the first selected control's type.
6. Enter **12** in the grid field and drag a card. The top-left selection anchor follows that grid; canvas edges take precedence. Boundary guides and the X/Y/W/H readout describe the moving selection. Arrow keys nudge one pixel; Shift+Arrow nudges ten pixels independently of the grid. Dragging is one Undo transaction.
7. Enter **0** to disable grid snapping. Values must be whole pixels from 0 through 128; invalid input is rejected. This toolbar choice is a session override, not a runtime layout setting.
8. In **Layers**, click a row and **Shift-click** another to select the contiguous range in the displayed order. **Ctrl-click** (Command-click on macOS) adds or removes a layer from the selection. Saved groups select together; ungroup first if you need to remove one member.
9. Choose **Delete selected** in Layers, or press **Delete** while the layer list has focus. Review the affected components and any references, then apply the deletion. One Undo restores the deleted selection. Selecting layers does not change their Z order.

**Delete screen** is disabled for the project's only regular screen because the application needs a startup screen. The inspector explains this and offers **Add another screen**. Create a replacement, return to the original screen, then delete it. To clear a screen while keeping it, select its layers and delete that selection. Popups and templates do not count as a regular startup screen. References from other controls can also block deletion; the deletion review lists those references before applying any change.

A matching operation that cannot fit inside the canvas or would shrink an affected control below 40 × 28 pixels is rejected as a whole. Saved groups scale their child positions and dimensions together on the requested axes. The reference object and unselected controls remain unchanged.

Save and publish explicitly to update an operator application. This increment covers fixed-coordinate authoring; responsive containers and snapping to other objects remain separate roadmap work.

Verification: `node apps/web/check-canvas-model.mjs` covers type selection, group behavior, size matching, geometry/binding preservation, bounds, validation and one-step history restoration.
