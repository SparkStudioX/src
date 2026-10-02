# MTConnect setup walkthrough

Connect an MTConnect agent, browse its devices and turn selected observations into read-only gateway tags. This walkthrough uses an example CNC named `Mill01`; replace the example URL and names with your agent's values.

**Build availability:** these steps require a SparkStudio build whose **New Connection** menu includes **MTConnect agent**. The published Windows `v0.2.0-preview.12` installer and Docker `0.2.0-preview.11-docker.1` image do not contain this choice. This is a development-build guide, reviewed October 2, 2026.

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

## Troubleshooting

| What you see | What to check |
| --- | --- |
| MTConnect agent is missing from New Connection | The installed build does not include this development feature. |
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
