# Validated inputs and barcode entry

The Input palette contains **Formatted input** and **Barcode input**. All inputs expose a **Validation & format** section in the property sheet. Open **Input rules** to stage changes, Apply them together, or Cancel without modifying the component. This source increment is newer than preview.9.

Text fields, password fields and text areas support required, minimum/maximum length, text/email/digits/ASCII-alphanumeric format and a custom inline message. Other inputs support required and a custom message. A required checkbox must be checked; zero remains a valid required numeric value. Existing numeric bounds, option membership and date validation still apply. Rules are enforced in the browser and again by the gateway before a published button's Python action receives its form. Password values are not included in automatic component events.

Formatted inputs use `#` for a digit, `A` for an ASCII letter and `*` for an ASCII letter or digit. Escape a literal with a backslash. A mask may contain up to 128 positions. For example, `AA-####` changes `ab0012` to `AB-0012` when uppercase is selected and the field commits on Enter or blur. Separators are part of the stored string. Invalid or excess characters remain visible for correction; they are never silently discarded. Case conversion affects ASCII letters only. Empty required defaults and partial state-bound drafts remain editable; a completed form must pass its rules.

Barcode input accepts a keyboard scanner while the field has focus. Configure Enter or Tab as its terminator. A valid terminator commits once and selects the completed code for replacement. Repeating the same scan emits another commit. IME composition, key repeat and modified shortcuts do not submit a scan. Tab retains normal focus navigation, and blur alone does not submit. Leading zeroes are preserved because barcode values are strings. This is keyboard scanner support, not camera/image recognition or global keystroke capture.

## Workshop

Import `artifacts/sparkproj/validated-inputs.sparkproj`, review the project and publish it. It requires this source build or a later compatible release, the bundled Python runtime and an operator account with Operate permission. It has no database, equipment or gateway writes.

1. Enter `ab0012` in Part code and press Tab. Expect `AB-0012` with its validation message cleared.
2. Enter an invalid email, then `operator@example.test`. Confirm the inline message follows validity.
3. Focus Barcode and type `000123` followed by Enter twice. The accepted count must reach 2 and the leading zeroes must remain. Try an incomplete or alphabetic code; no commit should occur.
4. Select **Validate form** with an incomplete field, then with all fields valid. Only the valid form reaches Python and updates the status label.
5. Change the Barcode terminator to Tab in Designer, publish and repeat. The cursor should advance normally while accepting the scan. Open a second operator tab to confirm independent values and counts.

Validation: `node apps/web/check-input-validation.mjs` covers rules, rendered controls, staged authoring and repeat scans. `InputConstraintChecks` in the gateway test executable verifies authored definitions, blank state-bound drafts, captured publication rules and direct Python-action submissions.
