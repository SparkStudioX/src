# Resource changes workshop

This workshop demonstrates Designer's dependency previews for screen and template display-name changes, and screen, template and component deletion. It contains only authored synthetic resources: three screens, two templates and local form bindings. There are no tags, assets, database connections or gateway writes.

Import **Resource changes** from the workshop bundle through **Projects → Import .sparkproj**. The source is [resource-changes.json](../../examples/resource-changes.json). Use a gateway build that includes resource change previews; an older build may render the screens without providing these Designer tools. The optional read-only Python button needs the bundled Python runtime and operator permission. Nothing else in the workshop needs Python or external setup.

## What a preview means

A screen or template rename changes its display name and preserves its stable ID. Existing navigation targets and template placements keep their identifiers. Captions, menu labels and script text are authored separately; renaming a resource does not rewrite them.

Deletion inspects explicit references from resources that will remain. A navigation button targeting the deleted screen, a placement of the deleted template, or a surviving component binding that reads a deleted input or custom property blocks the change. Components in a selected group are removed together, so references wholly inside that group do not block its deletion. Screen deletion also previews navigation-menu cleanup and any startup-screen fallback.

Code matches are a separate warning. A matching word in Python, JavaScript or SQL might be a comment, a literal or part of dynamic logic. Review and acknowledge these matches before deletion; they are never automatically rewritten. This analysis is not a complete script call graph and cannot identify every dynamically constructed name.

Applying an allowed preview changes only the current project draft and adds one Undo step. Cancel leaves the draft untouched. Save and Publish remain explicit actions. If the project or indexed resource drafts change while a preview is open, review a fresh preview instead of applying stale results.

## Try it

1. **Run the form.** In Preview, type in **Station note**. The caption immediately shows `Draft note: ...`. Open **Station details**, then use its Back button. The two station cards share one template. These screens also work in the published operator application; Designer controls are not exposed there.
2. **Rename without repairing references.** Rename **Station details** to **Packing details**, inspect the preview and apply it. Rename the **Station card** template to **Shared station card**. Their stable IDs remain `changes-details` and `changes-card`. Navigation and both template placements still work. Undo each rename before continuing if you want the original labels for the remaining steps.
3. **Inspect blocked deletions.** Preview deletion of **Station details**: the home screen's navigation button must block it. Preview deletion of **Station card**: both placements must be listed. On **Change workshop**, preview deleting **Station note**: the caption's input binding must block it. Cancel each preview. No missing references should be created.
4. **Delete and undo a component.** Select **Scratch label · delete and undo**, inspect the deletion preview and apply. The label disappears. One Undo restores it at its original position.
5. **Delete and undo a group.** Select **A two-part scratch group** and preview deleting the selected group. Both `pair-heading` and `pair-caption` are removed together. The caption's reference to the heading is internal to that deletion, so it must not block the change. Apply, then use one Undo to restore the pair and its binding.
6. **Remove an unused template.** Preview deleting **Spare card**, which has no placements. Apply, then Undo. **Station card** and both visible station cards remain intact.
7. **Review a code-text warning.** Open **Scratch screen** from the Screens list and preview its deletion. The Python comment in **Read-only script example** contains `changes-scratch`; it is a text match, not a verified navigation dependency. Review that comment, acknowledge the warning, then apply. The comment remains unchanged. One Undo restores the screen.
8. **Inspect navigation cleanup.** In Project settings, temporarily make **Scratch screen** the startup screen and add it to a navigation menu. Preview its deletion again. Verify that the preview lists the menu-item removal and replacement startup screen as well as the code warning. Cancel, then restore the original startup screen **Change workshop** and navigation mode **None**. The normal workshop uses its own navigation buttons.
9. **Check publication separation.** Save and publish the intact workshop, then open its operator application. Apply a scratch-label deletion in Designer without saving or publishing: a refreshed operator application still shows the published label. Undo the draft deletion to finish with the intact project.

## Limits

This increment covers display-name changes and deletion previews for project canvas resources. It does not rename stable IDs, repair arbitrary code, perform bulk search-and-replace, or rename/delete gateway connections, tags, named queries or script resources. Structured blockers must be resolved deliberately in their owning resources before retrying deletion. Unsaved project changes remain subject to the existing revision check when saved.
