# Offline caption translations

Project **Translations** stores caption messages inside the application. Each stable key has a required default-language text and optional other translations. The initial catalog supports English (`en`), Spanish (`es`), French (`fr`), German (`de`), Italian (`it`) and Portuguese (`pt`), optionally with a region such as `en-US`, `es-MX` or `pt-BR`. This is a text-only, left-to-right baseline. Number/date/unit formatting, menu and option labels, pluralization, translated scripts and right-to-left layout are separate work.

Open **Manage translations** from a component property sheet, or **Project tools → Translations** in the Project pane. Add languages and stable message keys, then enter each language’s text. The editor stages its changes: Cancel discards them, Apply records one Undo step and rejects a stale project snapshot. Removing a language also removes that language’s staged translations; the default cannot be removed. Changing the default requires a translation for every message in the new default language. Referenced message deletion is blocked until its screen/template assignments are removed. Save and Publish remain explicit.

Assign a key using **Caption translation → Translation key**. Translations preserve the same `{parameter}` tokens as the authored caption; tokens may move to fit the language’s grammar but cannot be added, dropped or duplicated. Normal template parameter interpolation follows translation. A Text expression or named-query binding retains final precedence and does not report an unused translation fallback. Password controls do not accept translation keys.

Use **Language** in Designer Preview or in the optional operator runtime controls. Language selection is local to this browser and project; it does not edit the application, require publication, or reset form input context. Application-only operator links can choose a configured language using `?lang=es` (use `&lang=es` when the link already has a query string). An explicit URL language takes precedence on a fresh page load; subsequent selections apply immediately on the current page. Invalid/unconfigured launch languages use the project default.

When a chosen language has no translation for a message, its default-language caption renders with a visible fallback note. Missing/corrupt resources fall back to authored text with a note. The caption carries the language actually used for assistive technology; untranslated and bound captions use the project’s declared default language. Fallback notes do not grant or revoke permissions, clear binding errors, or disable otherwise valid controls. Authored input values, option labels/values, field keys, IDs, parameters, script code and action payloads remain unchanged. Existing property-change scripts can still observe a changed rendered Text property under their normal contract.

The catalog permits up to eight languages and 500 message keys. Each translation is nonblank and up to 2,048 UTF-16 characters; total translated text is at most 262,144 characters. Keys start with a letter and contain up to 64 letters, numbers, dots, underscores or dashes. Text is plain text with normal parameter interpolation, never HTML. Gateway save/publication/package admission enforces the catalog shape, text limits, language declarations, parameter preservation and known component references. `.sparkproj` packages carry the authored catalog; language selection and live inputs remain browser state.

## Workshop

The original [localization.json](../../examples/localization.json) has two screens, two independent template placements and English, Spanish and French caption resources. It needs no database, equipment, scripts or external network access.

1. Import the matching `.sparkproj`, open Designer Preview and enter distinct main/Assembly/Packing notes. Select Spanish and verify the captions change while all three notes and the choice value stay unchanged.
2. Confirm the parameter values remain `Assembly` and `Packing`; the surrounding station captions translate. Navigate to Review and back through the translated buttons.
3. Select French. The intentionally incomplete final caption displays its English fallback with a visible explanation. Other configured French captions render normally.
4. Open Translations, add the missing French message, Cancel first, then reopen and Apply. Undo should restore the earlier catalog in one step.
5. Try removing an assigned message or changing its `{station}` parameter. The editor explains its reference or validation constraint. Assign an available matching message from a component’s property sheet.
6. Save a translation change while keeping the operator application open: its existing publication stays unchanged. Publish explicitly and verify the new captions. Export/re-import to verify stable message keys and authored input defaults.
7. Open an application-only link with `?lang=es`. It renders the project screens in the configured language without adding runtime chrome.

Use a matching current gateway build; the older public preview installer does not contain this feature. Model, renderer, gateway and browser checks are separate evidence; completed browser/package verification is recorded in PARITY.md.
