# UNS models

**Status: implemented in source, October 4, 2026; not yet published as a release.** This page specifies the current model contract. Follow the [UNS setup walkthrough](UNS_MODEL_SETUP.md) for the two-machine example, or [tag models](TAG_MODELS.md) and [tag engineering](TAG_ENGINEERING.md) for the underlying tag workflow.

SparkStudio ingests data from OPC UA, Modbus TCP, EtherNet/IP, S7, ADS, MQTT, MTConnect and i3X into stable saved points and `[default]` tags. The model provides typed assets, ISA-95 hierarchy, metadata, parameters, composition and references to already ingested tags. Operators and Designer screens can browse the same assets as objects and bind their ordinary member tag paths.

Models live in their own workspace, with object-shaped reads and Designer bindings. [Model operations](UNS_MODEL_OPERATIONS.md) adds validity rules, alarm templates, source profiles, version impact, dependency export and starters. [MQTT publishing](MODEL_PUBLISHING.md) uses the same model index for explicitly enabled outbound delivery. An i3X server and DIME hand-off remain deferred.

## Problem

The model addresses these authoring and runtime needs:

| Need | Model support |
| --- | --- |
| Meaningful values | Units, descriptions, ranges and asset metadata explain each member. |
| Repeated machines | Typed parameters avoid hand-writing the same source overrides for every member. |
| Reuse of acquired data | References map MQTT, MTConnect and other source tags into a curated namespace without another acquisition. |
| Reusable subassemblies | Composition lets a CNC reuse a pinned Spindle type. |
| Governed hierarchy | Enterprise/Site/Area/Line/Cell nodes can be declared and validated. |
| Reusable faceplates | Object reads and typed instance parameters let a template bind to a complete asset. |

## Design principles

1. **One concept.** Users work with one UDT/type model for reusable assets.
2. **Expansion stays flat.** `TagModel.Expand` continues to produce ordinary concrete tags. History, alarm evaluation, tag-read scopes, Equipment Commands and Designer bindings use expanded paths. Field contracts annotate quality in the tag engine; model alarm templates feed the existing alarm engine.
3. **Preview, then apply.** Every model mutation keeps the existing read-only preview, conflict report, revision token and atomic `tags.json` replacement.
4. **Explicit identity.** The instance path is the UNS address. Types, versions and parameters are pinned and visible. Nothing is inferred silently from source names.
5. **One current schema.** Import, export and storage use the same tag model. Older tag formats are rejected rather than converted or offered as alternate exports.

## Concepts

| Concept | Meaning |
| --- | --- |
| **Type** | A versioned UDT definition with metadata, declared parameters and members. Saved versions remain immutable. |
| **Member** | An attribute of a type. Kinds: `memory`, `expression`, `opcua`, `device`, `reference` and `type`. |
| **Reference member** | Mirrors an existing concrete tag's value, quality and timestamps without acquiring it again. |
| **Type member** | Nests another pinned type (composition), for example `Spindle` inside `CNC`. |
| **Parameter** | A typed instance argument substituted into member source fields, such as `{PLC}`, `{Device}` or `{Topic}`. |
| **Hierarchy node** | A declared folder with an ISA-95 level and metadata, such as `[default]Acme/Dallas/Machining/Line1`. |
| **Instance** | A type version placed at a concrete path, with parameter values and member overrides. |
| **Model index** | A derived, read-only index of nodes, instances, types and member metadata, rebuilt with each tag-configuration generation. |

## Current format

The current envelope contains the complete tag model, including hierarchy and type declarations. Its internal `version: 3` identifier identifies this schema; there is no user-selectable export version or tag-format migration path. Type definition versions such as `CNC@1` and `CNC@2` are separate asset revisions and remain supported.

```json
{
  "format": "sparkstudio.tags",
  "version": 3,
  "provider": { "name": "default", "enabled": true },
  "tags": [],
  "scanGroups": [{ "name": "Fast", "publishingIntervalMs": 500 }],
  "hierarchy": [
    { "path": "[default]Acme", "level": "Enterprise", "description": "Acme Manufacturing" },
    { "path": "[default]Acme/Dallas", "level": "Site" },
    { "path": "[default]Acme/Dallas/Machining", "level": "Area" },
    { "path": "[default]Acme/Dallas/Machining/Line1", "level": "Line", "attributes": { "costCenter": "4410" } }
  ],
  "udtDefinitions": [
    {
      "id": "Spindle", "version": 1,
      "description": "Machine spindle",
      "parameters": [{ "name": "Device", "type": "String", "required": true }],
      "members": [
        { "path": "Speed", "kind": "reference", "dataType": "Double", "target": "[default]Sources/MTConnect/{Device}/Sspeed",
          "unit": "rev/min", "description": "Actual spindle speed", "range": { "low": 0, "high": 12000 } },
        { "path": "Load", "kind": "reference", "dataType": "Double", "target": "[default]Sources/MTConnect/{Device}/Sload", "unit": "%" }
      ]
    },
    {
      "id": "CNC", "version": 1,
      "description": "3-axis CNC machining center",
      "semanticType": "isa95:WorkUnit",
      "parameters": [
        { "name": "Device", "type": "String", "required": true },
        { "name": "IdealCycleSeconds", "type": "Double", "default": 60 }
      ],
      "members": [
        { "path": "Execution", "kind": "reference", "dataType": "String", "target": "[default]Sources/MTConnect/{Device}/execution" },
        { "path": "PartCount", "kind": "reference", "dataType": "Int64", "target": "[default]Sources/MTConnect/{Device}/PartCountAct", "unit": "count" },
        { "path": "IdealCycle", "kind": "memory", "dataType": "Double", "value": "{IdealCycleSeconds}", "unit": "s" },
        { "path": "Spindle", "kind": "type", "definitionId": "Spindle", "version": 1, "parameters": { "Device": "{Device}" } },
        { "path": "Running", "kind": "expression", "dataType": "Boolean", "expression": "execution == \"ACTIVE\"", "inputs": { "execution": "./Execution" } }
      ]
    }
  ],
  "instances": [
    { "path": "[default]Acme/Dallas/Machining/Line1/CNC01", "definitionId": "CNC", "version": 1,
      "parameters": { "Device": "Haas01", "IdealCycleSeconds": 42 }, "overrides": {} }
  ]
}
```

Expanding `CNC01` produces ordinary concrete tags, including `[default]Acme/Dallas/Machining/Line1/CNC01/Spindle/Speed`. Each generated tag records `udtInstance`, `udtDefinition`, `udtVersion` and `udtMember` as it does today. Two new fields are added: `modelPath` (the nested member path, here `Spindle/Speed`) and the resolved member metadata.

### Metadata fields

Types accept `description`, `semanticType` (bounded free text), an absolute `semanticId` URI and `attributes` (up to 32 scalar values). Members also accept units, numeric `range`, `freshnessMs`, `enumValues` and `alarms`. Descriptive metadata does not alter values. Range, freshness and enum contracts annotate quality while preserving source quality and values; units never convert values automatically. `unitSystem: "ucum"` validates against the supported picker, while `custom` permits a display label. The exact fields and runtime behavior are specified in [model operations](UNS_MODEL_OPERATIONS.md#field-rules-and-units).

### Parameters

A parameter declares `name` (same syntax as other model names), `type` (`String`, `Double`, `Int64` or `Boolean`), optional `default` and `required`. Placeholders use the existing `{name}` syntax and rules from [tag parameter bindings](TAG_PARAMETER_BINDINGS.md): complete placeholders only, at most 16 per field, single-pass substitution and no recursive resolution.

Substitution is permitted only in these member fields: `connectionId`, `nodeId`, `target`, expression `inputs` values, a memory `value` (a whole-field placeholder converted to the member data type) and nested `type` member `parameters`. Member `path`, `dataType` and `kind` cannot be parameterized, so the shape of a type never depends on an instance. Substituted results must pass the same validators as hand-written values. Concrete paths still reject braces, so an unresolved placeholder cannot reach the engine.

Instance precedence is: explicit member override, then an optional selected source mapping profile, then parameter-substituted definition values/defaults. Profiles pin a model version and map its field paths to sources without changing its data contract. The preview shows the resolved fields; [source profiles](UNS_MODEL_OPERATIONS.md#source-mapping-profiles) define parameter resolution and validation.

### Reference members

A `reference` member names a concrete `target` tag path. It does not acquire anything. At runtime the engine publishes the target's current value and timestamps under the member path. The target quality becomes the member's source quality; the member's own contracts may further degrade its quality without changing the target. The member's `Source` is shown as `reference`.

Read access is checked against the reference's published member path, not against its target path a second time. A user allowed to read `[default]Acme/Line1/CNC01/Spindle/Speed` can therefore receive the target value even if `[default]Sources/MTConnect/Haas01/Sspeed` is outside that user's read scope. This is how a curated model exposes selected source values. Configuration administrators must deliberately review that exposure: Model and tag-import previews show each resulting reference path and its resolved target before Apply. Hiding a source path alone does not hide values already exposed through readable aliases.

Rules:

- The target must exist in the same expanded configuration at apply time, as expression inputs must today. Removing a referenced target is blocked with the same dependency conflict.
- `dataType` must equal the target's data type; there is no implicit coercion. To scale or convert a value, add an expression member that reads the reference through `./`.
- A reference may target another reference or an expression. Chains share the existing dependency graph, cycle detection and 64-level depth limit.
- References are read-only. Equipment Commands and Set tag value actions continue to target the concrete source tag. Writable references are an open question (see below).
- A disabled member, instance or provider produces `Bad_Disabled` as it does today. A target that becomes unavailable propagates its own quality.
- A reference consumes one tag in the 10,000-tag allowance but no acquisition, subscription watch or connector budget.

This is the "ingest once, model many" mechanism. MQTT automatic trees, MTConnect devices and PLC point maps keep their raw namespace under a source root, and the model presents curated views over them.

### Type members (composition)

A `type` member nests a pinned definition version at a relative path and passes it parameters. Nesting depth is limited to 4, matching the template nesting limit. Cycles (including through different versions) are rejected. Inside a nested type, `./` refers to the nested type's own members; an expression in the outer type can read `./Spindle/Speed`. Instance overrides address nested members by their full model path (`"Spindle/Speed": { ... }`).

Inheritance (`extends`) is not included. Composition covers the reuse cases without making version pinning ambiguous; see open questions.

### Hierarchy

`hierarchy` declares up to 2,048 nodes. Each node has a concrete `path`, a `level`, and optional `description` and `attributes`. Levels are `Enterprise`, `Site`, `Area`, `Line`, `Cell`, `WorkCenter` and `Custom`. A node's parent must be either undeclared (a plain folder) or a node at a strictly higher level; `Custom` may appear at any depth.

Instances and direct tags may live anywhere, as they do today. In the model view, an instance under a declared node is shown as an asset of that node. An optional provider setting, `"requireDeclaredHierarchy": true`, makes it an error to place an instance outside a declared node. This lets an administrator enforce a governed namespace once the plant structure is settled.

Hierarchy nodes do not create tags and do not consume the tag allowance.

### Limits

| Resource | Limit |
| --- | --- |
| Expanded tags (all kinds) | 10,000; raising it is a separate load-test gate |
| Definition versions | 256 |
| Members per definition, not counting nested members | 128 |
| Parameters per definition | 32 |
| Nesting depth | 4 |
| Instances | 2,000 |
| Hierarchy nodes | 2,048 |
| Import file / request | 32 MiB |

The instance increase is needed for UNS use and must be qualified with [load testing](LOAD_TESTING.md) of expansion time, preview size and memory before it ships. Expansion runs on every configuration generation, so the target is under 250 ms for 2,000 instances totaling 10,000 tags on the reference machine.

## Model index and read API

After each successful expansion, the gateway builds an immutable model index for that configuration generation. It holds the hierarchy nodes, instances with their pinned type and parameters, the nested member tree with metadata, and the concrete tag path behind every member. Runtime values stay in the tag engine; the index holds no values.

New engineering and operator routes, under `/api` and project API scopes:

| Route | Returns |
| --- | --- |
| `GET /model/types` | Type versions with parameters, members, metadata and nesting. |
| `GET /model/tree?path=&depth=` | Bounded page of hierarchy nodes, folders and instances below a path, with level and type. |
| `GET /model/instances?type=CNC&version=&under=` | Instances of a type, optionally below a hierarchy path. |
| `GET /model/object?path=` | One instance as an object: metadata plus a nested member tree, with the current value, quality and timestamps of each leaf. |

All read routes apply the caller's existing tag-read scopes to the expanded concrete paths. Members outside the caller's scope are omitted from `object` and counted in a `restrictedMembers` field. The response therefore never discloses their values, but the caller can see that the object is incomplete. Instances whose members are all unreadable are omitted from `tree` and `instances`. Configuration routes keep the existing Configuration capability and CSRF checks.

For a reference, the expanded member path is the authorization boundary; target-path permission is not additionally required. These read routes omit source configuration such as reference targets. The configuration-only review remains the place to inspect which underlying values an alias publishes.

Runtime leaves expose `timestamp`, `sourceTimestamp` and `receiptTimestamp`. `timestamp` is the ordinary tag engine's effective value timestamp; source ingestion may use a source timestamp or fall back to receipt time. `sourceTimestamp` is the optional original source time where the acquisition path supplies it. `receiptTimestamp` is the optional gateway ingestion time, not the time the model API was read or a universal device-server time. Missing timestamp metadata stays null. Reference members preserve their target's timestamp fields. No `serverTimestamp` alias is returned.

Partially readable instances return an empty `parameters` map and `parameterValuesRestricted: true`, because parameters can contain values used by hidden members. Operator type projections omit parameter defaults and nested parameter arguments. Engineering type reads retain the complete declarations. Int64 values outside JavaScript's safe integer range use canonical decimal strings in exports, previews and model read responses, preserving their exact value across browser edits and imports.

The operator tag event stream is unchanged; object views are assembled in the browser from the index plus ordinary tag deltas. This avoids a second streaming protocol and keeps the 32-stream bound meaningful.

## Inside SparkStudio

### Models workspace

**Models** is its own item in the workspace's left navigation, alongside **Tags** and **Designer**. Modeling is not nested under Tags, and Gateway Settings has no duplicate tag or model editor. The [workspace contract](UNS_MODEL_WORKSPACE.md) describes its layout and behavior:

1. **Build models.** Three guided panels—**Choose data**, **Build a model** and **Add equipment**—combine the source library, reusable definition and equipment rows in one draft. A model is a recipe (a type); a field is a member; equipment is an instance. Drag tags, folders or existing models into the builder. Parameters let each machine use its own data. Details expose metadata, source settings and individual overrides.
2. **Organize.** A **Locations** tree shows the hierarchy. **Add location** creates a site, area, line or other declared node. Move equipment with drag and drop or the equivalent selection action; **Open in builder** returns to its model.
3. **Settings.** Shared scan groups and provider controls use the same draft as the other views.
4. **One review.** **Bulk actions → Paste spreadsheet rows** accepts CSV with `path,definitionId,version,<parameter...>` for up to 2,000 instances. Types, equipment, locations and settings can be reviewed and applied together. Review reports collisions, missing targets, type mismatches and capacity; Apply commits atomically. Selective upgrades use the same review.

### Model from source

From a browsed connection (MQTT topic subtree, MTConnect device or i3X object), **Create type from selection** proposes a type whose members are `reference` members to the selected tags. It proposes member names, data types and units where the source provides them; the MTConnect `units` attribute and i3X type metadata are carried over. Device-specific path segments are replaced with a suggested parameter. The user reviews and edits the draft in the type editor before it is applied. Nothing is created without the normal preview and apply. This turns the existing reviewed import into a modeling step and is the main DataOps workflow.

### Designer

- The Designer tag browser gains a **Model** view beside the raw tag tree. It shows hierarchy, instances and members with units and descriptions. Choosing a member inserts its ordinary concrete path, so every existing binding type works unchanged.
- A template parameter can declare type **Model instance** with a required type ID and an optional version range. The parameter's value is an instance path. Its picker lists only matching instances the designer can read. Bindings inside the template use the existing indirect form `{machine}/Spindle/Speed`. The Designer validates each binding's relative member path against the declared type and reports missing members after a type upgrade.
- **Create faceplate from type** generates a starter template with one labeled value per leaf member, showing its unit and quality. Generation requires an instance with 1–500 leaves and read access to every member; larger instances are rejected rather than truncated, matching the existing 500-component template limit. It is a scaffold for authors to restyle, not a maintained generated artifact.

### Ask Spark

Read-only tools expose types, the namespace tree, instances and object reads using the caller's normal scopes. The drafting tool proposes a type or a bulk-instance CSV for user review in the Model workspace. Ask Spark never applies model changes directly, consistent with its reviewed-change rule.

## History, alarms and permissions

Expanded member paths are ordinary tags, so history items, alarm conditions, tag-read scopes and Equipment Commands can target them. Types include numeric alarm templates with equipment overrides; the expanded model alarm limit is 2,000. Existing alarm acknowledgement and journaling are reused. Automatic historian defaults are still a follow-on proposal. [Model operations](UNS_MODEL_OPERATIONS.md#alarm-defaults) explains template behavior and limits.

Model reads use existing tag-read scopes. There is no separate model permission. Engineering reads require Design; operator reads require View and filter every leaf through the project's tag prefixes. Configuring types, hierarchy and instances keeps the Configuration capability, with separate configuration-scoped value and definition endpoints for that workspace.

## Storage and compatibility

- Tag storage and import accept only the current schema. Flat arrays and earlier envelopes are rejected without rewriting their bytes; no automatic tag migration is performed.
- **Export saved model** and **Export configured tags** write the same complete schema through `/tag-engineering/export`. Selective bundles additionally package the authored dependency closure through `/model/export`, with an explicit external-dependency manifest. There is no old-format selector.
- Scheduled configuration backups and offline recovery carry the current file unchanged. Use the matching gateway build for restoration; earlier tag formats and incompatible gateway data markers are rejected. See [gateway recovery](GATEWAY_RECOVERY.md).
- `.sparkproj` packages still exclude gateway tag resources. A template with a Model instance parameter records its required type ID and version range. Importing it into a gateway without that type succeeds but reports unresolved model requirements in Designer diagnostics.

## Implementation and verification

| Area | Scope | Acceptance coverage |
| --- | --- | --- |
| Format and expansion | Current-schema parsing, metadata, typed parameters, references and nested types, hierarchy validation, limits and model index. | Regression suites cover format rejection, parameter precedence, reference quality/timestamps/Int64, dependency validation, composition limits, immutable versions, stale previews and 2,000-instance/10,000-tag expansion. |
| Read API and scopes | `/model/*` routes with scope filtering and pagination. | `ModelReadChecks` and real loopback `ModelReadApiChecks` cover partial/full denial, `restrictedMembers`, project scopes, operator/engineering sessions, index isolation and live value reads. |
| Model workspace | Namespace tree, type and instance editors, bulk CSV, source-to-type drafts. | `check-model-workspace.mjs`, source connection checks and `test-uns-model-workshop.mjs`; the authored setup workshop ingests two MTConnect machines and optionally an MQTT sensor. |
| Designer and Ask Spark | Model browser and binding picker, Model instance parameters, diagnostics, faceplate scaffold, scoped read tools and user-reviewed drafts. | `check-designer-model.mjs`, template authoring/package checks and Ask Spark adapter checks. One portable faceplate binds two machines; the selective version upgrade deliberately removes a member. |

All areas ship together after the mandatory build gates and the end-to-end workflow pass. A subsequent release follows the [release process](RELEASE_PROCESS.md). The [verification ledger](PARITY.md) distinguishes source verification from published release evidence.

## Publishing and remaining outbound work

The model index is the source for outbound presentation:

- **MQTT UNS publisher.** Implemented as a separate, explicitly enabled gateway service with per-equipment JSON or leaf topics, interval/on-change capture, retained values, QoS 0/1, durable bounded queues and diagnostics. Existing MQTT source connections remain read-only. See [model MQTT publishing](MODEL_PUBLISHING.md). Sparkplug B and separate retained metadata topics remain future work.
- **i3X server.** Exposes types, objects, relationships, values and subscriptions through i3X 1.0. The hierarchy maps to relationships and types map to object types.
- **DIME hand-off.** Publishes the indexed model and value changes into DIME as the data-in-motion layer.

Publishing is a separate configuration capability because it delivers data outside the gateway. An i3X server and DIME hand-off are not included in the current implementation.

## Open questions

1. **Writable references.** Should a reference member forward reviewed writes to its target (only through Equipment Commands, with the target's own write permission)? Forwarding is convenient for faceplates but adds a second address for the same command.
2. **Inheritance.** Is `extends` needed in practice once composition and parameters exist? The risk is version pinning ambiguity when a base type changes.
3. **Semantic vocabulary.** `semanticType` currently remains bounded free text. A shipped vocabulary could be added without changing existing values.
4. **Source roots.** The walkthrough recommends raw sources under `[default]Sources/<connection>/…` and curated assets under the hierarchy. Source-to-type drafts accept any valid existing tag location; this convention is not enforced.
5. **Tag ceiling.** Is 10,000 expanded tags enough for first UNS customers, or should a separately qualified increment to 50,000 follow?
