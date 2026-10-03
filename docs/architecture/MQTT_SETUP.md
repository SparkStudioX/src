# MQTT setup walkthrough

Use an MQTT subscriber connection to turn broker publications into read-only gateway tags. This walkthrough starts with one numeric topic, creates its tag through a reviewed import, and checks the result before using it on a screen.

**Build availability:** use Windows `v0.2.0-preview.13` or a compatible build whose **New Connection** menu includes **MQTT subscriber**, including the Docker `0.2.0-preview.13-docker.1` candidate. Windows preview.12 and Docker `0.2.0-preview.11-docker.1` do not include this feature. See the [release ledger](PARITY.md) for publication status, exact-package verification and real-source acceptance limits. The walkthrough was reviewed October 2, with release compatibility updated October 3, 2026.

**Default Docker profile:** use UTF-8 scalar payloads, receipt timestamps and arrival ordering without expressions. Scripted JSON/XML extraction and timestamp/sequence/epoch expressions require a separately qualified delegated cgroup v2 deployment. The shipped Compose profile does not provide it, and an enabled worker-dependent mapping can stop the connection from starting. See the [Docker source-expression limitation](DOCKER_RELEASE.md#source-expressions-in-the-default-container).

## Where do I create the tags?

Start in the connection. **Browse / refresh → select points → Preview point and tag import → Apply reviewed import** saves the selected source points and creates their gateway tags together. You do not need to create those same tags again in the Tags tab.

You can also create tags later in **Tags**, using a point already saved in the connection. **Add point** and **Import / edit JSON** only prepare point definitions; they need **Save connection** and do not create tags. MQTT additionally offers an explicit **Automatic (opt in)** mode, described below. The main walkthrough uses **Observe and review import** so you can choose each tag's path and type first.

## Before you start

Have an engineering session signed in as a gateway administrator, a reachable MQTT broker, its supported protocol and transport, and credentials allowed to subscribe to your topics. The broker must be reachable from the gateway machine or container. `127.0.0.1` means the gateway's own host or container, rather than your browser's computer.

Ask the publisher owner for a topic, example payload, update interval and whether messages are retained. For this example, a publisher sends the UTF-8 text `23.5` to `plant/line1/temperature` every second. Replace those illustrative values with your own. SparkStudio subscribes and reads; it does not publish test messages, write tags back to MQTT, or interpret Sparkplug messages as a Sparkplug client.

## 1. Create the broker connection

1. Open **Gateway Settings → Configuration → Connections**.
2. Choose **New Connection → MQTT subscriber**, give it a recognizable name such as `Line 1 MQTT`, and leave the connection enabled.
3. Enter **Broker endpoint** and select the matching **Transport**. Use the broker's actual address and port:

| Broker endpoint example | Transport | What to confirm |
| --- | --- | --- |
| `mqtt://broker.example.com:1883` | TCP | Plain MQTT listener |
| `mqtts://broker.example.com:8883` | TLS | TLS listener and trusted server certificate |
| `wss://broker.example.com/mqtt` | WebSocket | Broker's exact WebSocket path; `ws://` is the plain variant |

4. Set **Protocol** to **MQTT 5**, or **MQTT 3.1.1** if that is what the broker supports. Keep **Session expiry (seconds)** at `0` for MQTT 3.1.1.
5. Under **Authentication mode**, select **Username and password** and enter the broker credentials, or use **None** if the broker permits it. Keep credentials in these fields rather than the URL.
6. Leave **Client identity** blank to generate and retain an identity on first save. The starting session settings are **Keep alive (seconds)** `30`, **Clean start** checked, and **Session expiry (seconds)** `0`.

For a private CA or mutual TLS, expand **Certificates and server identity** and enter the existing gateway certificate references supplied by your administrator. These fields accept reference names, not PEM contents or local file paths. On later edits, leaving the saved password placeholder unchanged retains it; **Clear password** removes it.

## 2. Map the topic and test the connection

1. Under **Topic mappings**, choose **Add mapping**.
2. Set **Topic filter** to `plant/line1/temperature`. A filter such as `plant/line1/#` can discover several topics; start with one known topic while checking setup.
3. Set **Owned root** to an unused namespace such as `[default]MQTTDemo`. Keep **Tag creation** at **Observe and review import**.
4. Set **Payload** to **UTF-8 scalar**, **Declared type** to `Double`, and **Result shape** to **Scalar**. This expects a numeric text payload such as `23.5`. A JSON object needs extraction, as shown later.
5. Leave **QoS** at `0`, **Retained messages** at **Cached · Uncertain_Retained**, and **Strip topic levels** at `0`. For a publisher that updates every second, set **Freshness deadline (ms; 0 disables)** to `5000`. The default `0` disables this stale-value check; choose a deadline appropriate to your publisher.
6. Choose **Save connection**, then **Test connection**. Test is unavailable while there are unsaved connection changes or the connection is disabled.

Expect the broker connection and subscription to succeed. A successful test confirms connectivity and subscription, but does not prove a matching publisher has sent data. This review mode begins observing topics even when **Saved source points** is empty; you do not need a dummy tag.

## 3. Browse the observed topic and create its tag

1. Have the publisher send a fresh matching message, then choose **Browse / refresh** under **Observed topic catalog**.
2. Use **Browse children** to reach the topic's value. A topic can have both its own value and child topics; expand it if necessary. **Load next page** retrieves additional entries when offered.
3. Set **Import root** to your intended tag folder before selecting points. MQTT suggestions can already contain a complete provider path, so inspect the selected row's actual **Tag path** rather than relying only on this root.
4. Select the value's checkbox. In the selected-points table, confirm `Double` and set its tag path to `[default]MQTTDemo/Temperature`.
5. Choose **Preview point and tag import**. Review every selected path and type, then choose **Apply reviewed import**.

Apply saves the point map and tags together. No follow-up **Save connection** is needed for this import. If other configuration changes invalidate the preview, preview again. Each reviewed transaction accepts at most 1,000 points; begin with one before importing a larger branch.

## 4. Verify the live reading

1. Under **Saved source points**, choose **Read** beside the imported point, or **Read first 256 points** for a small map.
2. Check the value, quality, **Source** timestamp and **Receipt** timestamp. For a fresh non-retained publication in this example, expect `23.5` with `Good` quality. A payload without a source timestamp can show Source as `unknown`; Receipt records gateway arrival.
3. Open **Tags**, find `[default]MQTTDemo/Temperature`, and confirm its current value and quality.
4. Ask the publisher to send a different value, such as `24.0`, and confirm the reading changes. MQTT **Read** retrieves the subscription's cached state; it does not request a fresh value from the publisher.

The default retained-message policy produces `Uncertain_Retained` for cached retained publications. A retained value is useful at startup, but does not prove live traffic. With the example freshness deadline, stopping fresh publications eventually gives `Uncertain_Stale`; seeing a connected broker does not override that quality. Open **Diagnostics** for subscription, decoding, recovery and resource-limit details.

## Add a tag later from the Tags tab

Use this route when the connection already has a saved point and you want to choose its tag separately.

1. If necessary, choose **Add point** in the connection. Supply a stable **Point ID**, **Point name**, the exact MQTT topic as **Raw address**, its **Data type**, and **Mapping**. Choose **Apply point to draft → Save connection**. For **Explicit saved points** mappings, the filter must be an exact topic, without wildcards.
2. Open **Tags → New Tag → Device point tag**.
3. Set **Tag path**, then confirm **Value source** is **Device / industrial source point**.
4. Choose **Device / source connection**, then **Saved point**, leave the tag enabled and choose **Save**. The point fixes its data type and read-only status.

Connection acquisition owns the subscription. Creating another tag or changing a tag's scan group does not establish another broker session. For reusable models, see [tag models](TAG_MODELS.md).

## Extract a value from JSON

If the publisher sends an object instead of scalar text, change the mapping before importing its points. For example:

```json
{"value":23.5,"timestamp":"2026-10-02T15:00:00Z"}
```

1. Set **Payload** to **Scriban extraction**, **Extraction expression** to `json(payload).value`, **Declared type** to `Double`, and **Result shape** to **Scalar**.
2. Optionally set **Source timestamp expression (optional)** to `json(payload).timestamp`. The timestamp must follow the publisher's actual format and contract.
3. In **Mapping test**, choose the mapping, enter the matching **Topic** and the example **Test payload**, then choose **Test mapping**. This evaluates the current draft without changing live values or tag definitions. A new connection must have been saved once to enable the panel.
4. Confirm the result's value, type and timestamp, choose **Save connection**, then send a real publication and verify its reading. A supplied test payload is not a broker message.

Missing fields fail extraction unless the expression guards them; a `null` result skips delivery. For object expansion, use **Declared / discovered structure** and review the resulting leaves. **Snapshot · omitted leaves become NoData** suits full snapshots; **Patch · omitted leaves stay unchanged** suits partial updates. Choose this according to the publisher's message contract.

Script extraction needs the gateway's supported isolated worker environment. If **Test mapping** reports worker containment unavailable, that deployment cannot run extraction; use scalar publications or have the gateway administrator provide the supported environment.

## Optional automatic tag creation

After verifying a small reviewed mapping, you can use **Tag creation → Automatic (opt in)** for a namespace meant to follow discovery. Choose an unused **Owned root**, review the filter and inferred or declared types, keep **Mapping tag cap** appropriate to the expected size, and save. Matching valid publications can then create the owned source points and tags without a separate import. **Prune after (seconds; 0 disables)** defaults to `0`; leave it disabled until you intend healthy source absence to remove unused definitions.

Automatic ownership keeps stable identities and locked types. It rejects collisions and referenced removals. Deleting a generated tag in **Tags** suppresses its rediscovery. To deliberately restore it, return to **Automatic ownership and suppression → Load ownership → Allow rediscovery**. Changing an owned root or **Strip topic levels** requires reviewing the namespace migration and using **Save reviewed migration**. Check the proposed tag paths before applying.

## Topic mapping field reference

A mapping is a rule with three jobs: choose which topics to receive, turn each message's payload into values, and decide how those values become tags. It does not create a new broker connection. The same connection can have several mappings for different topic families or payload formats.

For example, a topic `plant/line1/temp` with payload `23.5`, root `[default]MQTT`, **UTF-8 scalar**, **Double** and **Strip topic levels** `0` proposes `[default]MQTT/plant/line1/temp` with value `23.5`. In review mode it appears in the observed catalog for import; in automatic mode it can become a tag as messages arrive. With strip `1`, the proposed path becomes `[default]MQTT/line1/temp`. The broker topic remains `plant/line1/temp` in both cases.

### Topics and tag creation

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Mapping | Chooses which saved/draft rule you are editing. | Add a mapping for each topic family that needs different handling. |
| Mapping enabled | Receives and processes this rule's matching topics. Disabling it retains saved readings with `Bad_Disabled` quality. | Keep enabled while testing. Disabling a mapping does not disable the whole connection. |
| Mapping ID | Stable identifier connecting this rule to its saved points. It is not an MQTT topic or tag path. | Keep the generated ID, or choose a recognizable ID before saving. Saved IDs cannot be renamed. |
| Topic filter | Selects broker topics to subscribe to. `+` matches one topic level; `#` matches the remaining levels and must be last. More specific matching rules take precedence. | `plant/line1/temp` matches one topic. `plant/+/temp` matches a temperature topic for each one-level line name. `plant/#` matches `plant` and everything below it. Matching is case-sensitive. |
| Owned root | Starting folder for suggested tag paths. Automatic mode reserves it exclusively for that mapping's generated tags. | `[default]MQTT` means the MQTT folder in the default tag provider. Use an unused folder for Automatic. Review mode lets you edit the proposed paths before importing. |
| Tag creation | Determines whether messages update explicitly saved points, populate a catalog for review, or create owned tags automatically. | Start with **Observe and review import**; the three modes are compared below. |
| Strip topic levels | Removes leading topic folders from suggested/generated tag paths. It changes neither the subscription nor the raw topic identity. | For `plant/line1/temp`, `0` keeps all levels, `1` removes `plant`, and `2` leaves `temp`. Do not strip every level. Distinct topics can collide after stripping; review paths first. |

| Tag creation mode | What happens when a matching message arrives | How you get tags |
| --- | --- | --- |
| Explicit saved points | Updates only points you have explicitly declared and saved. Requires an exact topic filter without wildcards and a scalar result. | Save the point map in Connections, then create **Device point tag** entries in Tags using those saved points. |
| Observe and review import | Discovers valid topics/values in the observed catalog without creating tags automatically. Existing saved points can still receive updates. | Browse, select rows, choose paths/types, then **Preview point and tag import → Apply reviewed import**. |
| Automatic (opt in) | Creates and maintains source points and tags under its owned root as valid messages arrive, subject to types, collisions and capacity. | Inspect the generated tags in Tags; no separate import is required. Removing a generated tag suppresses its rediscovery. |

### Message values

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Payload | Chooses how to interpret message contents. **UTF-8 scalar** reads one number, Boolean or text value. **Scriban extraction** evaluates an expression against the message. | Scalar examples: `21` becomes `Int64`, `21.5` becomes `Double`, `true` becomes `Boolean`, and `ready` or `"ready"` becomes `String`. JSON objects/arrays require extraction. |
| Declared type | Converts results to a selected type. **Infer once and lock** chooses the type of each topic/child from its first accepted non-null value and rejects later incompatible types. | Choose `Double` for a sensor that may send `21` now and `21.5` later. Inference from the first `21` would lock that leaf to `Int64`. |
| Result shape | **Scalar** delivers one value per topic. **Declared / discovered structure** expands an extracted object or array into individual child values. Incompatible shape changes are rejected after the initial shape is established. | Use Scalar for one temperature. Use Structure for an extracted object containing temperature and pressure, then browse its children. Structure is unavailable in Explicit saved points mode. |
| Structured updates | Defines what an omitted child means in a later structured result. **Snapshot** clears previously saved omitted children to `Bad_NoData`; **Patch** retains their prior values. | If a previous result contains temperature and pressure, then the next contains only temperature, Snapshot clears pressure; Patch keeps it. An explicitly `null` child skips its update in both modes; it does not clear the previous value or refresh freshness. |
| Extraction expression | Appears for Scriban extraction. Returns one scalar or a structure matching Result shape. Missing fields fail unless guarded; a whole `null` result skips the message. | For `{"value":23.5}`, use `json(payload).value`. For structured delivery, return the object/array you want expanded. Check the expression with **Test mapping**. |
| Source timestamp expression (optional) | Reads the publisher's observation time separately from gateway receipt time. It does not itself change message ordering. | For an ISO-8601 UTC timestamp in a JSON `timestamp` member, use `json(payload).timestamp`. Leave blank if there is no publisher timestamp. |

### Delivery, freshness and cleanup

| Field | What it does | Starting choice or example |
| --- | --- | --- |
| Retained messages | Controls a broker's replay of its saved message at subscription time. **Cached · Uncertain_Retained** accepts it with uncertain quality; **Treat as current · Good** explicitly trusts it as current; **Ignore** skips it. | Keep Cached until you know the publisher's retained-data contract. Default cached replay does not refresh a leaf's freshness timer. Explicitly trusted Good replay does refresh that timer, but retained replay never counts as live publisher traffic in the connection's last-live metric. |
| QoS | Requested subscription delivery level. `0` does not acknowledge delivery; `1` acknowledges delivery and can redeliver a message. | Start with `0` unless broker/publisher requirements call for `1`. QoS 1 alone does not make an application update happen exactly once. |
| Freshness deadline (ms; 0 disables) | Maximum time without an accepted fresh value before retaining the previous value with `Uncertain_Stale` quality. Tracked separately for each leaf. | `5000` means 5 seconds. Choose a deadline longer than the normal update interval plus expected delay. `0` disables this check. |
| Application ordering | Determines which admitted message may replace current state. **Arrival order** uses receipt order. **Publisher sequence and epoch** or **Qualified timestamp and epoch** skips equal/older values for each topic within the same publisher run. | Keep Arrival order unless the publisher provides an explicit ordering value and run/session identity. The required extra expression fields appear when selecting another mode. |
| Mapping tag cap | Maximum active tags owned by an automatic mapping. A proposed batch exceeding the cap is rejected together. It is not the review catalog's size limit. | Applies only to Automatic. Size it for expected topics and structured children; each expanded child counts as a tag. |
| Prune after (seconds; 0 disables) | Removes unreferenced automatic tags whose values have been absent for the configured healthy interval. Requires continuous healthy connectivity/admission for that whole interval; disconnects or degraded admission reset that qualification. | Applies only to Automatic. `3600` means 1 hour; `0` disables cleanup. Referenced definitions remain protected, and downtime is not healthy absence. |

### Publisher ordering expressions

These fields appear only when Application ordering is set to a sequence or timestamp mode. Leave ordering at Arrival order when your publisher has no defined reset/run contract.

| Field | What to supply | Example |
| --- | --- | --- |
| Publisher sequence expression | An increasing nonnegative exact whole number. Equal or lower numbers in the same epoch are skipped. | `json(payload).sequence` for `{"sequence":42,"bootId":"run-7","value":23.5}`. |
| Ordering timestamp expression | The publisher's ISO-8601 timestamp used to reject equal or older messages in the same epoch. Separate from merely recording a source timestamp. | `json(payload).timestamp`. |
| Publisher epoch expression | A run/session identity that changes when numbering or the ordering clock restarts. Messages from already superseded epochs are ignored. | `json(payload).bootId`; the publisher must change `bootId` when it starts a new run. |

Use **Mapping test** to check the selected mapping, example topic and payload before saving. It evaluates your current draft without changing live tags or definitions. After saving, verify a real broker publication; a successful supplied-payload test does not prove broker delivery.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| MQTT subscriber is missing | Build availability above; the current published installers lack this feature. |
| Test fails | Broker address from the gateway, transport/port/path, protocol, credentials, subscription permissions and certificate trust. |
| Connected, but catalog is empty | Enabled mapping, matching case-sensitive topic/filter, an actual publisher message, and decoding details in Diagnostics. MQTT has no general broker topic-directory browse. |
| `Bad_WaitingForInitialData` | No accepted value has arrived for this point yet. |
| `Uncertain_Retained` or `Uncertain_Stale` | Retained policy or freshness deadline; obtain a fresh publication and check its receipt time. |
| `Bad_DecodingError` or `Bad_TypeMismatch` | Payload mode, extraction expression and locked type. A JSON object is not scalar numeric text. |
| Import rejected | Duplicate paths, existing tag references, current connection revision, point/tag capacity or type conflicts. Correct the conflict and preview again. |

These tags are read-only and cannot serve as equipment command targets. Once their quality is acceptable, add a display in Designer and bind its property through **fx → Tag**; [property bindings](PROPERTY_BINDINGS.md) explains the reference and expression controls. Save and explicitly publish the project to make the screen available to operators. Gateway connection and tag changes take effect separately from project publication.

For the other source setup paths, see [MTConnect](MTCONNECT_SETUP.md) and [i3X](I3X_SETUP.md).
