# View containers

`viewContainer` adds embedded views, tabs, split panes and docks inside an ordinary component rectangle. Screens and templates keep their existing free-positioned coordinates. Every pane references a shared template and has an explicit stable ID, label and saved parameter overrides.

Add a container preset from the Designer palette. The **View container** property group selects the layout, initial tab or split position. **Edit panes** chooses template references and overrides; **Apply container** makes one undoable change. Cancel discards the draft. The editor rejects missing references, duplicate pane IDs and invalid composition before applying. Pane definitions are structural settings, so their rows have no expression-binding button. The ordinary component properties retain their supported bindings.

Tabs support Left/Right, Home and End with a roving focus target. Split separators support pointer dragging and arrow keys; Shift moves ten steps, and Home/End select limits. Docks reserve a center pane and up to one pane per side. Their toolbar opens and closes side panes; each side has a pointer/keyboard separator. Dock widths/heights are capped by available space so the center remains reachable. These controls change only this browser's presentation and reset when the screen is opened again. They do not write equipment or change the saved layout. Authored navigation buttons keep using the containing screen's navigation handler.

Each pane owns separate form values and private template state. Switching tabs and closing docks retains that state, suspends automatic and interaction events, and removes inactive message subscriptions. Reopening resumes against current values without replaying mount events or hidden property changes. Pending helpers lose authority when their pane becomes inactive. Registered disposal callbacks still clean up resources on final removal. Navigation away destroys the screen's pane instances normally.

Embedded actions and popups use the containing screen's navigation and the pane's parameters and inputs. The gateway reconstructs the saved template path using the container ID and pane ID; caller values cannot select another template. Nested containers participate in the same four-level nesting and 10,000 expanded-component limits as ordinary template placements. Every pane participates in cycle, reference and publication checks, including initially hidden panes. Pane visibility is presentation, not an access permission: project grants and action authorization remain the security boundary.

The project JSON contract stores `props.viewLayout` with `kind`, `panes`, and optional `initialPaneId`, `orientation`, and `ratio`. Panes contain `id`, `label`, `templateId`, optional `parameters`; dock panes add `edge`, optional `size` and `initiallyOpen`. Only side docks support size/open defaults. Parameter values use existing single-pass parent references and template type conversion. No new project package format or gateway connection is required. Saved pane references appear in project search and block deleting a referenced shared template. Assets inside referenced definitions follow normal project package/publication handling.

## Portable workshop

`examples/view-containers.json` is an independently authored portable workshop, compatible with view-container builds. It needs no connections, tags or external devices. Import its generated `.sparkproj`, explicitly publish it, and open the operator application. View permission supports navigation and local pane presentation; Operate is required for form actions and Python events.

The **Tabs**, **Split**, **Docks** and **Embedded** buttons along each screen's footer work in the default application-only presentation. They navigate between screens; switching screens starts fresh pane instances. Use pane tabs and dock visibility controls to test retained values within a screen.

1. On **Tabs**, change West quantity to 7, then visit East. East begins at 2. Return to West: it remains 7 and its mount counter stays 1.
2. Send **Message visible forms** on West, switch to East, and compare the message counters. Hidden panes do not receive messages. East is an embedded form inside a second template boundary.
3. Use **Inspect form (Python)** and **Open scoped popup**. The returned/opened station must match the selected pane. These scripts only return synthetic form values.
4. On **Split**, resize by pointer and keyboard. Both independent quantities remain intact.
5. On **Docks**, change Details quantity, close it, and reopen it with the toolbar. Its quantity is retained. Open Notes and resize either side. Main navigation stays available.
6. On **Embedded**, verify the form fits its free-positioned rectangle. Export, import as another project, explicitly publish and repeat the checks; pane IDs, references and layout defaults round-trip.

Validation: `node apps/web/check-view-containers.mjs` and `node tools/test-view-containers.mjs`. These checks use authored fixtures and local disposable storage only.
