# Reusable tag models

Tags → **UDTs / scan groups** manages reusable definitions, pinned instances, shared scan intervals and the built-in `[default]` provider. Gateway Configuration capability or administrator access is required. Every model mutation has a read-only preview followed by **Apply reviewed changes**. The preview reports affected concrete tags, retained override fields and dependency conflicts. A conflict blocks apply; a concurrent tag write, configuration edit or connection edit requires another preview.

## Define, instantiate and upgrade

1. Create a definition ID and positive integer version. Members use relative paths (`Count`, `Metrics/Rate`) and an existing value source: memory, expression or OPC UA. Each member has its normal scalar data type and source configuration. Expression inputs beginning `./` refer to another member of the same instance; concrete tag inputs can refer outside it.
2. Preview and apply the definition. Saved versions are immutable. Select one under **Start from** to draft the next version.
3. Create an instance at a concrete `[default]` path, select a definition version and enter member overrides if needed. For example, `{"Count":{"value":12}}` overrides one initial value. Instance namespaces cannot overlap each other or direct tags.
4. To propagate a new definition, edit each intended instance’s pinned version. Preview displays the expanded member changes and retained overrides. Unselected instances keep their old version. Multi-instance upgrades can be reviewed/applied together through the version-2 import format.
5. Remove an override field to inherit the definition again. Memory writes to an instance member are persisted as value overrides, so an upgrade preserves the written value. Source kind and data type belong to the definition. An incompatible retained value or an override targeting a removed member blocks the upgrade until corrected.

Generated members are visible in the ordinary tag browser with their definition, version and overrides. Edit them through the instance/model workflow. Removing an instance or definition also uses preview; a referenced definition, scan group or expression input cannot be removed while still required. Browser component tag bindings are outside gateway expression dependency validation and may need updating after intentionally removed paths.

## Scan groups and provider lifecycle

A named scan group has an enabled flag and an interval from 100 through 60,000 ms. Choose its name on an ordinary tag or use the `scanGroup` member field. Group timing overrides individual timing. OPC UA subscriptions request that interval; expression evaluation uses the gateway’s 100 ms scheduler resolution. Memory tags retain their values and original source timestamps rather than generating periodic data samples.

Disabling a group, instance, or tag produces `Bad_Disabled` quality for its affected tags. The **Provider** tab shows configured/good/unavailable/disabled counts and running/degraded/disabled state. Disabling `[default]` disables its configured and sample tags, rejects memory writes, and stops configured OPC subscriptions. Re-enabling restarts acquisition. Connection enable/disable remains independent. Provider health is a snapshot refreshed on opening the dialog or applying a change.

Types, quality and timestamps flow through the existing engine: expression values have their declared scalar type, bad input quality propagates, and derived timestamps use the newest contributing source timestamp. OPC values preserve their device/source timestamp. Additional providers, nested UDTs, inheritance, UDT parameters, alarms and historian configuration are outside this format.

## Import/export and migration

Exports use `sparkstudio.tags` version 2. The file contains `tags`, `udtDefinitions`, `instances`, `scanGroups` and the default `provider`. Imports merge by tag path, definition ID/version, instance path and scan-group name. Fields absent from a file do not remove existing resources. A v2 import must supply all four arrays (they may be empty); `provider` is optional, which preserves the current provider state.

Explicit removal arrays are `removeTags`, `removeInstances`, `removeScanGroups` and `removeUdtDefinitions`; the last uses keys such as `Counter@1`. The same resource cannot be imported and removed in one transaction. Unknown fields, additional providers, duplicate identities and unsupported definitions are rejected. Connections are configured separately; referenced OPC connections must exist before import. Configuration limits are 1,000 expanded tags, 128 definition versions, 128 instances, 128 members per definition and 32 scan groups.

Legacy version-1 files remain accepted. Existing `tags.json` arrays are read without altering the file; the next successful mutation saves a version-2 envelope. Tags and all model metadata are written together by atomic file replacement. Preview is read-only. Exports include configured memory values and persisted instance value overrides. `.sparkproj` exports do not contain gateway tag resources; keep the setup instructions with the project.

## Workshop: one definition, two units

The independently authored `examples/unit-model-workshop.json` fixture and `tools/load-unit-model-example.mjs` loader use synthetic memory and expression values only. This is a **gateway-setup-required** workshop, not a self-contained project package. Prerequisites: a disposable local SparkStudio gateway supporting version-2 tags, an administrator account and the enabled default provider. No equipment connection or device command is used.

From the source checkout, set `SPARKSTUDIO_ADMIN_AUTH_FILE` to a protected local JSON credential file, then run:

```powershell
node tools/load-unit-model-example.mjs http://127.0.0.1:5091
```

The loader creates `WorkshopCounter@1`, `WorkshopRefresh`, West/East instances and a draft project. It refuses reserved-name collisions. Publish the project explicitly in Designer, or add `--publish` when deliberately requesting publication. West displays 50% (8/16); East displays 75% (9/12).

Create definition version 2 from version 1 and change the Completed default to 10. Upgrade West only. Its Goal override remains 16 and its progress becomes 62.5%; East stays pinned to version 1 at 75%. Disable/re-enable `WorkshopRefresh`: both expression tags become unavailable/recover while the stored counts remain intact. Try removing Goal from a new version and upgrading West: its retained Goal override creates a conflict, and apply remains unavailable. Export the tag model, preview it again and inspect its pinned versions and overrides. Project package import remains unpublished until explicitly published; re-export preserves its screens while gateway setup remains separate.

Run `node tools/test-tag-model.mjs` for temporary-fixture validation of migration, version pinning, atomic conflicts, runtime quality/timestamps, restart, and workshop project export/import/publication/re-export. No live gateway is contacted.
