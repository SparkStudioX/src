# Local assets and parameterized popups

Images, icons and modal screens extend SparkStudio's fixed-canvas application workflow. These features are available in Designer, Preview and the published operator runtime. The current scope is immutable local still images and one modal level.

## Images and icons

An `image` component references a gateway asset ID and supports `contain`, `cover` and `fill` fitting, descriptive alternative text and an optional caption. Images and the built-in icon set can also be used inside templates. Assets use local gateway URLs; remote images and SVG uploads are not accepted.

Upload through `POST /api/assets` with JSON fields `name`, `contentType` and `dataBase64`. List metadata through `GET /api/assets`; retrieve image bytes through `GET /api/assets/{id}`. Metadata includes the SHA-256 ID, name, content type, byte size, width and height. Content responses use the validated MIME type, `nosniff` and immutable caching.

| Constraint | Current behavior |
| --- | --- |
| Formats | PNG, JPEG and WebP still images |
| Decoded file size | At most 512 KiB |
| Dimensions | At most 8,192 pixels per side and 16,777,216 total pixels |
| Identity | Lowercase SHA-256 of the uploaded bytes |
| Duplicate bytes | Return the existing asset and its metadata |
| Mutation | No overwrite or delete operation |
| Validation | Container/header structure, format, dimensions and size; not full raster decoding |

Animated images, invalid IDs, malformed containers and incompatible declared MIME types are rejected. HTTP request limits also bound the encoded upload. Old asset IDs continue to work after later draft edits or publications.

Project JSON stores asset references, not image bytes. The `.sparkproj` package includes referenced local assets along with project resources; preserve the gateway data directory for a complete backup, including databases and connection configuration.

## Screens and popup buttons

A screen may declare `kind: "screen"` or `kind: "popup"`; omission means a regular screen. Both support declared string parameter defaults. Regular screens open through authored navigation or the project's optional menu. A popup is opened by a button with `action: "openPopup"`, a `targetScreenId` and optional `props.parameters` overrides for the target's declared parameters. A popup button can use `action: "closePopup"`.

Publication validates targets and parameter keys. Popups cannot open another popup, including through a template. Ordinary navigation does not accept nonempty parameter overrides. Stacked dialogs, movable/dockable windows and modal-to-modal navigation are outside this slice.

Opening a popup captures its context and initializes fresh local inputs. Closing and reopening starts from current persisted values. Unsaved parent inputs remain intact. Keyboard focus stays within the open dialog and returns to its opener on close; Tab, Shift+Tab and Escape are handled explicitly. During a pending action, inputs and Close are disabled and Escape cannot dismiss the dialog.

## Server-derived context

A popup action sends root project parameter overrides, its typed local inputs, the publication token and `popupOrigin` containing the opener's `screenId`, `componentId` and optional legacy `instanceId`/`rowId` or the bounded nested `instancePath`. Parameter fx additionally uses validated parent inputs and sparse state snapshots, with frozen opening values separate from later popup values; see [parameter context](TEMPLATE_PARAMETER_BINDINGS.md#publication-and-gateway-actions). It does not send a trusted, precomputed popup context.

The gateway validates the saved regular-screen opener and its exact popup target under the publication token, then derives the context:

1. Root project parameters establish the base.
2. The opener's regular screen defaults resolve once against that base; its template and saved-row scopes resolve against their caller. For a query-backed repeater, the gateway re-executes the captured read query with the opener screen context, finds the exact row key, and overlays its mapped values literally after resolving authored template defaults and overrides.
3. The target popup defaults resolve once against the root base, then saved opener overrides resolve once against the opener context.
4. A target template or row adds its own local scope inside the popup. A query-backed target repeater uses the resolved popup context for its own captured query and row lookup.

This one-pass rule preserves literal placeholder-like text in supplied values. A popup action requires a valid origin, while a regular-screen action rejects one. The gateway rejects forged opener identities, mismatched targets and stale publication tokens. Runtime responses omit authored script source.

## Query-row popup lifecycle

A button inside a query-backed repeater can open a popup using the same parameter mapping as a saved template instance. Use a versioned row key when a changed record must invalidate an open form. The dialog captures the selected row's context and initializes independent inputs; it never silently switches those inputs to another row. Its client-side source check uses the same published query as the opener. Missing or changed source records and query failures disable actions while leaving Close available. Successful actions refresh the surrounding data; the dialog retains its result so the operator can review it and close.

The gateway independently checks opener row membership again before executing every popup script. A missing or stale row returns a clear error, leaving the operator application loaded. This check and the subsequent script are separate operations: an update query must still enforce its expected revision and atomic business transition. A dialog's visibility or selected demo identity does not grant authorization. There is still only one popup level, and a template used inside a popup cannot itself open another popup.

These checks protect application identity and context alongside the account/project authorization in [Security](SECURITY.md). They do not authorize equipment control; external OPC writes remain unavailable.

## Example and verification

The independently authored [assets and popups example](../../examples/assets-popups.json) adds a local drawing, contextual workcenter forms and saved-row order dialogs. Run from the repository root:

```powershell
node tools/load-example.mjs assets-popups
```

The loader adds missing resources while preserving existing IDs and values. Review and publish the draft. Default read-only Preview blocks Python. Save the draft and explicitly enable administrator Live actions to exercise a Python action; authored actions can then change local memory tags, just as published actions can.

API upload, format rejection, immutable content, publication isolation, server-derived contexts and restart persistence have been tested on Windows and the Linux container. Browser checks covered image rendering, inspector edits, nested-template popup forms, row isolation, parent input retention, focus restoration and busy locking. Automated verification of the browser file chooser was blocked by its extension's file-access permission; the upload API and image rendering were verified separately. Full evidence and remaining limits are in [PARITY.md](PARITY.md).
