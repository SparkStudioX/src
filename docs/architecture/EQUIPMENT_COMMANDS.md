# Reviewed equipment commands

Declare commands in **Designer → Project tools → Equipment commands**, then place an **Equipment command** control and select a declaration. Definitions travel with saved project drafts, packages and the complete application publication. Designer Preview never dispatches commands; testing uses the published operator application.

Every command specifies a concrete configured memory or OPC UA tag, scalar type, readable confirmation text and optional separate readback tag. Numeric commands require minimum and maximum limits. Text commands have a bounded maximum length. Readback defaults to the written tag, with a 100–10,000 ms deadline and optional nonnegative numeric tolerance. The target, readback and command types must match. Derived expression tags and disabled providers, scan groups, instances, tags or connections cannot be commanded.

## Operator workflow

1. Enter a requested value and choose **Review command**. The gateway checks the current publication, command permission, types, limits and configuration, then reads the current target value.
2. Review current/requested values and the authored confirmation. The review token is bound to the account revision, project and command, expires in 30 seconds, and can dispatch only once.
3. Choose **Confirm command**. The gateway rejects changed publication/configuration/value or a concurrent in-flight command to the same tag. It records an audit attempt before dispatch.
4. The gateway sends one write and reads the configured feedback until it matches or the deadline expires. The response distinguishes **confirmed**, **rejected**, **notConfirmed** and **uncertain**. A lost response never implies success or a safe retry. Use the correlation reference to inspect the audit.

**Commands** is a separate project permission. Existing View or Operate grants do not authorize device writes. Gateway administrators have it; other accounts need an explicit grant under Gateway Settings → Security and readable tag scopes covering both target and readback. Commands includes Operate and View. Operator mutations also require the authenticated operator session and CSRF token. Revoked/changed accounts cannot use an old reviewed intent; permission and tag access are rechecked immediately before dispatch.

Confirmation and readback are application controls, not PLC interlocks. Fresh-value comparison is not an atomic compare-and-write operation on the device. An external controller or client can change the device after that comparison. Readback confirms a sampled value, not completion of a physical action. Protocol/application timeouts cannot undo a write already received by equipment. OPC UA writes are never automatically retried.

Ordinary Python `system.tag.writeBlocking` retains its memory-tag scope; it does not bypass this equipment-command contract. There is no implicit write from a bound input, and no momentary/pulse automation.

## Native button action

Select a button, open **Edit actions & events → On click**, choose **Set tag value**, and browse a configured memory or OPC UA tag. Choose **Fixed value** for a Boolean, number or plain text, or **Component property** to select a scalar property. Apply, save and publish the application. Designer Preview does not write; test through the published operator application with Commands permission.

Property references use the current instance of the calling form. Select **This component** for the button's own properties, another component in the same form for its properties, or **Parent** for the containing screen/template's authored name, width or height. An input's `value` reads its current validated operator value; general, component-specific and custom scalar properties use their published bindings. Caption sources use authored/bound text before translation. Appearance values require an explicit local value, assigned saved style or binding; browser-theme and inherited-only appearance cannot be read as tag values. Password values, structured datasets and references outside the calling form are excluded. No script or expression text is required.

**Require confirmation** is optional. Without it, one operator activation reviews and executes the saved action; with it, the dialog shows the current tag and resolved requested value before dispatch. The gateway reconstructs the saved value source from validated form/UI context and current gateway data. It owns the target and the one-use ticket, and rechecks access, publication, tag configuration and source dependencies before dispatch. It never accepts an arbitrary requested tag/value from the browser and never retries an uncertain write.

If a project equipment command already targets this tag, its bounds, confirmation and readback settings apply. A native button cannot relax them. Duplicate declarations or incompatible types are rejected. Native tag actions require preview.11 or a later compatible build; preview.10 does not include them.

## API

The project API exposes `GET /runtime/commands?publishedAt=...` to viewers. `POST /runtime/commands/{id}/review` takes `{ publishedAt, value }`. `POST /runtime/commands/{id}/execute` takes `{ token, confirmed: true }`. Review/execute require Commands permission. No client-supplied endpoint, node ID or script is accepted. The actual OPC endpoint and node are resolved from gateway-owned tag configuration.

Native button actions use `POST /runtime/screens/{screenId}/components/{componentId}/tag-action/review` and the corresponding `/execute` route beneath the project API. Review supplies the publication and scoped parameters, input values, UI overrides and instance context; the saved component supplies the tag and property reference. Execute supplies only `{ token, confirmed: true }`. It does not accept a replacement target or value.

Pending reviews are bounded to eight per account and 128 gateway-wide. A process restart invalidates them. No durable command replay is attempted. Audit records identify actor, project, command, correlation ID and outcome without logging submitted values or connection credentials. A receipt applies to that invocation, not a permanently synchronized browser field.

## Synthetic workshop

`examples/equipment-commands.json` and `tools/load-equipment-commands-example.mjs` create four independent memory tags under `[default]CommandWorkshop`. They do not configure an OPC endpoint or write physical equipment. Run the loader against an isolated local gateway using `SPARKSTUDIO_ADMIN_AUTH_FILE`; add `--publish` to deliberately publish. The loader rejects colliding project names/tag paths.

Review and confirm a speed, run flag and note. Verify the separate live displays. Try an out-of-range speed, cancel confirmation, change a value from another operator after review, and compare an Operate-only account with one granted Commands. Review the audit references. Re-export/import retains declarations and controls, but the imported project has no publication or gateway tags.

Open **Native tag actions** from the first screen. Change the three fields, press their tag buttons and verify the reviewed values and live displays. The numeric field retains the declared 0–100 command limit. **Quick write: 25** writes the separate quick tag without a confirmation. **Write parent screen height** writes 780 to that same synthetic tag. In Designer inspect the buttons' value-source pickers; Cancel discards edits and Apply creates one undo step. This is a setup-required workshop: accounts and gateway tags are never included in a project package.

An independently hosted loopback OPC UA simulator validates protocol writes separately from memory command checks. Deployment to an identified test device, process interlocks, external-client races and production load remain site acceptance work.

Verification: `dotnet run --project src/SparkStudio.Gateway.Tests -- --equipment-commands-only` covers intent ownership/replay, bounds, expiration, stale state/configuration/publication, permission revocation, cancellation before and after dispatch, concurrent command refusal and bounded readback. `dotnet run --project src/SparkStudio.Connectors.Tests -- --opc-integration` checks real loopback OPC UA accepted/rejected writes and readback. With the owned 5093 fixture running, set `SPARKSTUDIO_TEST_AUTH_FILE` to its ignored `browser-auth.json` and run `node tools/test-equipment-commands.mjs` for authenticated command/scoping/CSRF/audit and authored workshop re-export checks.

The full Gateway test runner also discovers `NativeTagActionChecks`; `node apps/web/check-native-tag-actions.mjs` checks browser activation, confirmation, cancellation and stale context. The authenticated HTTP suite includes fixed and property-sourced native actions, command precedence and package round-tripping.
