# Model quality, mappings and operations

This specification extends the [model contract](UNS_MODEL.md) and [Models workspace](UNS_MODEL_WORKSPACE.md). It describes the current source implementation; [the verification ledger](PARITY.md) records which build and runtime checks have completed. Use a matching gateway build. These additions do not convert old tag formats or automatically upgrade equipment versions.

## Workflow and acceptance

| Action | User outcome | Acceptance requirement |
| --- | --- | --- |
| Define field rules | A model describes acceptable data, not just its display | Range, enum and freshness violations preserve the value and source quality |
| Inspect Issues | Find broken or late data without confusing it with a process alarm | Read permissions filter each member and configuration details remain protected |
| Reuse alarms | Each equipment instance receives the model's alarm defaults | Existing alarm state, acknowledgement and journal work; overrides do not duplicate alarms |
| Review versions | Understand affected equipment before upgrading | Compatible/breaking classification is advisory; existing preview/apply validates the final draft |
| Map sources | Reuse one field contract across different sources | Profiles precede equipment overrides and parameter substitution; invalid references fail review |
| Publish | Deliver modeled data to an MQTT broker | Preview makes no connection; enabled publishers queue durably and expose delivery failures |
| Trace and export | Move selected models and their authored dependencies | Nested models, referenced equipment/tags, mappings, locations and update groups remain connected |
| Start from examples | Learn with synthetic equipment before connecting a machine | Starters enter the draft and require review; none connects to a controller |

All model edits share the existing draft, undo/redo, review and Apply. A saved model version remains immutable. Publisher configuration is a separate gateway service with its own revision check, save and explicit enable control. Saving a publisher does not apply a model draft.

In **Models > Inspect & share**, tools are grouped by purpose: **Check** contains Live object and Data issues; **Manage** contains Versions, Source mappings and Dependencies; **Share** contains Publish MQTT and Export selection. The builder toolbar and first-use welcome offer **Use a starter**. The dismissible builder checklist opens the actual fields, equipment, source details, review and live inspector rather than a separate slideshow.

Equipment status distinguishes **Needs setup**, **Waiting for data**, **Data issue** and **Ready**. Unapplied or disabled equipment cannot be Ready; matching saved equipment needs Good samples for every enabled field. An issue row opens the inspector filtered to that equipment. Human issue names, original values and expected values are visible first; full paths and quality codes remain under **Technical details**.

## Field rules and units

Leaf members, authored tags and equipment member overrides accept these properties:

| Property | Contract |
| --- | --- |
| `range` | Finite numeric `low` and `high`, inclusive, with low <= high. A violation flags quality; it does not clamp the value. |
| `freshnessMs` | Integer 0–86,400,000. Zero disables the rule. Time since the most recent received sample, including a new sample with the same value. |
| `enumValues` | Up to 128 unique values matching a String or integer data type. An empty list disables an inherited enum rule. This constrains the existing scalar type; it does not create a new wire type. |
| `unitSystem` | `ucum` validates against the supported unit picker; `custom` retains an unvalidated display unit. Omission has custom-unit semantics. |
| `unit` | Display/semantic unit. Choosing a unit never converts the value. |
| `semanticId` | Absolute URI, at most 2,048 characters, on a model or member. It is an identifier, not a URL the gateway fetches. |
| `alarms` | Up to 16 numeric alarm templates per field; an equipment override replaces this list. |

The unit picker is a deliberately bounded set of common [UCUM units](https://ucum.org/ucum), including `%`, `Cel`, `kPa`, `L/min` and `/min`. It is not a validator for every possible UCUM expression. Custom units remain clearly labeled. String/integer enum values preserve the field's exact type; large Int64 values use the existing exact decimal-string browser representation.

Runtime values expose `quality`, `sourceQuality` and model issue details. A Good source with a violated rule becomes `Uncertain_ModelValidation`, or `Uncertain_ModelStale` when freshness is violated. Existing Bad or Uncertain source quality remains at least as severe. The original source tag is never rewritten when a reference member applies a different contract. Two models can therefore apply different limits to the same acquired value. Reference chains retain the quality of their immediate source.

Modeled samples must also match the declared scalar type. Nonfinite numeric samples such as `NaN`, or a value with the wrong scalar type, produce an `invalidType` issue while preserving the received value and source quality.

Freshness is driven by receipt time, not a changing value or a possibly skewed device clock. A quiet subscription that supplies no samples can become stale even if its last value is correct; set the deadline to match the actual acquisition/reporting policy. Disabled or waiting-for-first-data states are not converted into healthy values. The periodic engine evaluation detects stale values even when no new data arrives.

**Example:** a Press Load range of 0–100% flags 120% as a data issue. A separate high alarm at 80% can signal that a valid 91% reading needs attention. Alarm thresholds and data validity are separate settings.

## Alarm defaults

Each template has `id`, `name`, `enabled`, `mode` (`high`, `low` or `equal`), `setpoint`, `deadband`, `priority`, and an optional `message`. Existing numeric alarm validation applies. Stable generated identities combine the equipment member path and template ID; expanding the model does not create a second alarm engine. Acknowledgements, active state, deadband and the alarm journal use the existing process-data service.

Edit alarm defaults in a new model version and explicitly upgrade selected equipment. Equipment can replace its member alarm list, including an empty list to suppress the defaults. Expanded model alarms are limited to 2,000, separately from the existing 2,000 manual alarm limit. Alarms on invalid data follow the existing engine's quality behavior rather than inventing process state from an uncertain reading. Automatic historian templates and notification routing are separate features, not implied by model alarm templates.

The ordinary field drawer shows name, source, type, unit and description first. Open **Quality rules** for range, allowed values and freshness; **Process alarms** for alarm defaults; **Advanced metadata** for semantic identifiers, attributes and the unit standard; and **Sampling options** for applicable scan settings. These disclosures preserve all existing contract settings.

## Source mapping profiles

`mappingProfiles` is a model-package collection, limited to 256 profiles. Each profile pins one model definition/version, has a unique `id`, optional description, and 1–128 bindings keyed by relative leaf path. An equipment instance chooses `mappingProfileId`. Profiles are editable gateway configuration; their updates appear in the same review as every affected expanded member.

```json
{
  "id": "PressFromTags",
  "definitionId": "Press",
  "version": 1,
  "bindings": {
    "Load": { "kind": "reference", "target": "[default]EquipmentDemo/{Device}/Load" },
    "State": { "kind": "reference", "target": "[default]EquipmentDemo/{Device}/State" }
  }
}
```

`Device` must be a declared model parameter and supplied by each equipment entry. A root parameter such as `{SourceRoot}/Load` is also supported. A profile may replace memory placeholders with references, OPC UA, saved device points, memory values or expressions. It changes source fields while preserving the model's declared data type, units and validity rules. Bindings to nested model leaves use their complete relative paths. Profile parameters refer to the root model's declarations.

Resolution order is **model definition → selected source profile → equipment member overrides → ordinary expansion/validation**. Profile parameters are resolved against the root equipment arguments; nested model parameters retain their existing behavior. A profile cannot silently change a field's declared type. Missing profiles, wrong version assignments, removed fields and incompatible sources block preview/apply. If upgrading equipment, select or create a profile pinned to the destination version in the same draft.

Live object preview reads saved equipment. Unsaved mappings must first pass review and Apply before they affect live values. This keeps a preview from silently acquiring data or changing runtime configuration.

## Version impact

Comparison reports added/removed fields, field-source and contract changes, parameter changes, nested composition changes, current equipment usage and detectable project references. Changes that remove paths, narrow validity, alter source behavior, change nested pins or require new parameters are conservatively classified as breaking. Added fields and widened validity are compatible with the existing field structure.

Compatibility is guidance, not permission to upgrade automatically. An added enum value can still require a consumer with an exhaustive state list to be updated. Alarm/freshness changes are treated as behavior changes. Review the expanded result and any overrides for the selected equipment. There is no floating-minor or silent upgrade policy.

The upgrade table names the equipment, displays the old and new version, shows the current source mapping and requires a valid destination-version mapping when the previous mapping cannot be retained. Only selected equipment is staged. Parameter values and per-equipment overrides remain in the combined draft for review.

## Dependencies and selective export

The dependency view traces saved connections → points → tags, source references, type composition, equipment and detectable screen/template/script/query references. It reports missing sources and unused connections/types. Searches inspect literal saved references; dynamically constructed paths or arbitrary script logic cannot be proven complete. Draft and published screens are distinguished. Project resources are included only when the current user has access to their design configuration. Results are bounded and explicitly indicate truncation.

Select model versions and/or equipment to export. The authored dependency closure includes nested types, selected and referenced equipment, authored source tags, source mappings, required scan groups and declared ancestor locations. A type-only export does not invent parameter values or add every equipment instance. The export deliberately omits provider-wide settings so importing a model does not pause or reconfigure the destination provider.

Connection credentials and discovery-owned tags are not converted into authored tags. The bundle reports these external dependencies with identifiers and setup instructions. Configure/map the destination sources before Apply; the ordinary authoritative import review rejects unresolved dependencies. Disabling source-tag inclusion makes the omitted source paths explicit in that manifest. These are gateway setup bundles, not `.sparkproj` application packages.

Importing a bundle merges its model package into the draft and shows dependencies before the normal review. Saved type versions retain immutable conflict handling: rename a conflicting model or create a new version rather than replacing a saved definition. Equipment and mapping changes remain visible updates in the review.

## Starters and guided practice

The built-in Motor, Pump, Press and OEE starters are independently authored teaching examples. They do not copy another product's templates or claim CESMII/AAS certification. Their default memory values are synthetic; the OEE example calculates percentage Availability × Performance × Quality / 10,000 and requires inputs representing the same interval.

1. Open Models, choose a starter, and add it to the draft under a unique model name.
2. Inspect field types, units, limits and the Press example alarm. Adjust defaults to the intended equipment.
3. Add disposable equipment and review/apply. Inspect its live object.
4. Use a saved synthetic source tag and a source mapping to test quality rules. Send a value outside the range, observe Issues, and then restore a valid value.
5. Create a new model version, inspect compatibility and affected equipment, and stage a selective upgrade. Review before applying.
6. Trace dependencies and export that equipment. Inspect the external-dependency list before importing on another disposable gateway.
7. Follow [model MQTT publishing](MODEL_PUBLISHING.md) with a local test broker. Preview the exact topics and payloads before enabling delivery.

## API surface

All paths have the `/api` prefix. Existing model read and management routes also have project aliases. MQTT publisher configuration is gateway-global.

| Route | Purpose and authorization |
| --- | --- |
| `GET /model/units` | Supported unit choices; model-read permission |
| `GET /model/issues` | Paginated member issues, filtered by tag-read scope |
| `POST /model/versions/compare` | Proposed definition, optional source version and proposed definitions for nested draft versions; Configuration |
| `GET /model/dependencies` | Optional type, instance and query filters; Configuration |
| `POST /model/export` | Selected definition keys/equipment paths and source-tag inclusion; Configuration |
| `GET /model/starters` | Read-only starter definitions and walkthroughs; Configuration |
| `/model/publishing/*` | Explicit gateway MQTT publisher configuration, preview and diagnostics; Configuration |

Model mutations continue through `/tag-engineering/preview` and `/tag-engineering/apply`, including the new `mappingProfiles` and `removeMappingProfiles` fields. The normal configuration audit, CSRF protection and stale-preview checks remain in force.
