# UNS model setup and reusable CNC faceplates

Use this workshop to turn two synthetic MTConnect machines into one reusable model, then show both machines with the same Designer faceplate. Start in **Models**, its own item in the workspace's left navigation. The model uses tags you already have; it does not create another connection to either machine. An optional MQTT exercise uses the same approach.

## Find your way around

Use **Tags** for individual data values and **Models** to group those values into something useful, such as a press or a CNC machine. Models has three views: **Build models**, **Organize** and **Settings**. It is separate from Tags and from Gateway Settings.

| On screen | What it means |
| --- | --- |
| Connection | How the gateway reaches a device or service, such as a PLC or an MQTT broker. |
| Source point | Where and how to read one value through that connection, such as a register, symbol or source item. |
| Tag | A named value the gateway makes available to screens, calculations and other features. A source tag reads a source point; manual (memory) and calculation (expression) tags do not need one. |
| Model | A reusable recipe for a machine: which values it needs and how to find them. Technical details and exports call this a type. |
| Field | One value in that recipe, such as Speed or Load. Technical details call it a member. |
| Equipment | A real or example machine that uses the model. It is an instance of that model. |
| Parameter | A fill-in value that changes for each machine, such as `Device = Press01`. |
| Location | Where equipment belongs, such as a site, area or line. Locations form the hierarchy. |

For example: a connection reaches Press01, a source point reads its speed, and the tag `[default]EquipmentDemo/Press01/Speed` gives that value a usable name. A model's Speed field can reference that tag. Reusing the field does not create another device connection or read the source twice.

Start with **Use a starter** or **Use my data**. Use the toolbar to choose your model and version, then **Define fields → Connect machines**. The setup guide links to the next useful action and can be hidden. Then use **Organize** to place equipment in locations and **Review changes** to check everything before saving it. These steps share one draft, so you can move between them without saving half-finished work. If this is your first model, the [three-press exercise](#8-drag-a-folder-to-build-three-press-instances) uses ordinary memory tags and needs no source server.

This guide requires a build containing the current UNS tag model and Model instance template parameters. Windows `v0.2.0-preview.13` and Docker `v0.2.0-preview.13-docker.1` predate this feature. Use the recipes from the same source build as the gateway; older tag package formats are not supported. The workflow below describes the authored exercise, not evidence of qualification against physical controllers.

## What you will create

| Resource | Result |
| --- | --- |
| Raw source tags | Eight read-only MTConnect tags: four per machine |
| Types | `Spindle@1` nested inside `CNC@1` |
| Hierarchy | Enterprise → Site → Area → Line |
| Instances | `[default]Acme/Dallas/Machining/Line1/CNC01` and `CNC02` |
| Expanded model | Six ordinary tags per CNC, including `Spindle/Speed` and `Spindle/Load` |
| Designer | One CNC faceplate template placed twice, using a `machine` parameter |
| Upgrade exercise | New `Spindle@2` and `CNC@2`; upgrade only CNC01 and inspect a missing-member diagnostic |

The initial exercise adds 20 tags: eight raw source tags and twelve model members. Existing gateway tags count separately. Hierarchy nodes and type definitions consume no tags.

The source checkout contains two independently authored examples:

- [UNS model recipe](../../examples/uns-model.json) contains source settings, tag/model recipes, CSV and an upgrade recipe. It is **setup-required** and is not itself an importable tag package.
- [UNS faceplate project](../../examples/uns-faceplates.json) is packaged as `uns-faceplates.sparkproj` in workshop bundles. It contains only the project and template. It is portable: import, explicit publication and re-export do not install connections, gateway types or tags. Live values need the separate setup below; a missing model produces diagnostics and unavailable values.

Use an isolated development gateway and engineering access with Configuration permission. The example type IDs and paths must be unused or belong to your own workshop. Operators need read scope for `[default]Acme/Dallas/Machining/Line1/`. The exercise includes no equipment commands, source writes, passwords or production data.

## 1. Start the synthetic sources

From the source checkout:

```powershell
node tools/run-data-source-simulators.mjs --uns
```

Keep that process running. UNS mode adds two devices, Haas01 and Haas02, to the loopback MTConnect agent at `http://127.0.0.1:5310`. It also publishes optional temperature topics on the loopback MQTT broker at `mqtt://127.0.0.1:18890`. The existing source-workshop fixtures remain available.

These addresses work when the gateway runs on the same host. In Docker, `127.0.0.1` means the container itself. Configure a reachable fixture endpoint for your deployment; do not expose the unauthenticated lab fixtures to an untrusted network. The MQTT exercise uses scalar payloads with no extraction or timestamp/sequence expressions, so it does not require a source-script worker.

## 2. Ingest each machine once

In **Gateway Settings → Data → Connections**, create an MTConnect connection named **UNS MTConnect**:

| Setting | Value |
| --- | --- |
| Agent URL | `http://127.0.0.1:5310` |
| Authentication | None |
| Acquisition | Poll |
| Interval | 1000 ms |

Save, test, and browse the agent. Exclude the Agent device. Select the four points for Haas01, then repeat for Haas02. Review the source point-and-tag import and set the resulting paths exactly as below. Imported IDs can differ from names; the model references the concrete **tag paths**, not point IDs.

| Source address for Haas01 | Raw tag path | Data type |
| --- | --- | --- |
| `Haas01/Haas01-Sspeed` | `[default]Sources/MTConnect/Haas01/Sspeed` | Double |
| `Haas01/Haas01-Sload` | `[default]Sources/MTConnect/Haas01/Sload` | Double |
| `Haas01/Haas01-execution` | `[default]Sources/MTConnect/Haas01/execution` | String |
| `Haas01/Haas01-PartCountAct` | `[default]Sources/MTConnect/Haas01/PartCountAct` | Int64 |

For the second machine, replace both occurrences of `Haas01` in the source address and the one in the tag path with `Haas02`. Keep the same four data types. A reference requires an exact type match; Double and Int64 are not interchangeable.

Apply the reviewed import, then open **Tags** in the workspace's left navigation. Expect eight updating values with Good quality after acquisition. If a model preview later says a target is missing, check these paths first.

For an API-assisted setup, `sourceRecipes[0]` in the authored example specifies deterministic saved point IDs. `sourceTagRecipe` assumes those IDs and contains the marker `REPLACE_WITH_SAVED_MTCONNECT_CONNECTION_ID`; replace it with your saved connection ID before previewing. Do not import that recipe against different point IDs. The UI browse-and-review path does not need this marker.

## 3. Create types and hierarchy

Open **Models → Build models** from the workspace's left navigation. The **Define fields** and **Connect machines** steps share one draft with **Organize**, **Inspect & share** and **Settings**. Wide layouts also offer **Combined view**. Equipment shows **Needs setup** until its applicable draft is applied; **Ready** means saved configuration and Good live samples for every active field. Create the models, locations and equipment below, then use the header's **Review changes** and **Apply** once. Review shows what will change without saving it. Fix any conflicts before Apply; changing the draft or gateway configuration requires a new review.

The **Create type from selection** button in a saved connection's Browse section can start a draft from points already imported as tags. It opens Models with fields that read the selected tags and, where possible, a `SourceRoot` parameter. That draft remains editable. For this exercise, select Haas01 speed/load, name the model **Spindle**, name the fields **Speed** and **Load**, and replace the proposed parameter/targets with the definitions below. You can also choose **New model** in **Build models** and drag the two tags into it, or select each tag and choose **Add to model**.

Create **Spindle version 1**, with a required String parameter named `Device`:

| Member | Kind / type | Target | Metadata |
| --- | --- | --- | --- |
| Speed | reference / Double | `[default]Sources/MTConnect/{Device}/Sspeed` | Unit `rev/min`; range 0–12000; description Actual spindle speed |
| Load | reference / Double | `[default]Sources/MTConnect/{Device}/Sload` | Unit `%`; description Spindle load |

Leave Spindle in the draft. Choose **New model** to create **CNC version 1**, with required String `Device` and Double `IdealCycleSeconds` defaulting to `60`. Drag the draft Spindle version from the type library into CNC to create the nested member; the library also provides a keyboard-accessible nest button.

| Member | Configuration |
| --- | --- |
| Execution | reference / String → `[default]Sources/MTConnect/{Device}/execution` |
| PartCount | reference / Int64 → `[default]Sources/MTConnect/{Device}/PartCountAct`; unit `count` |
| IdealCycle | memory / Double; initial value `{IdealCycleSeconds}`; unit `s` |
| Spindle | type → Spindle version 1; nested Device parameter `{Device}` |
| Running | expression / Boolean; expression `execution == "ACTIVE"`; input named `execution` → `./Execution` |

Set CNC's description to a machining center and its optional semantic type to `isa95:WorkUnit`. A unit does not convert the value. A range does not clamp it, but an out-of-range reading is flagged by the model's quality rules. Switching between models preserves both drafts. For source profiles, alarms, validity rules and the starter library, continue with [model operations](UNS_MODEL_OPERATIONS.md).

In **Organize**, use **Add location** to create these four locations in the same draft:

| Path | Level |
| --- | --- |
| `[default]Acme` | Enterprise |
| `[default]Acme/Dallas` | Site |
| `[default]Acme/Dallas/Machining` | Area |
| `[default]Acme/Dallas/Machining/Line1` | Line |

Select a parent location before adding its child. The suggested kind follows Enterprise → Site → Area → Line → Cell → WorkCenter → Custom; the first root location starts as Enterprise. A Custom location uses the nearest ancestor with a standard kind to choose the next suggestion. You can change the kind when your layout needs it.

Edit **Location name**, then choose **Rename** or press **Enter** to commit it. Type only the name, such as `Dallas`, rather than the full `[default]Acme/Dallas` path. The name stays local while you type, so it cannot change another location. Rename moves that location and its child locations and equipment together, preserving their names and kinds. Empty names, path separators and collisions are rejected. Source tag paths and reference targets are not rewritten; because moved equipment has new model paths, review screen bindings and other references before applying.

For a repeatable alternative, use **Models → Import / export** to merge the example's nested `modelRecipe` into the draft. It supplies the same two model versions and four locations without equipment. Continue to the CSV step before Review. Do not paste the whole example wrapper. You can copy the nested object from an editor, or print it from the source checkout:

```powershell
node -e "const fs=require('node:fs'); const w=JSON.parse(fs.readFileSync('examples/uns-model.json','utf8')); process.stdout.write(JSON.stringify(w.modelRecipe,null,2));"
```

Import merges the specified resources; it does not delete other gateway resources. Saved type versions are immutable. If the same ID/version already exists with different content, use a new ID or version after reviewing the conflict.

## 4. Instantiate two CNCs from CSV

Return to **Build models**, select the draft CNC model, choose **Bulk actions → Paste spreadsheet rows** in **Add equipment** and paste:

```csv
path,definitionId,version,Device,IdealCycleSeconds
[default]Acme/Dallas/Machining/Line1/CNC01,CNC,1,Haas01,42
[default]Acme/Dallas/Machining/Line1/CNC02,CNC,1,Haas02,
```

The blank final cell for CNC02 uses the type's default of 60. Add the pasted rows to the draft, then choose **Review changes**. The combined review includes both types, all four hierarchy nodes and both instances. In **Reference targets after apply**, review each model path and its resolved raw target, along with parameter provenance and capacity, then choose **Apply**. A reference exposes the target value to readers of the model path even if they cannot read the raw path. As the configuration administrator, deliberately decide which source values this curated namespace should expose.

Both instances should have six leaf members. CNC01's IdealCycle is 42 and CNC02's is 60. Execution and Running should agree; Running changes with the fixture's ACTIVE/READY state. Speed, load and count should differ between the two machines. Their model references mirror their raw source values, quality and timestamps.

In **Add equipment**, open CNC01's details and expand **Advanced: customize fields for this equipment → IdealCycle**. Check the value override, enter 45, review and apply. An override changes this machine only: it takes precedence over the parameter value 42. Clear that override and apply again to restore 42. The authored `overrideRecipe` describes the same optional exercise.

Changing a type definition's source placeholders never changes member shape: paths, kinds and data types are fixed. Only permitted source fields and memory values accept declared parameters. Nested `Spindle` receives its own Device argument; `./` inside that type refers to its own members.

## 5. Bind the Designer

Import `uns-faceplates.sparkproj` from a workshop bundle as a new project. It contains one **CNC faceplate** template and two placements. The `machine` parameter is declared **Model instance**, requires type ID **CNC**, and accepts version 1 or later. The placements select CNC01 and CNC02 respectively.

To build a starter yourself:

1. In the Designer's **Tags** panel, switch **Raw tags → Model**.
2. Browse to CNC01. Inspect its members, units, descriptions and quality.
3. Choose **Create faceplate from type**. This creates an editable template with one ordinary value component per readable leaf. Each displays quality; units longer than the value widget's limit are preserved in its label.
4. Place the template twice on a screen. In the first placement's parameters select CNC01; in the second select CNC02. The instance picker offers readable instances matching the required type/version range.
5. Inspect a generated binding such as `{machine}/Spindle/Speed`. It resolves to an ordinary concrete tag path. Selecting a member directly in the Model browser or a binding's **Browse tags → Model** picker inserts its concrete path instead.

The generated template is a starting layout, not an automatically maintained view. Restyle it normally. Generation accepts 1–500 leaf members, matching the existing 500-component template limit, and requires read access to every member. Larger or partially readable instances are rejected rather than generating an incomplete faceplate. For a larger model, author smaller templates around the member groups you need.

Model requirements guide the instance picker and Designer diagnostics. They do not add a runtime type or version gate: manually entered or dynamically supplied instance paths are syntax-checked and resolve through ordinary tag bindings. Review **Project diagnostics → Model requirements** before publishing. Runtime tag-read permissions still apply, and missing members show unavailable values.

Use **Preview**, then explicitly **Publish** when satisfied. Open the operator application with the intended tag-read scope and check both machines. Model APIs and runtime tag reads check the model member paths. In this exercise, access to `[default]Acme/Dallas/Machining/Line1/` intentionally exposes the referenced values without requiring access to `[default]Sources/MTConnect/`. Members outside the model-path scope are omitted from scoped object reads. Review both source and alias scopes when deciding who can see a value.

Try importing this project into a gateway without the CNC model. Import should succeed. Open **Project diagnostics → Model requirements** to see the unresolved type requirement, rather than assuming the project package contains its gateway resources. Re-export retains `modelParameters` and indirect bindings; gateway types, tags and connections stay separate.

## 6. Upgrade only CNC01 and diagnose the result

In **Models → Build models**, select the saved `Spindle@1` chip and choose **Edit a new version**. The editor proposes the next version. Remove **Load**, retaining Speed, to draft **Spindle version 2**.

Use **Edit a new version** on `CNC@1` to create **CNC version 2**. Change its nested Spindle member to **Spindle version 2**, passing `Device` as before. Keep its other members unchanged. Alternatively, merge the authored `upgradeRecipe`, which adds both new versions, into the draft.

Creating these definitions upgrades **no equipment**. With `CNC@2` open in **Build models**, select **only CNC01** in **Add equipment** and choose **Bulk actions → Update selected to v2**, then review and apply the model definitions and selected equipment together. This preserves CNC01's parameters and overrides. If an override references a field removed by the new version, review and remove or replace the stale override before the upgrade can apply.

Expected results:

- CNC01 is pinned to CNC version 2 and has five members; its Spindle/Load tag is removed.
- CNC02 stays on CNC version 1 with six members and its working Load reference.
- The total for this exercise falls from 20 to 19 tags, before optional MQTT additions.
- The existing faceplate remains unchanged. Its CNC01 Load value is unavailable. **Designer Diagnostics → Model** reports `{machine}/Spindle/Load` missing from CNC version 2.
- A version-wide template diagnostic can appear as soon as CNC v2 exists, because this template declares support for all CNC versions starting at 1. Placement diagnostics also identify missing or incompatible selected instances.

Resolve the mismatch deliberately: create/restyle a faceplate that supports CNC v2, narrow the old template to a maximum version of 1 and use it only for compatible instances, or review a return of CNC01 to version 1. Merely narrowing the range does not restore the removed tag. The assistant does not regenerate your template during a model upgrade.

## 7. Optional MQTT reuse

Create **UNS MQTT** with the source recipe's scalar mapping:

| Mapping field | Value / meaning |
| --- | --- |
| Topic filter | `uns/+/temperature`: exactly one machine level |
| Owned root | `[default]Sources/MQTT` |
| Tag creation | Observe and review import |
| Payload / declared type | UTF-8 scalar / Double |
| Strip topic levels | 1: remove `uns`, preserving `Haas01/temperature` |
| QoS | 0, matching the synthetic broker |
| Retained messages | Cached / Uncertain_Retained |
| Freshness deadline | 5000 ms |
| Maximum tags | 10 |

Save, browse observed topics, and review-import both temperatures. Verify the resulting raw paths are `[default]Sources/MQTT/Haas01/temperature` and the corresponding Haas02 path. Then preview/apply only `mqttReferenceRecipe` from the example.

It adds a versioned TemperatureSensor type and two instances, each with one read-only reference. This optional step adds four tags: two raw MQTT tags and two model references. It does not add another MQTT subscription for each reference. A retained replay can show Uncertain_Retained until a live message arrives; the reference mirrors that quality. Pausing MQTT publication eventually makes both source and reference stale. Neither reference is an equipment command target.

## 8. Drag a folder to build three Press instances

This optional exercise demonstrates the Models workspace without a source server. Use an isolated gateway and unused example paths. Open **Tags** in the left navigation and create six **Memory / Double** tags with the following values. These are authored static examples; they do not operate a press.

| Folder under `[default]EquipmentDemo/` | `Speed` | `Load` |
| --- | --- | --- |
| Press01 | 120 | 35 |
| Press02 | 180 | 55 |
| Press03 | 90 | 20 |

For example, the first path is `[default]EquipmentDemo/Press01/Speed`. All six tags must have an explicitly declared Double data type. The folder similarity comparison uses member paths, not these example values.

1. Open **Models → Build models**, choose **New model**, and name it **Press**. In **Choose data**, find **EquipmentDemo/Press01** and drag that folder into **Define fields**. Keyboard alternative: focus the folder and press **Enter**, or use its add action. Two fields appear: Speed and Load. Both read from the existing tags, so their data types are filled in for you.
2. When **Use this model for similar machines?** appears, keep the proposed String parameter `Device` and choose **Make reusable & add equipment**. The targets become `[default]EquipmentDemo/{Device}/Speed` and `.../{Device}/Load`: each machine fills in its own name. Press01 supplies `Device=Press01`. **Keep these exact tags** leaves the original targets unchanged; the model's menu offers **Reuse with other machines…** to try again later.
3. In **Add equipment**, inspect the Press02 and Press03 suggestions. Both should find Speed and Load. Add both, or choose **Add all matches**. All three machines remain editable draft rows. Confirm that every machine can find its data; nothing has been saved yet.
4. Open **Organize**. In **Locations**, reuse the workshop's Line `[default]Acme/Dallas/Machining/Line1`, or choose **Add location** to create the four locations from step 3 of this guide. Drag the three equipment rows onto that Line, or select them and use the move action. Check the destination paths; two pieces of equipment cannot have the same path.
5. Return to **Build models** and confirm that your model, parameter and equipment are still there. Choose **Review changes** once. Check which source tag supplies each field, then apply the changes together. Expect one Press model, three pieces of equipment and six reference tags. The six raw memory tags remain separate, for twelve tags total in this optional exercise.

Try an error before Apply: change Press03's Device cell to `PressMissing`. Its resolution should report missing targets, and the server review must block Apply. Restore `Press03`, review again and then apply. Client resolution is immediate feedback; the server preview is authoritative.

To check draft protection, make an unapplied description edit and choose **Tags** or another item in the left navigation. **Stay** must retain it. **Discard draft and leave** must discard that local edit before navigating. Switching **Build models**, **Organize** and **Settings** never discards the draft. Reloading keeps a user-scoped session draft and restores it with a banner; it does not apply it. The current view and model are bookmarkable using `?workspace=models&view=build&type=Press@1` on the current `/designer/<project-id>` route or on `/workspace` when no project is open.

Wait for a preview or Apply request to finish before editing or leaving the workspace. A failed request keeps the draft. If session recovery reports damaged saved content, export the recovered text before choosing **Discard recovered draft**; confirmed discard keeps any current edits and resumes normal recovery storage. A failed package import also keeps your pasted text and existing draft so you can correct it.

Ask Spark can prepare a type or CSV draft and merge it into this workspace. Its changes carry a **from Ask Spark** badge; it cannot apply them. Review the same combined change panel before accepting any assistant proposal.

## Review failures and limits

| Situation | Expected behavior |
| --- | --- |
| Wrong Device spelling or missing raw tag | Preview reports an unresolved target; nothing applies |
| Reference data type differs from target | Preview rejects the mismatch; no implicit conversion |
| Reference/expression cycle or nested-type cycle | Preview rejects the dependency cycle |
| Duplicate CSV paths, collision, invalid parameters or exhausted capacity | Fix the review; the batch is not partly applied |
| Another user changes configuration after preview | Re-preview against the new revision |
| Member/instance/provider disabled | The affected values report Bad_Disabled |
| Delete a raw target still referenced by a model | Dependency validation blocks removal |
| Project imported without required types | Import succeeds; Designer reports unresolved model requirements |

The model supports up to 10,000 expanded tags, 256 definition versions, 2,000 instances, 2,048 hierarchy nodes and four levels of type composition. References count as tags. These are configuration limits, not evidence that a particular device or host can sustain your desired acquisition rate.

Ask Spark can read model types, tree and objects, and draft a type or CSV for the Model workspace. Review and apply model changes there. Outbound MQTT UNS publishing, an i3X server and DIME hand-off are outside this increment.

When finished, archive the workshop project if desired. Preview removal of its model instances first, then remove unused type versions from the outer type toward nested types, remove unused raw tags, and finally remove source connections. Stop the fixture process. Delete hierarchy nodes only after inspecting other resources that use the same paths.

Related guides: [MTConnect setup](MTCONNECT_SETUP.md), [MQTT setup](MQTT_SETUP.md), [tag engineering](TAG_ENGINEERING.md), [model format and contracts](UNS_MODEL.md), [tag parameter bindings](TAG_PARAMETER_BINDINGS.md).
