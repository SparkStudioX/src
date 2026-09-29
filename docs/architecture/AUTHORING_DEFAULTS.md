# Canvas authoring defaults

Source: `examples/authoring-defaults.json`. Import its portable workshop using a companion build that supports `project.authoringDefaults`. No gateway tags, assets, scripts or external connections are required.

Project settings contains **Canvas authoring defaults**, an Apply/Cancel editor for new screen dimensions, new template dimensions and the initial Designer grid. Applying these defaults is one project edit; Save persists it. Existing screen and template dimensions stay unchanged.

The optional project object contains five required fields when present:

```json
{
  "authoringDefaults": {
    "screenWidth": 1400,
    "screenHeight": 900,
    "templateWidth": 700,
    "templateHeight": 450,
    "gridSize": 12
  }
}
```

Dimensions are whole pixels from 1 to 8192. Grid size is a whole number from 0 to 128; zero disables snapping. Unknown fields, missing fields and values outside these limits are rejected by the gateway. Projects without this object retain the existing defaults: screens 1200 × 760, templates 600 × 400, grid 8.

The saved grid is loaded when a project opens. Changing the toolbar grid is a local session override and does not edit these defaults. Applying a different saved default does not interrupt an active canvas session; reopen the project to adopt it. The settings travel in `.sparkproj` packages and do not change runtime scaling or navigation.

1. Open **Existing screen** and inspect its 1100 × 680 dimensions. Open **Existing card** and inspect its 300 × 160 dimensions.
2. Add a screen. Its initial dimensions are 1400 × 900. Undo creation, reopen Existing screen if needed, then add a template; its initial dimensions are 700 × 450. Undo again.
3. Open Project settings. Change a default size, then select **Cancel defaults changes**. The saved defaults and every existing resource remain unchanged.
4. Change both new-screen dimensions to 1280 × 800 and choose **Apply defaults**. One Undo restores the prior defaults. Reapply and Save if you want to retain them.
5. Try a fractional dimension, zero dimension or a grid above 128. Apply is unavailable until every field is valid. Restore a valid value and cancel the experiment.
6. Save the project with grid 12, override the toolbar to 4, then reload the Designer. Its grid returns to the saved 12-pixel default. Existing documents retain their own dimensions throughout.
7. Export, import as a separate project and repeat the first new-document check. Publication remains an explicit, separate operation.

Verification: `node tools/test-authoring-assets.mjs` checks default compatibility, validation, serialization and preservation of existing documents. Gateway admission and portable-package round trips validate the same project object.
