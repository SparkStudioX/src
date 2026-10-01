# Industrial protocol support plan

This SparkStudio support plan is dated October 1, 2026. The first four implemented drivers require `0.2.0-preview.12` or a later compatible release. Preview.11 and earlier do not include them. Exact artifact/source evidence is recorded separately in [Verification and roadmap](PARITY.md). Entries marked planned remain future work, and actual controller/firmware acceptance remains a deployment requirement. The companion [technical specification](INDUSTRIAL_CONNECTOR_SPECIFICATION.md) defines the wider target design and acceptance criteria. The [implementation guide](INDUSTRIAL_DEVICE_CONNECTIONS.md) records the supported profiles and current setup.

The first expansion adds Modbus TCP, Allen Bradley EtherNet/IP, Siemens S7 and Beckhoff ADS behind a common device-session contract and service facade. OPC UA remains the general integration path. MQTT, Sparkplug and MTConnect remain planned.

## Current SparkStudio baseline

The current source implements OPC UA endpoint discovery, browsing, reads, monitored subscriptions and explicit scalar equipment writes. SQLite and SQL Server are database connections with schema/query/update operations; they are not industrial register protocols. Source support and the hardware acceptance recorded for a particular release remain distinct. See [connection operations](CONNECTION_OPERATIONS.md), [connector behavior](../../src/SparkStudio.Connectors/README.md) and [equipment commands](EQUIPMENT_COMMANDS.md).

The proposed priorities below follow coverage, implementation complexity and compatibility with the current tag and command models. They do not assume a particular installed fleet. An identified customer deployment can change the order.

## Core protocol list

In this table, native browsing means device-provided metadata. Map browsing means navigating an authored or imported address map. Neither connection success nor discovery alone proves that a particular address can be read or written.

| Priority | Protocol and initial scope | Connection and address model | Browse and acquisition | Proposed write scope | Status |
| --- | --- | --- | --- | --- | --- |
| Baseline | OPC UA client Data Access | Endpoint, certificates, identity; namespace URI and node identifier | Native object/variable tree; reads and monitored items | Scalar Value writes through existing equipment commands | Implemented baseline; metadata and paging improvements proposed |
| First | Modbus TCP | Host, port, unit ID; four address spaces with zero-based offsets | Map browsing; grouped polling | Coils and holding registers only; typed scalar values | Implemented in source; Modbus loopback tested |
| First | Allen Bradley EtherNet/IP explicit messaging | Host and selected ControlLogix, CompactLogix, Micro800, MicroLogix, SLC 500 or PLC-5 family; Logix numeric route or direct blank route; symbolic/PCCC addresses | Native controller/program listing for ControlLogix/CompactLogix; saved maps for Micro800/PCCC; polling | Scalar words/numbers/Boolean bits and PCCC ST strings; Logix/Micro800 String excluded | Implemented family subsets in source; actual controller acceptance pending |
| First | Siemens S7 classic communication | Host, CPU family, rack/slot; memory area, DB and byte/bit offset | Imported/manual map; serialized polling | Approved DB/marker destinations; controller permissions required | Implemented in source; S7 loopback tested; non-optimized layouts |
| First | Beckhoff TwinCAT ADS | Local/target AMS Net IDs, target host, ADS port and routes; symbol path | Native symbol/type browsing; typed polling | Approved scalar symbols with fresh metadata checks | Implemented in source; actual TwinCAT acceptance pending |
| Second | Modbus RTU over serial | Serial device, line settings, unit ID; same register maps as TCP | Map browsing; serialized bus polling | Same typed destinations as TCP; acknowledged unicast only | Planned extension; not a current driver |
| Second | MQTT 3.1.1 and 5.0 | Broker, TLS, identity, subscriptions; topic and payload mapping | Observed/configured topic catalog; push updates | Explicit command-topic mapping with correlation and application acknowledgement | Planned; message publish is not register confirmation |
| Second | Sparkplug B | MQTT plus group, node, device and host role; birth-defined metrics | Birth/metric catalog; sequence and birth/death tracking | Allowlisted NCMD/DCMD mappings when a device supports commands | Planned host profile; validate against a selected spec version |
| Second | MTConnect agent | HTTP(S) agent, device identity and data item ID | Probe-derived tree; current/sample observations | No equipment writes in this profile | Planned telemetry integration |
| Second | OPC UA events and alarms/conditions | Existing UA connection plus event source and filters | Event field/type discovery; event subscriptions | No register write implied; condition methods need a separate specification | Planned event extension |
| Later | OPC DA legacy bridge | Windows COM/DCOM server identity and host | DA item tree, groups and quality/timestamps | Initially read-only bridge; writes require separate acceptance | Prefer conversion to OPC UA; native helper only for an identified need |
| Later | Haas machine telemetry | Model-specific TCP query/stream profile and documented fields | Defined field catalog; polling/stream | Read-only initial profile | Planned vendor adapter |
| Later | FANUC robot interfaces | Licensed SDK/controller options, host and supported channel | SDK-defined variables/register groups | Initial read-only profile; explicit register writes only after vendor-specific acceptance | Planned vendor adapter |
| Later | Yaskawa robot interfaces | SDK/controller profile and supported transport | Defined variables/I/O/status catalog | Initial read-only profile; no implicit robot actions | Planned vendor adapter |
| Later | Productive Robotics WebSocket | Robot host and supported firmware/API profile | Defined telemetry message schema | Initial read-only; commands require a separately defined API | Planned vendor adapter |
| Later | ASC CPC and SmartPac | Manufacturer/model profile, TCP host and command framing | Authored field catalog; bounded request/response polling | Read-only until documented writable fields are available | Planned proprietary adapters |
| Later | TCP ASCII and UDP profile adapters | Host/port plus fixed framing/parser and allowed message forms | Configured field maps, never arbitrary network scanning | Only explicitly defined command schemas; no free-form operator packets | Planned framework for site-specific devices |
| Later | Timebase WebSocket subscriptions | Historian endpoint, dataset and tag identity | Configured dataset/tag catalog; timestamped push observations | Read-only historian subscription initially | Planned telemetry adapter |
| Later | SNMP | Version, target, identity and OID/MIB selection | OID tree or imported MIB; GET/walk polling | Read-only initial profile; SET is separate acceptance | Planned diagnostics connector |
| Later | ROS 2 | Domain, middleware/profile, topic and message type | Topic/type catalog; typed subscriptions | Telemetry initial scope; services/actions/publish commands need a separate specification | Planned robotics integration |

EtherNet/IP in the first release means explicit PLC data access. It does not mean an implicit I/O scanner, CIP Safety, motion control or support for every CIP device. ODVA distinguishes explicit request/response messaging from implicit real-time I/O. [ODVA technology overview](https://www.odva.org/publication_download/ethernet-ip-technology-overview/)

The current EtherNet/IP profiles use pinned libplctag .NET 1.5.2 / NativeImport 1.0.41, native core 2.6.0. ControlLogix/CompactLogix provide native catalogs; Micro800 and the three PCCC families require saved maps. Logix String maps and operations are rejected until controller structure-schema qualification is implemented; SDK buffer defaults and prior synthetic layout tests do not prove that schema. Direct-only PCCC covers N/B words and masked word bits, F and standard ST files; only MicroLogix adds L files. Micro800 supports symbolic numeric/Boolean values, including WORD/DWORD storage, with no String, program-scope or numeric-bit profile. DH+ routes, DF1, PCCC I/O/status/timer/counter structures and custom strings remain outside the implemented scope. See the [family/address matrix and setup-required workshop](INDUSTRIAL_DEVICE_CONNECTIONS.md#ethernetip-family-setup) and [pinned library family handling](https://github.com/libplctag/libplctag/blob/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258/src/protocols/ab/ab_common.c).

MTConnect is a read-only equipment observation path; publishing observations to an agent does not write machine registers. [MTConnect](https://www.mtconnect.org/)

## Supporting integration sources

The full source coverage also includes integration sources that do not address industrial registers. They should share validation, quality and diagnostics where appropriate, while retaining their own database, message or computed-source contracts.

| Source family | Proposed SparkStudio treatment | Browse and read model | Write policy |
| --- | --- | --- | --- |
| SQL Server | Retain current database connector | Schema browser and bounded parameterized named queries | Current named updates; separate from equipment commands |
| PostgreSQL | Add database connector after the core device wave | Schema browser, typed named queries and query limits | Named parameterized updates with transaction/uncertainty rules |
| PostgreSQL LISTEN/NOTIFY | Add optional PostgreSQL notification acquisition | Configured channels and payload schema | Publishing notifications is a database action, not a register write |
| Redis | Add optional data integration connector | Configured keys, explicit type catalog and qualified event/poll strategy | Explicit configured-key updates; no raw operator key commands |
| ActiveMQ | Add optional broker connector | Configured destinations and typed message subscriptions | Allowlisted message publishing; equipment commands require a separate acknowledgement mapping |
| HTTP webhook receiver | Add authenticated ingestion connector | Configured local routes and request schema | Ingestion does not grant equipment-write authority |
| HTTP JSON | Add bounded HTTP data source | Configured endpoint, JSON field/schema browser and read projections | Read-only initial profile |
| HTTP XML | Add bounded HTTP data source | Configured endpoint, namespace-aware field/XPath catalog | Read-only initial profile |
| Script/computed source | Keep within the current scripting/tag architecture | Authored outputs and explicit type definitions | Script output does not bypass the equipment-command workflow |
| Weather service | Optional generic HTTP example | Configured API/coordinates and response fields | Read-only; not an industrial-driver priority |
| AI process source | Exclude from the industrial connector implementation | Separate product feature only if requested | No direct equipment-write privileges |

UDP is covered by the profile-adapter row above; it represents passive ingestion or a documented device profile, not a generic reliable register transport. Generic WebSocket integrations follow the same approach as Timebase and the robot telemetry profiles.

## Candidates outside the core list

BACnet/IP and BACnet/SC, Mitsubishi MC/SLMP, Omron FINS, DNP3 and IEC 60870-5-104 should remain an evaluation backlog until a device model and deployment need are identified. Each needs its own connection, addressing, command and acceptance profile. Omron NJ/NX EtherNet/IP access must also be evaluated separately from Allen Bradley controller acceptance.

PROFINET I/O, EtherCAT, CANopen/DeviceNet, IEC 61850 and safety or motion networks are separate integration projects. A gateway protocol client does not establish real-time controller or fieldbus-master capability. Prefer an existing OPC UA or MQTT bridge where it meets the deployment requirements.

No native FANUC CNC FOCAS, Mitsubishi MC/SLMP, Omron FINS, BACnet, DNP3 or IEC 104 support is asserted by this plan. Machine and robot products must be named separately in compatibility lists.

## Recommended delivery order

1. Establish the driver registry, structured address model, metadata browser, scan planner and common driver acceptance suite. Adapt the current OPC UA implementation without changing its command permissions.
2. Deliver Modbus TCP connect/test, manual/imported register maps and polling reads. Then qualify scalar coil/register writes and readback using the same equipment-command workflow.
3. Complete identified-device read/write acceptance for the source EtherNet/IP family subsets, classic S7 and ADS. Test ControlLogix, CompactLogix, Micro800, MicroLogix, SLC 500 and PLC-5 independently; expand bridge/address/type subsets only after their own fixtures and hardware checks.
4. Extend the Modbus mapping/codec to RTU. Add MQTT ingestion and Sparkplug host catalogs; introduce message commands only when correlation, expiry and acknowledgement requirements are satisfied.
5. Add MTConnect, UA events and selected manufacturer adapters according to actual fleet demand. Schedule legacy and specialty protocols after their platform, SDK and licensing requirements are established.

## Definition of supported

A protocol is supported only when a published compatibility profile names the gateway OS/architecture, driver and SDK versions, controller/device model, tested firmware, connection/security options, address and type subset, browsing mode, scan limits and supported write destinations.

The profile must include simulator and identified-device evidence for connect, browse, read, disconnect/reconnect and configuration lifecycle. Writable profiles additionally require accepted/rejected writes, lost-response uncertainty, readback and permission/replay tests. A working connection test or a library's advertised capability is insufficient. See the [acceptance gates](INDUSTRIAL_CONNECTOR_SPECIFICATION.md#acceptance-and-delivery-gates).
