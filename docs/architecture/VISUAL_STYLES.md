# Reusable visual styles

Project visual styles define reusable accent, background, text color, border color, border width and font size. Open **Manage visual styles** from a component’s property sheet, or **Project tools → Visual styles** in the Project pane. The dialog stages additions, names and appearance values until **Apply styles**; Cancel discards its draft. Applying the catalog is one Undo step, and rejects an editor opened against an older project snapshot. Save and Publish remain explicit.

Assign a style under **Visual style → Assigned style** in the component property sheet. Its **Appearance sources** table distinguishes a binding, a local override, the assigned style and inherited defaults. **Clear** removes that one authored override; it does not remove a binding. The table describes authoring sources, not sampled live binding values; the normal property binding editor retains live previews and diagnostics.

## Precedence and boundaries

Precedence is theme defaults, containing-template appearance, assigned style, defined local component property, then the existing expression or named-query binding. Explicit zero border width remains a local override. Clearing an authored property uses the same fallback before and after save. Template/repeater wrappers apply their style before passing supported appearance defaults to child forms. A child’s style or local value overrides those defaults. Existing child-accent behavior prevents accidentally inheriting a conflicting wrapper text color.

Style changes do not change IDs, geometry, field keys, form values, action code or authority. Styles cannot contain enabled, visible, state, scripts, animations, arbitrary CSS, URLs or bindings. Existing input read-only/permission gates, wrapper locks and binding/communication diagnostics remain in force. Missing or invalid assignments show a component failure and block interaction; they cannot silently grant access. Quality-aware conditional style rules are not part of this increment. Continue to use existing scalar bindings for state-dependent presentation.

Styles use up to 100 project resources, each with a stable 1–64-character alphanumeric/dash/underscore ID and a 1–80-character name. Colors are explicit hexadecimal RGB/RGBA; font size is 1–256 px and border width 0–32 px. A style needs at least one supported property. Omitted properties follow existing defaults, so changing the application theme still affects unassigned properties. Explicit colors remain explicit across theme changes; authors are responsible for checking their chosen colors for contrast. No animation is introduced.

The editor lists assignments across every screen and template. Removing a referenced resource is blocked until those assignments are removed. Renaming a style changes its display name while preserving its ID. Gateway draft, publication and package admission independently enforce the same shape, type, limits and reference rules. Project packages include authored styles and assignments; they contain no live operator state.

## Workshop

The original [visual-styles.json](../../examples/visual-styles.json) example needs no equipment, database, scripts or network services. Import its generated `.sparkproj` with a matching gateway build; import creates an unpublished project.

1. Preview the two station panels. Edit one note and confirm the sibling note remains independent. Open and return from the review screen through its navigation buttons.
2. Select the shared caption, open **Manage visual styles**, choose **Section caption** and change its font size. Cancel first to verify no project change, then reopen and Apply.
3. Inspect the shared caption and both station headings. They use the changed style. **Local font override** stays at 30 px; clear that override in **Appearance sources** to use the style.
4. Toggle **Use attention color** in Preview. Its bound caption changes color while the style continues to provide its font. The disabled navigation button stays disabled.
5. Change **Station card** background. The Assembly wrapper uses it; Packing retains its local background override. The template’s child heading keeps its assigned caption style.
6. Try deleting **Section caption**. Its screen/template assignment list explains why deletion is disabled. Rename it and confirm the same assignments remain.
7. Undo the catalog change in one step. Save an accepted change, verify the operator remains on the previous publication, then Publish and verify both screens use the new style. Export and re-import the project to inspect the same stable style IDs and assignments.

Use the current workshop bundle; the older public preview installer does not include these resources. Browser/API verification is recorded in PARITY.md when run, separately from the bounded model tests in `tools/test-visual-styles.mjs`.
