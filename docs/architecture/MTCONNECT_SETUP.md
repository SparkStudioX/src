# MTConnect setup walkthrough

Connect an MTConnect agent, browse its devices and turn selected observations into read-only gateway tags. This walkthrough uses an example CNC named `Mill01`; replace the example URL and names with your agent's values.

**Build availability:** use Windows `v0.2.0-preview.13` or a compatible build whose **New Connection** menu includes **MTConnect agent**, including Docker `0.2.0-preview.13-docker.1`. Windows preview.12 and Docker `0.2.0-preview.11-docker.1` do not include this feature. See the [release ledger](PARITY.md) for publication status, exact-package verification and real-source acceptance limits. The walkthrough was reviewed October 2, with release compatibility updated October 3, 2026.

## Where do I create the tags?

You can create tags directly from the saved connection: browse, select points, choose their tag paths, then **Preview point and tag import → Apply reviewed import**. This saves the source points and their gateway tags together. They immediately appear in **Tags**; you do not need to create them again there or click **Save connection** after applying that import.

You can also declare and save source points in **Connections**, then create tags for those points in **Tags**. **Add point** and **Import / edit JSON** prepare the connection's point map only; they do not create tags. Use the connection import for initial setup, and the Tags workspace for additional tags and tag configuration.

## Before you start

- Sign in as a gateway administrator with access to engineering configuration.
- Obtain the agent's base URL and any authentication details. The gateway machine must be able to reach it; a URL that works only on your browser's computer is insufficient.
- Use an agent serving MTConnect XML namespaces **2.5–2.8**. Have at least one device with current observations available.
- If HTTPS uses a private certificate authority or client certificates, obtain the existing gateway certificate references from your administrator.

This client reads observations, conditions, DATA_SET and TABLE values. It does not send commands to a machine, write registers or provide a lossless event journal.

## 1. Create and test the connection

1. Open **Gateway Settings → Configuration → Connections**.
2. Choose **New Connection → MTConnect agent**.
3. Set **Connection name** to a recognizable name such as `Mill01 agent`, and leave **Connection enabled** checked.
4. Set **Base URL** to your agent's base address, for example `https://agent.example.com`. Include any required base path, but do not append `/probe`, `/current` or `/sample`; SparkStudio requests those resources.
5. Leave **Acquisition** at **Polling** and **Poll / sync interval (ms)** at `1000` for the first check. The allowed interval is `1000–60000` ms.
6. Choose the appropriate **Authentication mode**: **None**, **Username and password**, **Bearer token**, or **API key**. Enter the credentials in those fields, rather than in the URL. For an API key, use the header name required by your agent.
7. Initially leave **Device filter** and **XPath filter** empty to discover the agent's catalog. If your administrator supplied a filter, enter it under **Agent filters and stream**.
8. If required, expand **Certificates and server identity** and enter the gateway's certificate references or server certificate SHA-256 pin.
9. Click **Save connection**, then **Test connection**.

Expected result: the test accepts the agent's probe and reports its version and catalog information. A successful probe confirms the connection and metadata; it does not prove every observation has a usable current value. Use the read check below before relying on a tag.

If you change any connection setting, save it again before testing or browsing. An unsaved draft disables those operations. Saved password/token placeholders retain the existing secret when left unchanged.

## 2. Browse a device and create tags

1. In **Browse source**, click **Browse / refresh**. The root lists devices.
2. Click **Browse children** beside your machine, such as `Mill01`. Use **Load next page** if more results are available.
3. Choose **Import root** before selecting points. Its default is `[default]Sources/<connection-id>`, using the saved connection's ID. You can use a clearer root such as `[default]Machines/Mill01`.
4. Review each item's name, raw address, category, representation and units. Check the import box beside the observations you need. Start with one numeric observation and one state, if your machine provides them.
5. Review the selected rows' **Type** and **Tag path**. The suggested paths include the device and component hierarchy. You can replace a path with a simpler one, such as `[default]Machines/Mill01/SpindleSpeed`, if it is unique. Keep numeric readings numeric and state/condition text as `String`.
6. Click **Preview point and tag import**. Review the proposed points/tags and resulting tag count.
7. Click **Apply reviewed import**.

Expected result: the selected source points are saved and matching tags appear in **Tags** under the reviewed paths. The operation applies all selected rows together. A conflict, invalid type or stale review prevents the import; correct it and preview again.

**Select device points** selects a device's supported items for review. It does not save them. The special `Agent` device is excluded from that bulk selection; browse it explicitly if you need its observations. Each reviewed transaction accepts at most **1,000 points**; import larger devices in smaller selections. Unsupported representations can remain visible for inspection without an import checkbox.

The import root seeds newly selected rows. Changing it after selecting rows does not rewrite their existing **Tag path** values: edit those paths or clear and reselect the points before previewing.

## 3. Verify current values

1. Find the imported point under **Saved source points** and click **Read**, or use **Read first 256 points** for a small map.
2. Check **Current value**, its quality, and the displayed **Source** and **Receipt** timestamps. Source time comes from the agent; receipt time is when the gateway received the observation.
3. Open **Tags**, locate the path you imported and confirm its value and quality there too.

Expected result: an available, correctly typed observation has **Good** quality. A machine-reported `UNAVAILABLE` becomes **Bad_NoData** with no usable value. An agent can be connected while an individual observation remains unavailable. A communication failure can retain an earlier value with bad quality; check quality alongside the number.

## 4. Create a tag later in Tags

Use this route when the source point is already saved but you want another tag or a different path.

1. If needed, declare the point in the connection with **Add point**. Copy its exact raw address from the catalog, choose its data type and optional selector, click **Apply point to draft**, then **Save connection**. For a map file, use **Import / edit JSON → Validate map → Apply reviewed map to draft**, then save the connection.
2. Open **Tags → New Tag → Device point tag**.
3. Enter the **Tag path**, such as `[default]Machines/Mill01/SpindleSpeed`.
4. Confirm **Value source** is **Device / industrial source point**.
5. Choose the saved MTConnect connection under **Device / source connection**, then its point under **Saved point**.
6. Review the settings and click **Save**. The selected point supplies the data type; the tag editor locks that field.

Expected result: the tag reads the existing saved point. You cannot select an undeclared point here, and you do not need a second connection. These tags remain read-only. See [tag engineering](TAG_ENGINEERING.md) for further gateway tag configuration.

## Conditions and structured observations

A condition's default selected value is its `level`: for example, `NORMAL`, `WARNING` or `FAULT`. Use **Browse children** on the condition to select `nativeCode`, `nativeSeverity`, `message` or `active` separately. These are `String` values; `active` contains the current active-condition list as JSON text.

DATA_SET and TABLE items can be read as JSON text in a `String` point. For a specific member, declare a separate point with the same **Raw address** and a **Selector (separate from address)**. A DATA_SET key `toolCount` uses `/toolCount`; a TABLE row `row1` and column `temperature` use `/row1/temperature`. Escape a literal `/` in a key as `~1` and a literal `~` as `~0`. Choose the member's actual scalar type. A missing or removed member becomes **Bad_NoData**. Supported 3D observations also expose `x`, `y` and `z` child selections.

Keep the raw address and selector separate. Tag display names and paths can be chosen for your application; they are not the agent's source identity.

## Optional: use a streaming sample

After polling works, change **Acquisition** to **Subscription / stream** if your agent supports streaming samples. Start with **Heartbeat (ms)** `10000` and **Observations per sample** `1000`, then **Save connection**. Heartbeat accepts `1000–60000` ms; sample count accepts `1–10000` observations.

SparkStudio reduces condition and collection updates to current values. After an agent restart or an expired sample cursor, it refreshes current state and resumes acquisition. Check **Diagnostics** for recovery and data-loss information. Short-lived transitions can be coalesced, so use an appropriate history/event system if every transition must be retained.

## Show the result in Designer

Once the tag has **Good** quality, bind a Designer display to its reviewed tag path. For example, use a numeric display for spindle speed or a text binding for the condition level. See [property bindings](PROPERTY_BINDINGS.md) for the **fx** editor and tag references. Save the project, check Preview, then publish the project when the screen is ready. Gateway connection/tag changes take effect independently of project publication.

## Connection field reference

Start with polling and no filters. Save and test the connection, then browse and import one or two observations before narrowing the catalog or enabling a stream. Changing a connection field creates a draft; save it before testing, browsing or reading.

### Address and acquisition

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Connection name | Friendly name shown in the connection list and tag editor. It is separate from the agent's device identifier. | `Mill01 agent`. |
| Connection enabled | Allows this connection to acquire data. | Keep checked during setup. Disabled connections cannot be browsed, read or imported. |
| Base URL | Address of the agent as reached from the gateway machine. SparkStudio adds the probe, current and sample resource names. | `https://agent.example.com`, or an address with the agent's required base path. Do not append `/probe`, `/current` or `/sample`, or put credentials in the URL. HTTP and HTTPS are supported. |
| Acquisition | **Polling** reads current-state snapshots. **Subscription / stream** seeds current state and requests subsequent sample observations. Both supply read-only values. | Start with Polling. Use Subscription / stream after confirming your agent supports streaming samples. |
| Poll / sync interval (ms) | In polling, the wait between current-state requests. In streaming, the interval requested from the agent for sample delivery and the wait before opening another completed sample request. It is not a value freshness deadline. | `1000` means 1 second; default `1000`, allowed `1000–60000`. The actual update rate also depends on agent behavior and request duration. |

### Authentication

Use the credentials and authentication method required by the agent or its HTTP proxy. Passwords and tokens are stored protected on the gateway. A saved-secret placeholder retains the existing secret when left unchanged; **Clear password** or **Clear token** removes it.

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Authentication mode | Chooses how requests identify the gateway to the agent. **None** sends no credentials; the other modes show their required fields. | None for an agent that permits anonymous reads; otherwise use the method supplied by its administrator. |
| Username | Appears for **Username and password**. The account name used for HTTP Basic authentication. | An account with permission to read the agent's metadata and observations. |
| Password | Appears for **Username and password**. The account's password; sent with the username using HTTP Basic authentication. | Enter the password in this protected field. Use HTTPS when sending credentials across the network. |
| Bearer token | Appears for **Bearer token**. Sends the token in the HTTP `Authorization` header. | Paste the supplied token without adding the word `Bearer`; SparkStudio adds that prefix. |
| API key | Appears for **API key**. Sends the supplied key in a dedicated HTTP header. | Paste the key itself, then confirm its header name below. |
| API-key header | Appears for **API key**. Names the header carrying the key. It must match what the agent or proxy expects. | Default `X-API-Key`. Use a dedicated header; `Authorization`, `Cookie`, `Host` and transport headers are not accepted here. |

### Certificates and server identity

These settings apply to HTTPS. Leave them blank when the server's certificate is already trusted and no client certificate is required. A certificate **reference** is the name of a certificate already installed on the gateway, not a URL, local file path or pasted certificate. Ask the gateway administrator for the references.

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Trusted CA certificate reference | Uses an installed CA certificate to trust an agent certificate issued by a private authority. | A gateway reference such as `plant-ca.pem`. Leave blank to use the gateway's normal certificate trust. |
| Client certificate reference | Identifies an installed client certificate when the agent requires the gateway to prove its identity with a certificate. | A reference supplied by your administrator. The certificate needs its private key. |
| Client private-key reference | Identifies the installed key for a separate PEM client certificate. | Fill only with the corresponding client certificate reference. Leave blank when the installed client-certificate bundle already contains its key. |
| Server certificate SHA-256 pin | Requires the agent's server certificate to match a specific fingerprint instead of using normal certificate-chain trust. Certificate hostname and validity dates must still match. | Exactly 64 hexadecimal characters, without separators, supplied by your administrator. A renewed certificate requires a matching pin update. |

### Agent filters and stream

Device and XPath filters narrow what the agent returns for probe, current and sample requests. They do not choose gateway tag paths. Leave both blank for initial discovery; an incorrect filter can hide devices or observations you expect to browse.

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Device filter | Optional device identifier recognized by the agent. SparkStudio puts it before the resource name in request URLs. | `Mill01` requests resources such as `/Mill01/current`. Blank targets the full agent. Use the exact identifier accepted by your agent; maximum 512 characters. |
| XPath filter | Optional agent-side expression sent as the `path` query parameter. The agent evaluates it against its device model. This is separate from a point's Selector. | Leave blank to avoid XPath filtering. `//DataItem` selects data items; use a narrower expression only when its meaning has been confirmed for your agent. Maximum 2,048 characters. |
| Heartbeat (ms) | **Streaming only.** Requests a complete stream document even when observations do not change. SparkStudio schedules recovery when no complete document arrives for three times this interval. | Default `10000` means 10 seconds; allowed `1000–60000`. This does not control polling or create a tag update for every machine event. |
| Observations per sample | **Streaming only.** Maximum observations requested in a sample response/document. This is not the number of gateway tags. | Default `1000`; allowed `1–10000`. Larger batches can require larger document/decode limits. |
| HTTP User-Agent | Client identification sent in HTTP requests. It can help the agent or proxy identify this reader. | Keep `SparkStudio/1.0` unless your administrator requires another valid HTTP User-Agent. Required, at most 256 characters, without control characters. |

Conditions and collection deltas are reduced to current state before tag delivery. A stream can coalesce short-lived transitions. Use a separate event/history system when every transition must be retained.

## Point and tag import field reference

A source point identifies the observation and optional member to read. A tag gives that point an application path. Use the connection's reviewed import to create both together, or save a point first and create its tag in **Tags**.

| Field or control | What it does | Example or expected behavior |
| --- | --- | --- |
| Point ID | Stable gateway identity used by saved tag references. It is not the agent's data-item ID or a tag path. | Keep the generated ID. Choose a custom ID before first save if needed; saved IDs cannot be edited. |
| Point name | Friendly name for the saved point. It does not change the source address. | `Spindle speed`. |
| Raw address | Exact source identity copied from the catalog: the device UUID followed by the data-item ID. | `machine/speed`. Use the catalog address, rather than the device's display name, a URL or a gateway tag path. |
| Selector (separate from address) | Optional part of a structured observation. Leave blank for a whole scalar value. | Condition `level`, 3D component `x`, DATA_SET `/toolCount`, or TABLE `/row1/temperature`. See the structured-observation examples above. |
| Data type / Type | Gateway scalar type for this point's selected value. Browse proposes a suitable type; select the member's actual type when declaring a structured selector. | `Double` for spindle speed, `Int64` for a supported integer count, or `String` for a condition level or whole collection serialized as JSON text. |
| Import root | Prefix used to propose paths for newly selected catalog rows. It does not rewrite paths already selected. | `[default]Machines/Mill01`. Set it before selecting rows, or edit the selected rows' Tag path values afterward. |
| Tag path | Application address of the proposed gateway tag. It is independent of the raw source address. | `[default]Machines/Mill01/SpindleSpeed`. Each imported path must be unique and compatible with existing definitions. |
| Select device points | Selects supported observations from a device for review; it does not save them. | Use for small devices. The special Agent device is excluded; browse it explicitly. Import at most 1,000 points per reviewed transaction. |
| Preview point and tag import | Checks the selected source identities, types and paths against the current saved configuration. | Review the proposed rows and resulting tag count before applying. Other configuration edits invalidate the preview. |
| Apply reviewed import | Saves the reviewed source points and their tags together. | The tags immediately appear in Tags; no second Save connection is required for this import. |
| Add point / Apply point to draft | Declares a point in the connection draft without creating a tag. | Save connection, then choose that saved point when creating a Device point tag in Tags. |
| Load source map file / Source points JSON | Prepares a point-map draft from an array of point definitions, or a JSON object with a `points` array. | Each point needs `id`, `name`, `address` and `dataType`; `selector` is optional and `writable` must be false. Validate, apply the reviewed map to the draft, then save the connection. This does not create tags. |
| Read / Read first 256 points | Fetches current state from the agent for the selected saved points and reports values, quality and timestamps. | Confirm Good quality before using a value. A connected agent can still return UNAVAILABLE or a missing member as Bad_NoData. |

## Advanced limits and timeouts

Leave **Effective limits and timeouts** at the defaults during initial setup. Byte counts limit decoded documents or estimated working state, rather than allowing unlimited responses. Lower limits can reject an otherwise valid large catalog, collection or sample. Test and Diagnostics show the effective settings; gateway-wide resource budgets can still prevent an operation even when this connection's limits are satisfied.

| Field | What it controls | Default and accepted range |
| --- | --- | --- |
| HTTP / XML document bytes | Maximum decoded bytes in one probe/current XML response or one complete streaming sample document. | `1048576` (1 MiB); `1024–8388608`. |
| Bytes per value | Maximum UTF-8 bytes in a returned value, including a whole collection encoded as JSON text. An oversized value reports Bad_DecodingError. | `65536` (64 KiB); `1–65536`. |
| Canonical state bytes | Bounds the estimated current observation state held while reducing conditions and collections, and the values delivered to saved points. | `16777216` (16 MiB); `1024–16777216`. |
| Ingress queue bytes | Shared input limit used by MQTT and i3X. MTConnect reads bounded HTTP/XML documents instead; use its document, decode and state limits to control acquisition size. | `8388608` (8 MiB); `1024–8388608`. Changing this setting does not change MTConnect document buffering. |
| Pending input records | Shared input limit used by MQTT and i3X; it does not control MTConnect acquisition. It is not a requested sample count or tag count for MTConnect. | `4096`; `1–4096`. Use Observations per sample to change the MTConnect sample request count. |
| Catalog entries | Maximum data items admitted from the agent's probe. A larger catalog is rejected rather than silently imported as a complete one. | `10000`; `1–10000`. |
| Catalog metadata bytes | Maximum estimated metadata held for the probe catalog, including identities, names, component paths and units. | `8388608` (8 MiB); `1024–8388608`. |
| Request timeout (ms) | Deadline for a complete ordinary HTTP probe/current request, including reading its response body. Streaming document health uses Heartbeat instead. | `2000` (2 seconds); `100–30000`. |
| User operation timeout (ms) | Overall deadline for a user-requested operation such as Test, Browse or Read, including waiting for the connection's operation slot. | `10000` (10 seconds); `100–30000`. |
| Connect timeout (ms) | Deadline for establishing the HTTP transport; also bounds waiting for stream response headers. It is separate from the complete-request deadline. | `5000` (5 seconds); `100–30000`. |
| Decoded nodes | Maximum XML nodes parsed from one document. | `65536`; `1–65536`. |
| Decode working bytes | Maximum estimated temporary storage used while decoding one document. Large XML can require more working memory than its received byte length. | `33554432` (32 MiB); `1024–33554432`. |

## Troubleshooting

| What you see | What to check |
| --- | --- |
| MTConnect agent is missing from New Connection | Use Windows preview.13 or a compatible build containing source sessions; see the Docker guide and release ledger for container availability. |
| Test connection, browsing or import is disabled | Save the draft, enable the connection and save that change. |
| Probe/version error | Use the agent base URL and confirm it serves a supported 2.5–2.8 XML namespace, rather than an HTML page or a login redirect. |
| Unauthorized or certificate error | Match the agent's authentication mode/header and HTTPS certificate requirements. |
| No device or point appears | Confirm the agent publishes the device; check Device/XPath filters, paging and any catalog-limit diagnostics. |
| Connection works but a reading is Bad_NoData | Check the agent's current observation for UNAVAILABLE or a missing structured member. |
| A tag is absent after Add point or JSON editing | Save the point map, then create the tag in Tags; those controls do not import tags. |
| Import is refused after another edit | Review path/type conflicts and preview again against the saved configuration. |
| Wrong type or decoding error | Match the selected observation/selector to its scalar type and inspect Diagnostics. |
| Streaming repeatedly recovers or reports gaps | Inspect agent restarts, sample-buffer retention, network interruptions and stream support; confirm polling works first. |

For other read-only sources, see the [MQTT walkthrough](MQTT_SETUP.md) and [i3X walkthrough](I3X_SETUP.md).
