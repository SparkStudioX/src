# Industrial connector technical specification

Status: target design with the first four implemented drivers requiring `0.2.0-preview.12` or a later compatible release, October 1, 2026. Preview.11 and earlier do not contain these drivers. Exact artifact/source evidence is recorded separately in [Verification and roadmap](PARITY.md). The [implementation guide](INDUSTRIAL_DEVICE_CONNECTIONS.md) records current contracts and supported profiles; actual controller/firmware acceptance remains a separate deployment requirement. This wider specification also describes future extensions; its proposed interfaces, richer paging/metadata, serial/message profiles and additional codecs are not all present. Use the [protocol support plan](INDUSTRIAL_PROTOCOLS.md) for delivery order.

SparkStudio should expose industrial equipment through one connection lifecycle and a capability-based device interface. The interface must accommodate registers, symbolic PLC tags, OPC nodes and message metrics without inventing register semantics for every protocol. Connection setup, discovery, browsing and test reads must never issue equipment commands.

## Existing integration points

The current connector library extends `ConnectionDefinition` with optional structured device settings, exposes browse metadata through `BrowseNode`, and returns `ConnectorValue` with one timestamp in [Models.cs](../../src/SparkStudio.Connectors/Models.cs). `ConnectorService` supplies OPC and device browsing/reads; its write and watch partial classes supply reviewed scalar writes, OPC monitored items and industrial polling. Database query/schema/update interfaces stay separate.

[ProjectStore](../../src/SparkStudio.Gateway/ProjectStore.cs) validates and protects shared connection settings. [TagEngine](../../src/SparkStudio.Gateway/TagEngine.cs) plans OPC watches and mapped industrial acquisition, while [TagDefinitionValidator](../../src/SparkStudio.Gateway/TagDefinitionValidator.cs) and [TagModel](../../src/SparkStudio.Gateway/TagModel.cs) validate the supported sources and types. [EquipmentCommands](../../src/SparkStudio.Gateway/EquipmentCommands.cs) provides publication-bound review, authorization, single-use dispatch and readback. New protocols must extend those boundaries rather than add an unauthenticated or free-address write endpoint.

The following architecture and wire examples are proposed, independently authored designs.

## Driver contracts and capability model

Register drivers in a typed registry keyed by stable IDs such as `opcua`, `modbus-tcp`, `modbus-rtu`, `ab-eip`, `siemens-s7`, `beckhoff-ads`, `mqtt` and `sparkplug-b`. A driver descriptor declares its configuration schema, address schema, codecs, platform dependencies and tested profiles. Load optional native dependencies only when that driver is selected; unavailable drivers return a specific dependency/platform error.

Separate configuration validation from network access. The proposed interfaces are:

```text
IDeviceDriver
  Describe() -> DriverDescriptor
  ValidateConnection(settings) -> ValidationResult
  ValidateAddress(settings, address, encoding) -> AddressDescriptor
  OpenSessionAsync(connectionSnapshot, deadline) -> IDeviceSession

IDeviceSession : IAsyncDisposable
  TestAsync(optionalApprovedProbe, deadline) -> TestResult
  BrowseAsync(query, deadline) -> BrowsePage
  ReadAsync(readPlan, deadline) -> ReadBatchResult
  MonitorAsync(monitorPlan, callback, cancellation) -> MonitorRegistration
  WriteOnceAsync(preparedWrite, beforeDispatch, deadline) -> WriteResult
```

Drivers must reject unsupported methods with structured errors. The descriptor distinguishes `discovery: none/endpoints/devices`, `browse: native/imported/observed/configured`, `acquisition: polling/subscription/stream`, scalar read/write types, arrays, event support, bit-write semantics, batch limits and protocol security. Runtime point descriptors refine access as `read`, `write`, `readWrite` or `unknown`. Unknown access is not authority to write; the tested profile and authored destination allowlist must also permit it.

Keep the existing `ConnectorService` facade during migration. Route device operations to the registry and keep SQL/SQLite query execution in the database service. Driver code handles transport/encoding; gateway code owns users, grants, projects, publication, tag scopes, secrets, command tickets and audit.

## Connection configuration and lifecycle

Store a versioned connection envelope with immutable ID, name, driver ID, settings schema version, current revision, enabled state, validated protocol settings and protected secret references. Backward compatibility is not a requirement for this redesign. Save must reject a stale revision or a previously removed ID; changing driver family creates a new connection.

| Driver | Required protocol settings | Additional profile settings |
| --- | --- | --- |
| OPC UA | Endpoint, security mode/policy and identity | Trust/pin references, namespace mapping, session and subscription limits |
| Modbus TCP | Host, port, unit ID | Connect/request deadlines, device identity probe if supported, map version, maximum block sizes |
| Modbus RTU | Serial device, baud, parity, data/stop bits, unit ID | Bus identity, response/inter-frame timing, hardware direction control profile |
| EtherNet/IP | Host, controller family, CIP routing path where required | Connected/unconnected profile, negotiated request limits, symbol import/listing settings |
| Siemens S7 | Host, port, CPU family and rack/slot or validated TSAP profile | Negotiated PDU limit, allowed memory areas and DB layouts |
| ADS | Local AMS Net ID, target host/AMS Net ID and ADS port | Managed route identity, router ownership and notification limits |
| MQTT/Sparkplug | Broker endpoints, protocol version, TLS/identity and client/host identity | Subscription allowlist, session policy, payload schema, maximum packet size; Sparkplug role/group filters |
| MTConnect | Agent base URI and optional device filter | Supported schema version, HTTP credentials, observation stream limits |

Use states `disabled`, `disconnected`, `connecting`, `connected`, `degraded` and `faulted`, with transition reason and observation time. Report transport connectivity, protocol-session validity and data freshness separately. ICMP ping may be an optional diagnostic; success must require a protocol handshake or a permitted probe. ICMP failure must not prevent a valid protocol connection.

Passive HTTP/UDP ingestion reports `listening` after a successful local bind rather than claiming a connected remote device. Sender availability and data freshness require independently observed valid messages/heartbeats; listener readiness alone cannot establish equipment health.

Snapshot settings and revision into each session. On save, disable or recovery activation, invalidate the acquisition generation before accepting further callbacks. Reject new work against obsolete sessions and retire resources when admitted operations finish. Release sockets, handles, subscriptions, routes and native allocations in `finally`/disposal paths, including failed connection and decoding paths.

Shared serial buses and ADS routers require a manager with explicit ownership and reference counts. Shutting down one driver instance must not terminate another connection's runtime. Serial ports have one bus scheduler. Document local permissions and container device mappings before enabling an RTU connection. ADS route creation must finish successfully before the connection reports ready.

Reconnect only acquisition/session work, with jittered exponential backoff starting at one second and capped at 30 seconds. Read retries require profile-declared idempotent reads and must stay within the original deadline and operation budget. Consequential/read-to-clear addresses are excluded from automatic polling and retries unless a separate authorized operation defines their semantics. Permission, malformed-address and unsupported-security errors should not be retried continuously. Never replay a pending equipment command on reconnect, process restart or connection save.

## Browsing and address maps

The browser must report its mode visibly. OPC UA and ADS can provide native metadata; qualified Logix profiles can expose controller/program tags. Modbus, classic S7, Micro800 and PCCC profiles use address maps. MQTT uses configured or observed topics; Sparkplug uses birth-defined metrics. Do not present generated register ranges as device-discovered symbols.

`BrowsePage` includes connection revision, catalog generation, browse mode, parent identity, entries, continuation token and truncation status. An entry includes stable point address, display name, folder/leaf state, native and normalized type, dimensions/length, access, units/description where supplied and metadata provenance. Browsing alone must not read all leaf values.

Page size defaults to 100 and is capped at 500. Tokens bind to the authenticated session, connection revision and catalog generation and expire after five minutes. Release remote continuation resources on completion, cancellation or expiry. Cap each catalog at 10,000 leaves and report truncation rather than silently losing entries; bound string lengths and recursive depth. Search operates on loaded/native indexed metadata within the same budget, without an unrestricted network scan.

Register-map records contain ID, display hierarchy, protocol address, raw type/width, byte and word order, array/string layout, scaling, units, read/write access and readback configuration. CSV/JSON import shows validated differences before applying one revisioned change. It must flag conflicting aliases, address overflow, overlaps, unsupported encodings and writable input spaces. Mapping a point creates a saved gateway tag; it does not publish an application or enable a command.

Partial or failed discovery retains the prior catalog marked outdated. An empty successful catalog displays an explicit empty state. Discovery metadata and a reported writable flag are advisory; server/controller permissions can still reject an operation.

## Canonical addresses and value encodings

Addresses are structured, versioned values validated against the selected driver. They must not contain credentials or arbitrary SDK connection strings. Human-readable forms are displayed for convenience, while persistent identity uses protocol fields.

| Driver | Canonical point fields | Example display |
| --- | --- | --- |
| Modbus | Space, zero-based offset, count/width; unit inherited from connection | `holdingRegister:100` for the two-register value beginning at offset 100 |
| EtherNet/IP symbolic | Controller scope and symbol path, optional member/array index; program scope for Logix | `Program:Main.SpeedSetpoint` for Logix or global `SpeedSetpoint` for Micro800 |
| EtherNet/IP PCCC | Family-qualified file kind/number, element and optional 16-bit Boolean selector | `N7:0`, `B3:0/3` or `ST9:0` |
| S7 | Area, DB number where applicable, byte offset, optional bit, width/layout | `DB10.DBD20` or `DB10.DBX0.3` |
| ADS | Symbol path and type/layout fingerprint | `MAIN.SpeedSetpoint` |
| OPC UA | Namespace URI, identifier kind/value and optional array index range | URI-qualified identifier; resolve namespace index per session |
| MQTT | Exact data topic and bounded payload field selector | `line1/drive/status` plus `/speed` |
| Sparkplug | Group ID, edge node ID, optional device ID, metric name | `Factory/Edge1/Drive1/Speed` |
| MTConnect | Device UUID plus data item ID | `Machine1/spindle_speed` |

For Modbus, the register-map editor must explicitly select zero-based offset, one-based offset or traditional reference notation. Traditional `40001` means holding-register offset zero; it is never transmitted as numeric offset 40001. Store the resolved space/offset and the chosen display convention. Reject ambiguous pasted numbers until a convention is chosen.

Normalized scalar types begin with the current Boolean, Int16, UInt16, Int32, UInt32, Int64, Float, Double and String types. Proposed extensions include signed/unsigned 8-bit values, UInt64, byte strings and bounded arrays, introduced with coordinated tag, command, export and frontend migrations. Preserve 64-bit integer fidelity across JSON using an explicit typed decimal-string representation; do not convert unsafe integers into JavaScript numbers. Unsupported structures remain browseable metadata until their member codecs are supported.

For multi-register values, declare `byteOrderWithinWord` and `wordOrder` independently. A 32-bit example with canonical bytes `12 34 56 78` must decode the four configured layouts `12 34 56 78`, `34 12 78 56`, `56 78 12 34` and `78 56 34 12` predictably. A 16-bit register has no word-order choice. Signed values use explicit two's-complement widths; floats use the selected IEEE width and finite-value validation.

String codecs require encoding, fixed capacity, terminator/padding and any length-prefix layout. Arrays require rank, bounds and element layout. Scaling is `engineering = raw * scale + offset`; writing applies the inverse only when scale is nonzero and the mapped value is in range. Integer writes reject nonintegral inverse results unless the authored profile explicitly chooses a rounding rule. Review must show the engineering value and resulting raw value. Never silently truncate strings, wrap integers or infer a layout from a plausible value.

The target identity used for command locking combines a shared device contention domain with the resolved native storage region, not the connection ID alone. Normalize device identity/routing through the driver and require an explicit shared domain or reject duplicate writable connections when aliases cannot be resolved reliably. Connections to the same physical storage must acquire the same lock even when host aliases or tag names differ. For register/block protocols, use overlapping byte/register-range conflict detection. This serializes SparkStudio's own writes; it does not exclude external clients. The planner must never merge reads across a profile-marked side-effect boundary.

If a symbolic driver cannot establish that destinations occupy independent storage, serialize writes across the entire shared device contention domain. Different symbolic names or structure-member paths alone do not prove non-overlap.

## Reading and acquisition

An explicit read request references saved point/tag definitions, or validated engineering addresses under configuration permission. Operators only read published tag paths allowed by their project scopes. SDK raw-packet interfaces are not exposed to browsers or scripts.

`ReadBatchResult` returns one item per requested identity, including value, normalized/native type, quality, native status code, source timestamp when provided, server timestamp when provided, gateway receipt time and acquisition sequence/generation. Missing protocol timestamps remain null; a polling receipt time must not be represented as a device-origin timestamp.

Common qualities include good, uncertain/stale, disabled, not-connected, timeout, bad-address, access-denied, unsupported-type and decode-error. Preserve the native result alongside the normalized quality. Retain a last known value with explicit non-good quality after failures; do not publish zero or null as a fresh good value. Transport disconnect invalidates freshness immediately. Report-by-exception suppresses unchanged values without suppressing quality changes or acquisition health.

The scan planner groups compatible points by connection, address space and scan group, and merges only contiguous approved regions. Use profile-specific limits rather than one universal packet size. Failed blocks should return affected points with bad quality; an unrelated successful block remains usable. Splitting an invalid read block is permitted only within a bounded diagnostic/read budget and must never turn into unbounded probing.

Use the existing 100–60,000 ms scan-group range initially, but reject intervals a device profile cannot support. Default polling is one second. Do not overlap scans for a serialized connection; coalesce a missed tick instead of creating a backlog. Defaults are one request in flight per PLC connection or serial bus, with a profile-qualified upper bound. Separate scan planning from browser subscriber count so opening dashboards does not multiply PLC traffic.

Keep freshness deadlines independent of notification/change time. For polling, a successful acquisition refreshes receipt freshness even if its value is unchanged. For subscriptions, use session/subscription keepalive plus per-item statuses; do not mark an unchanged healthy value stale solely because no data-change notification arrived. Event/message connectors also need schema-specific data-age rules; old retained MQTT messages are not automatically current values.

Proposed initial service limits: 256 points per explicit read request, 1 MiB decoded response, 64 KiB per individual string/byte value, 4,096 queued notifications per connection and a bounded gateway-wide acquisition budget. Use the lower of service, device and SDK limits. Queue overflow must be visible; telemetry may coalesce latest values, but event-loss reporting must not pretend the stream is complete. The existing 10,000 expanded-tag configuration limit remains until measured capacity justifies a separate increase.

Default network connect deadline is five seconds, request deadline two seconds and user operation deadline ten seconds; configurable profile maxima are 30 seconds. These are proposed defaults, not existing guarantees. Include queue wait, retry and decoding time in the deadline. A blocked SDK call requires a disposable worker boundary if cancellation cannot bound it reliably.

## Writing and command outcomes

All equipment writes use the existing [equipment-command contract](EQUIPMENT_COMMANDS.md), extended to supported device tags. Configuration permission alone does not grant project Commands. No browser request may supply a new host, native address, raw packet or arbitrary write function at execute time.

1. An author saves the writable tag, permitted type, engineering bounds, optional explicit raw bounds, readback point and confirmation policy, then publishes a command or native Set tag value action.
2. Review resolves the published definition, current connection/map/type revisions and allowed raw destination, verifies read/write permissions and reads a fresh target value. Reject disabled, outdated, unresolved or unqualified targets. Write-only targets are unsupported initially, even with a separate feedback tag, because this workflow compares the target's current value before dispatch.
3. Issue a short-lived single-use review ticket bound to account, session, project publication, normalized request and the complete target/encoding/security fingerprint. Preserve the existing 30-second expiry and bounded review inventory.
4. At execute, consume the ticket once, acquire the storage-region command lock and recheck current authority, publication, enable state, configuration and fresh-value comparison. Failure before dispatch sends no equipment write.
5. Invoke `beforeDispatch` immediately before the first operation that may transmit the write, including SDK buffer enqueue. Record that boundary and send the approved request once. The gateway and SDK write path must not reconnect-and-resend automatically.
6. Interpret the protocol response, then confirm fresh feedback within the command deadline. Request a new readback acquisition after dispatch for protocols with explicit reads. Message protocols require a correlated application acknowledgement and qualified post-command telemetry that establishes the requested value; reject retained, pre-dispatch, delayed earlier-generation and unchanged cache entries. Where timestamps or sequences cannot establish that ordering, require an echoed command ID or a defined device handshake. Capture timing and any native status without claiming a physical process completed.

The initial command API supports one normalized scalar target per invocation. A Float spanning two Modbus registers may be encoded into one approved write request; this is distinct from an operator batch writing unrelated points. Array/structure writes and multi-target transactions are separate phases and remain disabled initially.

| Outcome | Required meaning |
| --- | --- |
| `confirmed` | Protocol accepted the write and matching fresh readback was observed |
| `rejected` | Validation failed before dispatch, or the protocol definitively rejected the request without an ambiguous mutation |
| `notConfirmed` | Protocol accepted the write, but fresh readback did not match before its deadline |
| `uncertain` | Dispatch may have occurred and completion is unknown, including lost response, partial multi-part mutation or cancellation after dispatch |

Do not classify every protocol exception as a guaranteed no-write rejection. Device/internal-server failures after execution began may be uncertain. Readback loss after a definite accepted response is `notConfirmed`; loss of the write response itself is `uncertain`. Record protocol acceptance separately from the final confirmation outcome.

This explicit distinction for readback exceptions is a proposed refinement. The current command implementation classifies exceptions after dispatch as `uncertain`; the adapter and command checks must be updated deliberately to preserve a known accepted response when only subsequent readback fails.

Modbus holding-register bit fields and shared-word values require native qualified masked operations or a dedicated writable region. A client-side read/modify/write can overwrite another controller/client's changes; a local lock does not remove that risk. Reject bit writes that cannot meet the profile's guarantee. Apply the same rule to S7 packed bits and PLC structure members. No automatic pulses, toggles, retries or queued commands after reconnect in the initial implementation.

Fresh comparison is not a device compare-and-swap. Multi-register read/write does not by itself prove PLC scan consistency. Controller-side interlocks and handshake variables remain application requirements. If a command needs transaction IDs, request/acknowledge values or completion-state feedback, define them explicitly in its profile and declaration.

Audit records include actor, connection/tag/command identity, revision fingerprint, correlation ID, dispatch state, protocol acceptance, readback outcome and durations. Maintain existing redaction of credentials and submitted values; diagnostic errors must be fixed/structured messages rather than raw SDK exception text.

## Protocol implementation profiles

### Modbus TCP and RTU

Support read functions 01/02/03/04 and write functions 05/06/15/16. Coils and holding registers are writable; discrete inputs and input registers are read-only. Wire offsets are 0–65535. Maximum standard quantities are 2,000 read bits, 125 read registers, 1,968 written coils and 123 written registers. Function 22 masked register writes are an optional qualified capability; device-identification function 43/14 is optional. These facts follow the [Modbus application specification](https://www.modbus.org/file/secure/modbusprotocolspecification.pdf).

The adapter must validate range overflow, function/space compatibility and response length, unit ID, transaction ID and exception framing. Default TCP port is 502; use explicit per-device smaller block limits where required. Multiword scalars must fit one request initially. Keep maps and codecs identical across TCP and RTU, with separate transport schedulers. RTU must use acknowledged unicast, validate CRC and obey serial timing; reject broadcasts from the initial read/write API. Serial timing and address rules follow the [Modbus serial specification catalog](https://www.modbus.org/modbus-specifications).

A successful TCP socket alone is not a successful device test. Use an optional documented identity query or an explicitly approved harmless map read. Never probe the complete register range. Device-specific read-to-clear or otherwise consequential addresses must be excluded from generic test/scan merging.

### Allen Bradley EtherNet/IP

The current `ab-eip` source profile chooses `ControlLogix`, `CompactLogix`, `Micro800`, `MicroLogix`, `Slc500` or `Plc5`; invalid configuration never substitutes another family. It uses pinned libplctag .NET 1.5.2 / NativeImport 1.0.41, native core 2.6.0. Controller model/firmware acceptance remains separate. The [implementation workshop](INDUSTRIAL_DEVICE_CONNECTIONS.md#ethernetip-family-setup) supplies the exact address/type matrix and lab setup.

The pinned managed SDK's `GetByteArrayAttribute` treats a positive native copied-byte count as an error. Current symbolic type verification uses the NativeImport attribute API through a restricted metadata bridge, requiring managed assembly version `1.5.2.0`, the expected private `NativeTagWrapper`/integer-handle field shape, initialized live handle, attribute length 2–64 and exact copied length. `Tag` continues to own I/O and handle lifetime. Missing or mismatched metadata fails the operation before write dispatch; there is no inferred type fallback. An SDK upgrade must requalify this explicit coupling through native Logix and Micro800 wire fixtures, rather than preserving the guard by assumption.

ControlLogix/CompactLogix preserve symbolic program scope, indices and member paths, require a numeric CIP route and provide native controller/program listing. Numeric/Boolean scalar types must match active native type and width. String points are rejected at map validation and before native tag creation: default SDK STRING capacity/layout and a generic CIP structure response do not qualify the controller's member schema. Future String support must verify the actual structure schema and codec layout; a same-size UDT cannot substitute for that evidence. Previous positive synthetic String layout fixtures checked codec bytes only, not schema qualification. Whole arrays/structures and numeric bit selectors are also outside this source profile. Micro800 uses direct symbolic numeric/Boolean access with a blank route and connected messaging, including native WORD/DWORD as raw UInt16/UInt32. It rejects program scopes, numeric bit selectors and its distinct unqualified String layout and uses configured-map browsing; newer Micro800 library browsing features are not claimed by the pinned implementation. [Official string attributes](https://github.com/libplctag/libplctag/wiki/Tag-String-Attributes), [Rockwell structure-schema documentation](https://literature.rockwellautomation.com/idc/groups/literature/documents/pm/1756-pm020_-en-p.pdf), [pinned family/type handling](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/ab_common.c)

The three PCCC families use direct Ethernet access and a blank route. N/B addresses accept raw Int16/UInt16 words and explicit `/0`–`/15` Boolean selectors; F accepts Float, and ST accepts the standard 84-byte string layout with capacity 1–82. L accepts Int32/UInt32 only for MicroLogix on a controller providing that file. Address validation limits file numbers to 0–255 and elements to 0–65535; actual file allocation can be smaller. Case-insensitive prefixes are canonicalized before SDK use. I/O/status/timer/counter/control files, named subfields, DH+ bridges and serial DF1 are excluded. PCCC has no remote symbolic type catalog: verify its address-derived file kind and returned native width instead of calling Logix type metadata. Micro800 and PCCC test reads the first saved point, so an empty map cannot establish connection success. [Pinned PCCC parser](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/pccc.c)

PCCC bit-address writes use native masked operations; a whole B-word write replaces every bit. The pinned parser permits bit selectors only on 16-bit words, even when later upstream examples describe other widths. Native family codecs preserve PCCC counted-string character order and PLC-5 floating-point word order. Optional raw numeric encoding and engineering scaling remain independent, with exact integer inverse conversion before dispatch. [SLC/MicroLogix masked writes](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/eip_slc_pccc.c), [PLC-5 masked writes/codecs](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/eip_plc5_pccc.c)

The implemented service owns native tag handles, disables SDK auto-sync and sends one explicit write through the existing review/dispatch/readback coordinator. Logix and Micro800 scalar operations use connected CIP messaging; Logix read-only symbol listing remains unconnected, and PCCC keeps its direct unconnected profile. The pinned native core's unconnected Logix write-acknowledgement handling is not used for scalar writes. Any future packing, fragmentation, UDT/array support, bridge route or additional codec needs its own bounds and per-point statuses. Read/write rejection, lost-response uncertainty, neighboring-bit preservation and dependency/platform qualification must be established for each controller family; Logix results do not qualify a PCCC or Micro800 profile. [libplctag API](https://github.com/libplctag/libplctag/wiki/API)

### Siemens S7

The initial profile uses classic S7 addressable memory with a declared CPU/connection profile. Imported/manual maps define area, DB, offset, bit and encoding. For relevant S7-1200/1500 configurations, accessible non-optimized DB layouts and appropriate PUT/GET permissions are prerequisites; do not promise TIA symbolic browsing through this profile. OPC UA remains an alternative where the controller supplies it. [Siemens S7 communication guide](https://support.industry.siemens.com/dl/files/115/82212115/att_108330/v2/82212115_s7_communication_s7-1500_en.pdf)

Read byte blocks within negotiated PDU constraints, then use explicit codecs for signed/unsigned values, REAL and supported strings. Do not rely on direct CLR casts from an address parser. Separate readable inputs from approved writable DB/marker regions; output, timer and counter writes require later named profiles. If a write would split across requests, reject it initially. Validate packed-bit behavior and controller access errors using an identified device. [S7.NET+ implementation](https://github.com/S7NetPlus/s7netplus)

### Beckhoff ADS

Require valid local/target AMS addressing and confirmed routes. Load native symbol/type metadata, preserve symbol paths and declared dimensions, and use bounded ADS read/sum operations or notifications. Symbol loader APIs are documented by [Beckhoff](https://infosys.beckhoff.com/content/1033/tc3_ads.net/9407527691.html).

A PLC download or symbol-version change invalidates cached handles and codecs. Pause affected acquisition/commands until metadata is rebuilt and mapped types still match. Dispose every handle/notification after failed operations as well as successful ones. Router management must handle multiple connections without a first-connection configuration silently controlling the rest. No automatic acceptance of PLC state-changing operations; register/symbol writes alone are the qualified initial command scope.

### OPC UA

Preserve current security-policy selection, certificate trust/pins, identity and explicit writes. Improve browsing with continuation handling, namespace-URI identities and type/access/dimension metadata. Release server continuation points; separate objects from writable variables and methods. Preserve native quality and source/server timestamps. [OPC Browse](https://reference.opcfoundation.org/specs/OPC-10000-4/5.9.2), [OPC Read](https://reference.opcfoundation.org/specs/OPC-10000-4/5.11.2), [OPC Write](https://reference.opcfoundation.org/specs/OPC-10000-4/5.11.4)

Event/condition subscriptions must be specified separately from data-change monitored items. Method calls and alarm acknowledgement are commands with their own schemas and authority; do not route them through scalar register writes.

### MQTT and Sparkplug

MQTT has topics/payloads rather than a standard register catalog. Build a bounded observed/configured catalog with schema validation, timestamp provenance and retained-message labels. A command needs an exact allowlisted destination, encoder, correlation ID, expiry and application acknowledgement/readback mapping. Broker delivery acknowledgements and QoS are not evidence that a device applied a requested value. Reject retained equipment commands and disable reconnect/offline replay; ensure the chosen client/session/QoS behavior cannot silently replay an uncertain actuation. [MQTT 5.0 standard](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)

Command IDs and expiry do not by themselves prevent duplicate equipment actuation. Qualify receiver-side command-ID deduplication or proven idempotent absolute-set semantics, including behavior across device restart; otherwise reject that writable profile. One gateway publish invocation is not an exactly-once physical-action guarantee. Never use this initial mapping for a non-idempotent pulse, increment or start operation without a stronger separately specified device handshake.

The Sparkplug host profile builds catalogs from birth messages, resolves aliases within their node/birth generation, tracks death and sequence changes, and rejects unknown aliases until a fresh birth. NCMD/DCMD publishing requires a tested writable-metric mapping; it must not be treated as a PLC register write simply because publishing succeeds. Keep node telemetry export and host command roles distinct. [Sparkplug 3.0 specification](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)

### MTConnect and specialty adapters

MTConnect browses the probe model and reads current/sample observations, preserving device identity, data item identity, sequences and unavailable conditions. Restart or buffer rollover must reset sequence tracking visibly. This profile rejects equipment writes. [MTConnect REST model](https://model.mtconnect.org/Version2.4/Fundamentals/MTConnectProtocol/RESTProtocol/)

OPC DA requires an isolated Windows helper or a UA bridge because of COM/DCOM dependencies. Manufacturer robot/press/ASCII/SNMP/ROS adapters begin with explicitly documented telemetry fields and cannot inherit generic writability. Their connection/browse/read profiles must name required options and SDKs; writable registers need additional vendor-specific acceptance. [OPC Classic](https://opcfoundation.org/about/opc-technologies/opc-classic/)

The following profiles make the broader source scope explicit. The write column specifies proposed scope; it does not assert that an SDK or device already supports it.

| Profile | Connecting and point identity | Browsing and reading requirements | Writing requirement |
| --- | --- | --- | --- |
| FANUC robot SNPX | Host, SNPX channel/port, supported controller options and independently procured SDK license; I/O/register family plus index or permitted system-variable name | Profile catalog for numeric/string/position registers and selected I/O; typed arrays/position structures with frame/unit metadata, bounds and shared per-cycle reads | Qualify documented numeric/string registers separately; position/I/O/system-variable writes need dedicated declarations and acceptance. No program/motion/start operation through a register alias |
| Yaskawa robot | Host and supported controller/SDK communication profile; named telemetry or documented variable family/index | Distinguish fixed status/pose/job/alarm telemetry from optional register/variable access; preserve pose frame, joints and units | Initial telemetry profile rejects writes. A later variable-register profile must name destinations, native acknowledgement and fresh readback; robot jobs/services stay separate |
| Productive Robotics rosbridge | Configured WebSocket URI, firmware/API and ROS topic schema; topic plus field or register index | Typed message catalog, bounded frame assembly, subscription limits and explicit freshness. Register indices and robot units require a named firmware profile | Initial subscriptions reject commands. Later register commands require a documented publish/service schema and application acknowledgement; a WebSocket send alone is insufficient |
| Haas SHDR | Device TCP endpoint and documented stream/heartbeat profile; stream key/data item | Catalog imported from device documentation or observed telemetry; validate framing, partial messages, heartbeat and stream quality | Telemetry enable/heartbeat messages remain connection operations; register writes are unsupported unless a distinct documented profile is added |
| ASC CPC | TCP endpoint and versioned documented read-request vocabulary; field/path | Authored path catalog, complete bounded responses and typed parsing; no invented native enumeration | Initial read-only; future writes need manufacturer-approved request/response definitions and destinations |
| SmartPac | TCP endpoint and documented message IDs/framing; response field identifier | Parse complete framed responses, validate lengths and field maps, attach native status; remove dependence on arbitrary scripts for basic decoding | Initial read-only; require a documented writable-field protocol before implementing commands |
| TCP ASCII | Endpoint, encoding, delimiter/length/checksum profile; fixed request identity and field selector | Profile-defined map; bounded stream assembly rather than one socket read per response; reject unsupported framing | Only predeclared command templates with typed parameter encoders and positive response/readback mapping |
| UDP | Local bind, sender allowlist, datagram/schema version; message/field identity | Receive exact datagrams, retain sender and sequence/receipt time, validate length; document loss/reordering and expected heartbeat | Passive ingestion cannot write. Any request/command profile must separately define correlation, timeout and acknowledgement; no generic UDP register writer |
| SNMP | Target, version and identity; OID plus native ASN.1 type | Typed GET and bounded walk/GETBULK where supported; SNMPv3 profile, MIB provenance and no mandatory ping | Initially read-only. A later SET profile needs explicit writable OIDs/types, authenticated access and readback |
| ROS 2 | Domain, middleware/security profile and supported message assemblies; topic/type/field | Bounded graph/topic catalog, typed subscriptions, QoS compatibility and runtime/platform diagnostics | Initial telemetry profile rejects publish/service/action commands. Any later command contract must specify type, expiry, correlation and device acknowledgement |
| Timebase WebSocket | Validated historian URI/authentication, protocol version and dataset/tag identity | Configured catalog or a documented metadata API; preserve incoming time/value/quality, reconnect subscription generations and complete message framing | Read-only subscription; historian ingestion is a separate data integration function |
| OPC DA | Windows helper/bridge identity, ProgID/CLSID, server host and bitness | DA item metadata/groups, types, timestamps and quality; isolate COM lifecycle and failure | Initial bridge read-only. Any native DA write profile must use the same reviewed-command outcome model |

The generic source interface also supports these non-register integrations under a separate `IDataSource`/`IMessageSource` family. It must not report `CanWriteRegister` merely because data can be posted or published.

| Integration | Connect and browse | Read and update contract |
| --- | --- | --- |
| SQL Server/PostgreSQL | Protected server/database identity; bounded schema and named-query metadata | Typed parameterized queries; named DML definitions and explicit transaction/cancellation outcomes. Reject mutating statements in read definitions |
| PostgreSQL notifications | Database session plus allowlisted channel names and payload schema | LISTEN/NOTIFY events, session-aware re-subscription and explicit notification gaps; optional NOTIFY publication stays a database action |
| Redis | Protected endpoint identity, key/type allowlist and scan budget | Typed keys; explicitly enabled event subscriptions or polling. Report missed notifications and reconcile state. Updates target configured keys only |
| ActiveMQ | Broker URI/TLS/identity and destination allowlist | Bounded typed subscriptions and acknowledgement policy; message publishing does not confirm equipment execution |
| HTTP webhook | Explicit local listener, authenticated route and request-size/schema limits | Ingestion validates provenance and payload before producing values; no wildcard route inherits device-write authority |
| HTTP JSON/XML and weather | Validated remote endpoint, TLS/identity, timeout and response limits; schema/sample-based field catalog | Read-only GET/projection with bounded selectors, timestamp provenance, disabled XML external entities and controlled redirect destinations |
| Script/computed source | Authored output/type contract within existing script execution | Produces typed values and errors; use the existing explicit equipment commands for physical writes |
| AI process source | Outside this industrial specification | Treat any future integration as a separately authorized feature with no automatic equipment-command access |

## Gateway API and engineering interface

Proposed administrative routes supplement existing connection CRUD/test/diagnostics. All require the configuration capability and the appropriate engineering session; mutation requests retain existing CSRF and audit protections.

| Route | Contract |
| --- | --- |
| `GET /api/device-drivers` | Driver descriptors, platform availability, profile and schema versions; no secrets |
| `GET /api/connections/{id}/capabilities` | Effective capability/profile snapshot for the saved revision |
| `POST /api/connections/{id}/browse` | Saved revision, parent/search/page request; returns bounded page and continuation token |
| `POST /api/connections/{id}/read` | Saved revision and bounded validated point list for engineering quick watch |
| `POST /api/connections/{id}/register-map/preview` | Validates import and reports differences without persistence or device writes |
| `PUT /api/connections/{id}/register-map` | Applies previously reviewed content against connection/map revisions |

These are proposed routes, not a second connection API already in use. Keep existing OPC clients working through adapters during migration. Reserve operator writes for the existing project runtime command review/execute routes. Future gateway maintenance commands require a separately reviewed contract; there is no proposed `POST /connections/{id}/write` accepting arbitrary targets.

Connection screens show profile-specific settings and the supported browse mode. A read-only quick watch displays native address, decoded value, quality, timestamp provenance and actual scan cadence. Browse/map actions support creating tags with a preview of address/type/encoding. Writable tags show available command types; validation explains unavailable writes before review. Reference/dependency diagnostics show saved tags, UDT members and draft/published queries, adding message-command mappings when introduced. Empty sections remain hidden.

Connection deletion preserves the existing current-revision and saved-reference checks. New device tags and command mappings must participate in those checks, including disabled tags and archived project publications. Deletion waits for admitted operations/resources to retire; it must not bypass active transport leases. Removing a connection does not delete database files, externally configured PLC programs or certificate stores.

## Security and compatibility requirements

The gateway owns endpoint resolution and protected credentials. Browsers never contact PLCs directly. Server-side validation allows only driver-specific host/port/address fields and authorized destinations. Browse tokens and previews bind to identity and revision; scripts cannot bypass point allowlists with raw SDK objects.

Use certificate validation and protected identities for protocols that provide them. Existing OPC trust review remains explicit; no security-mode downgrade on failure. For legacy unencrypted protocols, the deployment profile must identify the permitted network boundary. Do not manufacture an encryption capability that the selected transport lacks.

SDK selection is provisional until dependency licensing, supported OS/CPU, packaging, cancellation behavior and native retry semantics have been verified. Candidate families include the current OPC SDK, NModbus, libplctag, S7.NET+, Beckhoff ADS and an MQTT client; this specification does not require reusing another product's connector implementation or dependency pins.

Propose a new `sparkstudio.tags` schema version for structured device addresses and encoding maps. Continue loading/exporting existing memory/expression/OPC definitions without changing their semantics; new tag-model imports must fail clearly on incompatible gateways. Preserve the `.sparkproj` boundary: project packages contain application resources and references, not shared gateway tags, register maps, connections or credentials. Project packages using new command/binding capabilities must declare their minimum compatible gateway version and external setup dependencies. Backups must retain connection settings, map revisions and secret references with the existing portability rules. No release should silently reinterpret a saved Modbus offset, PLC symbol or string layout.

## Acceptance and delivery gates

Complete each row for every claimed device/firmware/platform profile. Document skipped cells explicitly; read acceptance does not establish write acceptance.

| Gate | Required evidence |
| --- | --- |
| Address and codecs | Golden vectors for boundaries, signed widths, all supported byte/word layouts, float/string/array decoding, scale inversion, overflow and invalid mappings |
| Connection | Correct handshake, protocol errors, wrong identity/security, no mandatory ping, timeouts, enable/disable and stable multi-connection operation |
| Browse | Native/map/observed provenance, pagination, metadata/access/type correctness, cancellation, stale token/revision, empty/partial catalogs and no implicit value scan |
| Reads | Real simulator values, bad individual addresses, partial blocks, type errors, quality/timestamp provenance, disconnect/recovery, stable values and bounded overload |
| Writes | Accepted/rejected device response, definite/ambiguous failures, single dispatch, no library replay, wrong access/type/range, overlapping aliases, fresh readback and accepted-but-unconfirmed outcome |
| Authorization | Commands versus Operate/configuration grants, tag-read scopes, CSRF, revoked account/session, stale publication/configuration, token expiry/replay and audit redaction |
| Resources | Disconnect during operation, failed decode/connection, handle/subscription release, independent driver shutdown, bounded queues and worker cancellation |
| Physical device | Identified model, firmware and OS/architecture; connect/browse/read/write/reconnect matrix with synthetic test values and operator-approved test destinations |
| Distribution | Clean source build, dependency notices, supported installer/container packaging, import/backup migration and compatible workshop/export verification |

Maintain a simulator per core protocol and a reusable driver contract suite. Modbus fixtures must include function limits and illegal-address responses; PLC fixtures must include symbolic/DB/type changes; ADS fixtures must include symbol invalidation; message fixtures must include stale births/aliases, retained data and duplicate/delayed acknowledgements.

Initial performance acceptance should use explicit measured workloads: 100 and 1,000 points at one-second polling for supported PLC profiles, plus the bounded 10,000-tag gateway configuration; a separate RTU test must reflect actual bus baud/response times. Record request count, device load, median/p95 age, failures, queue bounds and memory after reconnect cycles. These are proposed measurement scenarios, not throughput promises.

Deliver the generic interface and Modbus read path first, then the reviewed scalar write path, then each additional profile. Publish a compatibility sheet only after its gates pass. Use the existing [release process](RELEASE_PROCESS.md) when shipping drivers and their workshops; creating this specification is not a release.
