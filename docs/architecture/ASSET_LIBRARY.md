# Asset library and replacement previews

Open **Project tools → Asset library** in the Designer's Project pane.

Source: `examples/asset-library.json`. This setup-required workshop starts with unassigned image components and cannot be published until every image has an uploaded local asset assigned. Use the companion Designer build with **Asset library** and bring two local PNG, JPEG or WebP images, each no larger than 512 KiB. No tags, database, scripts or external service are needed. The authored fixture intentionally contains no image files; after setup, export its configured project as a portable `.sparkproj`.

The library searches image name, content ID and usage location. Its structured inventory covers image components in every screen and shared template definition, including unused templates. It does not interpret strings in scripts, URLs or arbitrary metadata. A template image appears once in the inventory even when that template is placed multiple times.

Images retain immutable content IDs. Replacement updates selected `props.assetId` references in the current draft; it does not overwrite or delete stored files. Previous publications can continue serving their existing image IDs.

1. Load the authored workshop draft into a new project. Select **Desk photo** on Image desk and upload image A through its Local image property. Upload image B through the same control, then choose image A again so both files are available locally.
2. Open Second screen and assign image A to **Detail photo**. Open Shared image card and assign image A to **Shared photo**. The two screen images plus the shared template definition now provide three explicit references.
3. Open Asset library. Search by image name or `Shared image card`; choose image A. Inspect its three structured uses. **Open** navigates to the relevant component and closes the library without changes.
4. Choose image B as **Replacement image** and select **Preview image replacement**. Compare the before/after thumbnails. Clear the selection, then choose only Desk photo and apply. Its size, position, fit, alt text, bindings and other properties stay unchanged; Detail photo and the shared image remain on A. One Undo restores the operation.
5. Repeat, selecting only the shared template image. Both template placements use B when rendered from the edited draft, while the independent screen images keep A. Undo once.
6. Publish the original A version. Apply all three replacements in the draft and Save. The operator application still displays A until you explicitly Publish; after publishing it displays B. Both immutable assets remain in the library.
7. Export and import this configured project as a separate `.sparkproj`. The normal project package includes the images referenced by the exported draft. Unused historical images are retained on their original gateway, not added to the draft package.

Previews of more than 100 uses are paginated. Initially only the first page is selected; **Select all N uses** is an explicit action and the selected count includes other pages. Changing the source or target invalidates the preview. Applying after any project or asset-library change requires a fresh preview, including changes to a saved revision. Missing source files can be repaired when their valid image ID remains referenced and a replacement is available locally.

Verification: `node tools/test-authoring-assets.mjs` checks structured inventory, selective replacement, duplicate IDs in different owners, stale previews, malformed selections and preservation of unrelated properties. Designer replacements use the normal single-step Undo, Save and Publish workflow.
