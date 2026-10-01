# Industrial device connections and workshop

Modbus TCP, Allen Bradley EtherNet/IP, Siemens S7 and Beckhoff ADS connection types require `0.2.0-preview.12` or a later compatible release. Preview.11 and earlier installers do not contain these drivers. Exact artifact/source verification is recorded separately in [Verification and roadmap](PARITY.md); device-model and firmware acceptance remains separate. OPC UA and database connections retain their existing workflows. The [support plan](INDUSTRIAL_PROTOCOLS.md) and [technical specification](INDUSTRIAL_CONNECTOR_SPECIFICATION.md) describe the wider roadmap; MQTT, Sparkplug and other planned protocols are not included in these four driver choices.

Use **Gateway Settings → Configuration → Connections** to choose a driver, enter its protocol settings and save a point map. Each point has a stable ID, display name, native address, scalar type and explicit writable flag. Runtime tags bind to the saved point ID, so editing a native address invalidates reviewed commands and acquisition configuration. Removing a point or changing its type is blocked while saved tags or UDT members still depend on it.

Choose the engineering type used by tags independently from the optional raw storage type. For a one-register temperature, use raw `UInt16`, engineering `Double`, scale `0.1` and offset `0`: register value `123` becomes `12.3`, and an approved write of `12.3` encodes `123`. Boolean and String types retain matching storage types. Integer writes reject fractional raw results and values outside the declared width. Maps are limited to 10,000 points and 768 KiB of normalized JSON.

**Browse saved map** displays configured points without contacting the device. Native browsing is additionally available for ControlLogix/CompactLogix and ADS. Micro800, MicroLogix, SLC 500 and PLC-5 use saved maps in this implementation. A native symbol must be added to the map and the connection saved before creating a tag or reading it through quick watch. Test connection and quick watch are read operations. They do not dispatch writes.

## Prerequisites and compatibility

- This workshop requires `0.2.0-preview.12` or a later compatible release. Consult [Verification and roadmap](PARITY.md) for exact installer/source evidence, and check device model, firmware, OS and dependency compatibility before claiming a hardware profile is supported.
- Use isolated simulators or lab controllers with independently created synthetic variables. These variables must not drive outputs, programs, motion or process interlocks. Only the Modbus loopback workflow has automated end-to-end gateway verification in the new gateway fixture; the other drivers still need identified-device acceptance.
- Gateway configuration requires an engineering account with the configuration capability. The operator needs **Commands** plus readable tag scope for `[default]IndustrialWorkshop/`; **Operate** alone cannot write a register. Designer Preview does not dispatch commands.
- EtherNet/IP uses the pinned libplctag .NET `1.5.2` / NativeImport `1.0.41` payload, whose native core is `2.6.0`. Select the actual controller family; the driver does not substitute another family. Newer library documentation does not establish support in this pinned build. Symbolic type verification includes a guarded bridge tied to this managed SDK version; replacing dependencies requires requalifying that bridge and the native fixtures.
- S7 requires accessible DB/marker memory and controller access permissions. ADS uses an existing router listening on TCP port 48898, or starts a shared gateway-managed router when that port has no listener. An existing router must have the configured local AMS Net ID and an administrator-configured target route. In both cases the controller needs a back-route to that local AMS Net ID and the gateway host. Connections using the managed router must share one local AMS Net ID.
- The workshop is **setup-required**. Its source contains screens and command declarations, with no connections, credentials, tag definitions, runtime exports or automatically executing scripts.

## Load the authored workshop

Set `SPARKSTUDIO_ADMIN_AUTH_FILE` to an ignored local administrator credential file and run this from `source/` against an isolated gateway:

```powershell
node tools/load-industrial-devices-example.mjs http://127.0.0.1:5091
```

The loader creates only a new unpublished **Industrial devices workshop** project. It refuses a duplicate project name. It does not create connections, tags or device writes and does not publish. Unconfigured live displays remain unavailable. Configure any subset of the four lab profiles below, review the project and explicitly publish it in Designer. Columns for profiles you have not configured remain unavailable.

## Four lab profiles

For each connection, create a point with ID `Setpoint`, type `Int16`, scale `1`, offset `0`, and writable enabled. Start the lab value at `10`. Only mark it writable after confirming the address is the independently created synthetic storage. Poll at one second initially.

| Driver | Connection prerequisites | Synthetic address and tag path |
| --- | --- | --- |
| Modbus TCP | Simulator host, TCP port (normally 502) and correct unit ID | `holdingRegister:0`; `[default]IndustrialWorkshop/Modbus/Setpoint` |
| Allen Bradley EtherNet/IP | Host/port 44818 and the actual family; use the family setup table below | `SyntheticSetpoint` for Logix/Micro800 or `N7:0` for the three PCCC families; `[default]IndustrialWorkshop/EtherNetIP/Setpoint` |
| Siemens S7 | Host/port 102, CPU family, rack/slot; an accessible non-optimized lab DB | `DB1.DBW0`; `[default]IndustrialWorkshop/SiemensS7/Setpoint` |
| Beckhoff ADS | Host, local and target AMS Net IDs, ADS port (commonly 851), controller back-route and existing-router target route where applicable; a lab `INT` symbol | `MAIN.SyntheticSetpoint`; `[default]IndustrialWorkshop/BeckhoffADS/Setpoint` |

These example native addresses are valid only when you deliberately created matching storage. Do not paste them into an existing production controller. Modbus addresses use **zero-based offsets**: holding-register offset `0` corresponds to traditional reference `40001`. S7 offsets are bytes; `DBW0` is a two-byte signed word, not a symbolic TIA tag. Native EtherNet/IP and ADS storage types must match the map's raw type. Fixed-capacity ASCII strings, byte/word order and exact scaling are additional map options with driver-specific restrictions; this first exercise uses a signed word with native/default ordering.

## EtherNet/IP family setup

Choose the family shown on the lab controller. Create an independent `INT` variable or signed 16-bit integer-file element holding `10`. Save it as point ID `Setpoint`, with engineering and raw type `Int16`. The workshop's one EtherNet/IP column can be exercised with each family in turn: create a separate saved connection for each available controller, then explicitly rebind `[default]IndustrialWorkshop/EtherNetIP/Setpoint` to the chosen connection's `Setpoint`. Review a new command after every rebind.

| Family choice | Lab address | Route and browsing | Connection test |
| --- | --- | --- | --- |
| `ControlLogix` | `SyntheticSetpoint`, or `Program:Lab.SyntheticSetpoint` if authored in that program | Numeric CIP route, commonly `1,0`; confirm the actual chassis slot. Connected scalar access; native controller/program catalogs or saved map | Read-only native symbol listing |
| `CompactLogix` | `SyntheticSetpoint`, or an authored program-scoped equivalent | Numeric CIP route, commonly `1,0`; connected scalar access; native controller/program catalogs or saved map | Read-only native symbol listing |
| `Micro800` | `SyntheticSetpoint` global `INT` | Blank route; direct connection with connected messaging selected by the driver. Saved map only | Read the first saved point; save a lab point before testing |
| `MicroLogix` | `N7:0` in an independently allocated integer file | Blank route; direct Ethernet PCCC endpoint. Saved map only | Read the first saved point |
| `Slc500` (SLC 500) | `N7:0` in an independently allocated integer file | Blank route; direct Ethernet PCCC endpoint. Saved map only | Read the first saved point |
| `Plc5` (PLC-5) | `N7:0` in an independently allocated integer file | Blank route; direct Ethernet PCCC endpoint. Saved map only | Read the first saved point |

The direct PCCC profiles do not include DH+ bridges, serial DF1, I/O image, status files, timer/counter/control structures or their named fields. Micro800 does not accept a `Program:` prefix or numeric bit selector. String points are excluded from ControlLogix, CompactLogix and Micro800. Logix String map saves, reads and writes are rejected before device access until controller structure-schema qualification is implemented. The SDK's default 88-byte buffer and 82-character capacity describe its codec; they do not establish that an arbitrary controller structure contains the required length/data fields. Micro800 has a different unqualified layout. PCCC ST files retain their separate standard string codec. The [official string attributes](https://github.com/libplctag/libplctag/wiki/Tag-String-Attributes), [Rockwell data-access manual](https://literature.rockwellautomation.com/idc/groups/literature/documents/pm/1756-pm020_-en-p.pdf) and [pinned family handling](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/ab_common.c) describe the underlying layout and type rules.

The following matrix describes **raw storage types** accepted by these source profiles. Engineering numeric types and scaling remain separate. All addresses must identify existing, permitted lab storage; a valid address shape does not allocate a controller file or prove a model/firmware supports it.

| Family/address | Raw type | Read/write scope |
| --- | --- | --- |
| Logix/Micro800 symbolic scalar, member or numeric array element | Boolean, Int16, UInt16, Int32, UInt32, Int64, Float or Double, when the controller reports that exact native type and width | Explicit scalar read/write; no whole arrays or structures. Micro800 WORD/DWORD encodings map to UInt16/UInt32 after native width checks |
| ControlLogix, CompactLogix or Micro800 String symbol | Unsupported | Rejected before device access; support requires future controller structure-schema qualification |
| Any PCCC family: `N7:0` or `B3:0` | Int16 or UInt16 | One complete 16-bit word; writing a B word replaces all 16 bits |
| Any PCCC family: `N7:0/3` or `B3:0/3` | Boolean | Bit 0–15 of a word; dedicated native masked bit write preserves neighboring bits |
| Any PCCC family: `F8:0` | Float | One 32-bit floating-point element, if allocated and supported by the controller |
| Any PCCC family: `ST9:0` | String, configured capacity 1–82 ASCII characters | Standard 84-byte PCCC layout, including its length word and native character order |
| MicroLogix only: `L9:0` | Int32 or UInt32 | One 32-bit integer element on a model/program providing an L file; no L-file bit selectors |

PCCC file prefixes are case-insensitive and canonicalized for the SDK; uppercase examples make the file kind clear. The source validator bounds file numbers to 0–255 and element numbers to 0–65535; actual allocated files can have smaller ranges. PCCC verifies the address-derived file kind and returned buffer width, rather than claiming remote symbolic type discovery. The [pinned address parser](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/pccc.c), [SLC/MicroLogix masks and string layout](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/eip_slc_pccc.c) and [PLC-5 masks](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/eip_plc5_pccc.c) substantiate that transport subset. Rockwell's [SLC instruction reference](https://literature.rockwellautomation.com/idc/groups/literature/documents/rm/1747-rm001_-en-p.pdf) describes the controller's actual file allocation and word/bit addressing.

For each available family, save the lab map, test the connection, use **Browse saved map**, quick-watch `Setpoint`, and bind the workshop tag. For Logix, native browsing is also available. Continue with the reviewed command exercise below only after the read returns `Good` and `10`. For optional B-word/Boolean acceptance, reserve a separate lab word and check neighboring bits independently; the signed-word workshop does not establish bit-write acceptance.

Save the connection, browse its map, read `Setpoint` in quick watch and check `Good` quality and value `10`. Add a device tag using the path in the table. The tag type must match the mapped point. View the live value in Gateway Tags before proceeding to a command.

When the same physical target is reached by different host names or IP aliases, configure the same **Shared command domain** on those connections. Commands serialize conservatively by physical host/domain, including aliases within a connection; distinct saved connection IDs do not establish independent physical storage.

## Walkthrough and expected results

1. Publish the configured workshop and open its operator application with Commands permission. Each configured profile displays its current synthetic setpoint. A missing profile remains unavailable.
2. Review `25` in one profile, inspect the current/requested values and cancel. The lab variable remains `10`.
3. Review again and confirm. The gateway consumes one review ticket, sends one typed write and performs fresh readback. A `confirmed` receipt and live value `25` show that the sampled register matches; they do not establish a completed physical action.
4. Try `101`. The authored 0–100 bound rejects it before dispatch. Try an Operate-only account: it cannot review or execute the equipment command. Inspect the correlation reference in the audit.
5. Change the lab variable from another lab client after review, then confirm. The stale comparison is rejected. Disable and save the connection after a new review: that review is rejected and acquisition becomes unavailable.
6. Repeat the same connect/map/read/review/write exercise for each available protocol and EtherNet/IP family. Rebind the EtherNet/IP workshop tag explicitly between saved family connections. Record actual controller, firmware, gateway OS and dependency version beside the results; one protocol or family's passing result does not qualify another.
7. Stop a lab endpoint and observe bad communication quality. A lost write response yields `uncertain`; do not repeat that reviewed intent. A definitely accepted write with mismatched feedback yields `notConfirmed`. Inspect current lab state before issuing a separately reviewed command.
8. Remove or rebind the workshop device tags and any UDT members before deleting their connections. Saved references, including disabled tags, block deletion. Removing a project alone does not delete its gateway tags or connections.

No command is automatically retried on reconnect or queued for a later connection. Read-only input spaces and points whose writable flag is off are rejected. Integer scaling must be exact, bounded strings are not truncated, and unsafe browser integer values remain outside the scalar command scope.

## Verification

`src/SparkStudio.Gateway.Tests/DeviceGatewayChecks.cs` owns a disposable loopback Modbus register server. Run `dotnet run --project src/SparkStudio.Gateway.Tests -- --suite DeviceGatewayChecks` using the workspace SDK. The suite verifies typed reads/writes, reviewed command authorization and read scopes, single-use/uncertain receipts, conservative alias serialization, enable/disable, runtime polling, reference-safe map changes and deletion, including unused UDT members. It uses synthetic temporary gateway data and never an installed gateway or physical controller.

The connector suite exercises protocol wire/codec and native-driver boundaries separately. The Logix fixtures reject both a synthetic standard-string layout and an incompatible same-size UDT without native reads, setters, dispatch or writes. Earlier positive String layout fixtures were codec-byte tests and did not qualify the controller schema. PCCC ST string fixtures remain part of that supported file profile. Authored family/address validation and loopback fixtures do not establish acceptance against an actual ControlLogix, CompactLogix, Micro800, MicroLogix, SLC 500, PLC-5, S7 or ADS device. Each remains a required deployment check. This workshop is setup-required and excluded from the portable package bundle; configuring a local lab does not change that distribution classification. Exact-installer, dependency and matching workshop evidence belongs in [Verification and roadmap](PARITY.md), following the [release process](RELEASE_PROCESS.md).
