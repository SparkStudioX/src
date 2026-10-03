# Read-only data sources and workshop

Windows preview.13 Connections includes **MTConnect agent**, **i3X source** and **MQTT subscriber**. Older preview.12 installers and Docker preview.11-docker.1 do not include them; see the [release ledger](PARITY.md) for exact-package verification and acceptance limits. The three drivers have a separate source configuration and share stable point catalogs with PLC connections. A saved tag uses `kind: "device"`, its connection ID and the saved point ID. Raw MTConnect identities, opaque i3X element IDs and MQTT topics remain separate from display paths and structured selectors.

These are current-state sources. Their latest-value delivery may coalesce updates after protocol reduction. They do not provide a lossless event journal. All three are read-only at the catalog, command dispatcher and protocol adapter. MQTT sends no Publish or Will configuration. Use subscribe/read-only broker credentials when configuring a real broker.

## Connect, browse and import

Open **Gateway Settings → Configuration → Connections → New Connection**. Choose a source, enter its endpoint and protocol settings, then save. HTTP authentication supports None, Basic, Bearer and a configurable API-key header. MQTT supports a username/password. Saved secrets appear as placeholders: an unchanged field retains the protected secret, while **Clear** deliberately removes it. Existing gateway CA, client-certificate, private-key references and a server SHA-256 pin can be configured under Certificates and server identity. i3X requires HTTPS outside loopback; plain HTTP is available only for loopback development. Choose authentication according to the i3X service's requirements. **None** is allowed for both local and remote services that do not require credentials.

**Test connection** reports capabilities and version evidence. **Diagnostics** shows the connection's acquisition state, generation/binding revision, recovery reason, driver counters and effective limits. Transport availability and source-data freshness are separate. Source timestamps remain distinct from gateway receipt times; the quick-watch result shows both. Int64 values above JavaScript's exact-number range use decimal strings in browser/API results.

**Browse / refresh** returns bounded pages. **Browse children** explores a folder, MTConnect condition/vector selectors, i3X structured fields or an observed MQTT topic. **Load next page** continues the current catalog. Truncation is explicit. Browsing uses metadata and does not issue one read for every displayed point. A MQTT topic can have both its own value and children: both rows remain visible, including a real child named `value`.

Select points and review their names, raw identities, types, selectors and candidate paths. **Preview point and tag import** checks the full transaction, namespace collisions, capacity and existing references. **Apply reviewed import** commits saved points and tags together. A changed connection or tag configuration invalidates the preview. Transactions contain at most 1,000 points; maps contain at most 10,000 points and 768 KiB. **Add point** and **Import / edit JSON** prepare a connection draft and require a later Save. JSON files are bounded to 2 MiB and are validated before draft apply. Saved point IDs remain fixed when editing an existing point.

Use **Tags → Device / industrial source point** to bind a saved point. Its type comes from the point catalog and is not editable on the tag. **Tag models → Definitions → Add saved source point member** creates a UDT member bound to the same stable point ID. UDT expansion, scopes, expressions, alarms, history and Designer tag browsing use the common catalog; none grants write access to a read-only point.

## Driver behavior

| Source | Acquisition and engineering behavior |
| --- | --- |
| MTConnect | Qualified XML namespaces 2.5–2.8; bounded independently authored parser. Polling reads current. Subscription seeds current and resumes multipart sample at `Header.nextSequence`. Expired cursors, instance/model changes and stream failure trigger visible recovery. Conditions use condition IDs with native-code fallback where needed; DATA_SET/TABLE deltas and tombstones are reduced before tag delivery. Unsupported representations remain browse-only. Device bulk selection excludes Agent unless points are explicitly selected. |
| i3X | i3X 1.0 HTTP read client with opaque element IDs, separate JSON-pointer selectors and per-item bulk failures. Subscription uses advertised SSE or sync fallback and bounded authoritative reconciliation, normally every 30 seconds. Reconciliation is configurable from 5–300 seconds. The client acknowledges only accepted sync batches and recreates expired subscriptions. Delivery remains best effort. |
| MQTT | Connection-owned subscription starts enabled review/automatic mappings even with zero saved points or tags. Read returns cached VQT rather than requesting a new publication. Scalar or sandboxed Scriban extraction supports explicit saved points, observed review and opt-in automatic trees. Filter specificity determines precedence. Retained policy, stale deadline, shape/type locking, snapshot/patch omissions, publisher ordering/epoch, caps and pruning are explicit mapping options. |

The gateway limits documents, scalar values, canonical state, queues, catalogs, script input/results and temporary decode storage. Global admission is tracked separately by resource category:

| Source resource | Global ceiling |
| --- | --- |
| Ingress queues | 64 MiB |
| Canonical state | 128 MiB |
| Temporary decode storage | 256 MiB |
| Delivered/cached values | 128 MiB |
| Catalog metadata | 128 MiB |
| Isolated script workers | 1 GiB |

Per-connection ceilings apply in addition to these global budgets. Queue exhaustion and protocol gaps are visible; overload cannot create partial definitions or silently merge colliding identities. Script extraction runs in bounded isolated workers: Windows uses Job Objects; Linux requires a delegated cgroup memory profile. Script workers fail closed when their required containment is unavailable. Malformed input, missing fields, type changes, forbidden operations and limit failures appear as diagnostics and quality rather than silently changing types.

## Worker deployment and artifact sizes

Gateway build/publish targets include the executable worker under `source-worker/`. The Docker build retains that folder through the published payload and notice stages. The portable and three RID-specific worker lock files resolve the same Scriban 7.5.0 package. Windows installer and Docker notice inventories merge worker dependencies with gateway dependencies; their SBOM includes Scriban once with its reviewed BSD-2-Clause notice.

The 2026-10-01 development artifact audit measured about **77.4 MiB** uncompressed for the Windows self-contained worker folder, including a separate .NET runtime, and about **0.574 MiB** for each Linux framework-dependent worker. The two new managed assemblies are Scriban (563,712 bytes) and the worker (36,352 bytes). Summing independent raw-DEFLATE level-9 file sizes gives about 35.3 MiB for the Windows worker and 0.220 MiB for Linux. These are disk payload measurements; the worker process-memory ceiling remains 256 MiB.

A comparable Windows .NET/native binary plus dependency/runtime-configuration subset grew about 77.9 MiB uncompressed and 35.4 MiB under that compression method relative to the manifested preview.12 publish at source commit `f094906712abe07c663f5d841886b76bf13559e3`, using the same .NET 10.0.12 runtime. This comparison excludes symbols, browser assets, Python, the service helper, notices and manifests. It is not an exact installer or release-archive growth measurement: the candidate is a development build and the compression sums exclude archive headers. Full release packaging must record its own actual assets and provenance. The earlier 3–4 MB estimate does not describe the self-contained Windows worker layout.

`node tools/test-docker-notices.mjs` guards deployment/package pins and reviewed Windows/Docker notice parity. `node tools/test-engineering-policy.mjs` verifies that worker-only dependencies enter the deterministic merged SBOM. Local managed-package inventory audits retained the original reviewed notices on all three RIDs; their synthetic OS-runtime inventory fixture does not qualify a final Docker image or native runtime execution.

## Load the independently authored workshop

This is a setup-required project, cataloged as **Read-only data sources**. The project contains displays and instructions; it configures no gateway resources. The fixture payloads and protocol servers were authored independently and use synthetic data. They are not production agents, protocol-conformance servers or a production broker.

From `source/`, start the loopback fixtures in a terminal:

```powershell
node tools/run-data-source-simulators.mjs
```

The endpoints are MTConnect `http://127.0.0.1:5310`, i3X `http://127.0.0.1:5311/v1` and MQTT `mqtt://127.0.0.1:18890`. They bind only to loopback. Stop them with Ctrl+C. The fixture broker supports MQTT 5 and 3.1.1, QoS 0 subscriptions, retained replay and ping; it rejects subscriber Publish attempts. The i3X fixture advertises sync delivery. MTConnect supports current, probe and multipart sample.

Set `SPARKSTUDIO_ADMIN_AUTH_FILE` to an ignored local administrator credential file, then load an unpublished project on an isolated gateway:

```powershell
node tools/load-data-sources-example.mjs http://127.0.0.1:6090
```

The loader creates only **Read-only data sources workshop** and refuses a duplicate project name. It never configures connections/tags or publishes. Review the screens in Designer, configure the synthetic sources below, then explicitly publish to view them in the operator application. Unconfigured values remain unavailable. The operator needs readable scope for `[default]SourceWorkshop/` and Operate permission; source configuration requires the engineering Configuration capability.

## MTConnect exercise

1. Create **Workshop MTConnect** with the loopback MTConnect endpoint, None authentication, Polling and a 1,000 ms interval. Save and Test. The fixture reports 2.8 XML and a synthetic CNC plus Agent.
2. Browse the root. Agent's bulk selector is excluded. Browse **Synthetic CNC**, select its speed and part-count points, and browse System for the `level` selector. Review their paths as `[default]SourceWorkshop/CNC/Speed`, `/Count` and `/Condition`, respectively. Use Double, Int64 and String. Preview, inspect the raw addresses, then Apply reviewed import.
3. Read the saved points. The exact part count is greater than `9007199254740991`; browser/API decimal strings must retain every digit. The reduced condition cycles between Normal and Fault.
4. Switch acquisition to Subscription, set heartbeat to 1,000 ms and save. Diagnostics should show one connection monitor. Disconnect/restart the fixture to observe communication quality and visible recovery. Test and Browse remain available during acquisition.
5. For the UDT acceptance example, add a `SyntheticCNC` definition with saved source-point members Speed, Count and Condition, using the catalog pickers in Tag models. Create an instance under `[default]SourceWorkshop/CNCUnit`. Observe its values in Tags and Designer browse. Optionally bind an expression or a history item to Speed and an alarm to an explicitly authored condition expression. Source write actions remain unavailable.

The `sourceRecipes` in [data-sources.json](../../examples/data-sources.json) include a complete read-only map with raw addresses `workshop-cnc/speed`, `workshop-cnc/count` and `workshop-cnc/condition`. They are configuration examples, not automatically applied by the project loader. Choose either reviewed native import or manual map/tag authoring so the same definitions are not imported twice.

## i3X exercise

1. Create **Workshop i3X** with `http://127.0.0.1:5311/v1`, None authentication and Polling. Save and Test. Loopback permits this development-only HTTP profile.
2. Browse **Synthetic cell** and select Temperature and Part count. Browse State and select its `/running` Boolean selector. Review paths as `[default]SourceWorkshop/i3X/Temperature`, `/Count` and `/Running`; preview and apply.
3. Read points and inspect the separate raw IDs `workshop:temperature#1`, `workshop:count#1` and `workshop:state#1`. The `#` belongs to the element ID. It is not a URL fragment or a selector. `/running` remains a separate JSON pointer.
4. Switch to Subscription with 5-second reconciliation. The fixture does not advertise SSE, so Diagnostics should show sync fallback. Pausing or restarting the fixture exposes communication quality and subscription recovery; a reachable `/info` alone does not prove healthy delivery.

## MQTT review, scripts and owned trees

1. Create **Workshop MQTT** with `mqtt://127.0.0.1:18890`, MQTT 5, TCP and None authentication. Add mapping ID `review`, filter `workshop/review/#`, root `[default]SourceWorkshop/MQTT/Review`, Review tag creation, scalar payload, strip two levels, cap 100 and freshness deadline 3,000 ms. Leave the saved point map empty. Save.
2. After messages arrive, Browse / refresh lists temperature and count with zero saved tags. Review-import them. Keep Double temperature and Int64 count, and inspect retained versus live quality. A retained replay starts `Uncertain_Retained` unless the mapping deliberately treats retained values as current.
3. Add mapping `script`, exact filter `workshop/script/cell`, root `[default]SourceWorkshop/MQTT/Script`, Review, script payload, Int64 and expression `json(payload).value`. Set timestamp expression `json(payload).timestamp`. In Mapping test paste the `scriptTest.payload` from the authored example. A draft mapping can be tested on a saved connection. The result shows typed extraction/leaf information, timestamp, timing and diagnostics; testing creates no values or definitions. Try a missing `value` field or an invalid timestamp and inspect the visible failure.
4. Add mapping `tree`, filter `workshop/tree/#`, root `[default]SourceWorkshop/MQTT/Tree`, Review, scalar, strip two levels and cap 100. Save and browse `a/b`, `a/b/c` and `a/b/value`. The own value of `a/b` remains its original topic; the literal `value` child remains a different identity. Review import any desired selection without creating newly observed siblings.
5. To exercise automatic ownership, use a fresh unoccupied root (or remove the unreferenced reviewed tree tags/points first). Deliberately choose Automatic for `tree` and Save. Ownership shows stable generated point IDs, paths and locked types. Update workshop display bindings if you selected a new root. Disable/re-enable retains definitions and identities.
6. Remove an unreferenced automatically owned leaf in Tags. The next message must not immediately recreate it. Load ownership: its persisted state is Suppressed. **Allow rediscovery** clears suppression deliberately, subject to namespace, type and capacity checks. Pruning is a separate healthy-absence policy and retains identity/type for rediscovery. It is not driven by disconnected time.
7. Change the automatic mapping root or strip policy. Save first presents a namespace migration preview with point IDs and before/after paths. Inspect reference/collision errors before **Save reviewed migration**. Restart/backup restore must preserve ownership, suppression and locked types before accepting new traffic.

Stable generated definitions, locked schemas and ownership changes commit durably immediately. Ownership `lastSeen` updates are coalesced with a maximum five-second persistence interval; this timestamp metadata can lag the most recent accepted observation by that interval. Coalescing does not defer definition or schema commits.

For a freshness-only exercise, pause MQTT publications while leaving the fixture transport alive:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5310/fixture/control -ContentType application/json -Body '{"paused":["mqtt"]}'
```

After the mapping deadline its known live leaves become `Uncertain_Stale`. Other mappings or retained replay do not refresh those leaves. Resume with body `{"paused":[]}`. `GET http://127.0.0.1:5310/fixture/state` shows synthetic traffic counters; `mqttPublishAttempts` must stay zero. The control endpoint changes only fixture behavior.

## Qualification and cleanup

Run `node apps/web/check-source-connections.mjs` for offline catalog, protected-secret, point/map, browse/import, script-test, suppression and migration engineering checks. Run `node tools/test-data-sources-workshop.mjs` for authored-workshop/catalog and loopback fixture checks. The connector test runner has separately authored MTConnect/i3X/MQTT protocol suites. The gateway source suite qualifies common catalog, read-only enforcement, imports, generation fencing and persisted ownership. Hardware, external server implementations and production broker interoperability still need their own identified acceptance evidence.

Delete the workshop project when finished. Delete generated/authored workshop tags and UDT instances before deleting their connections; saved references can block removal. Automatic tag deletion records suppression deliberately. Stop the synthetic fixture process. No source writes or equipment commands are needed for this workshop.
