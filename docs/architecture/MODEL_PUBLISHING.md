# Publish modeled equipment over MQTT

Model publishing sends saved equipment values from the gateway to an MQTT broker. It does not read a controller a second time: it reads the same modeled values, quality and timestamps shown in the live model object. Configure it from **Models > Inspect & share > Share > Publish MQTT**. You need Engineering **Configuration** permission; operator sessions cannot configure, test, preview or discard publisher queues.

This requires a build containing Model operations and outbound model publishing. Earlier preview.13 installers and Docker images do not include these features. Publishing uses MQTT 3.1.1 over TCP or TLS with QoS 0 or 1. QoS 2, WebSocket transport, custom certificate upload and automatic unit conversion are not offered here.

## First publisher

1. Save the model and equipment through **Review and apply**. Unsaved equipment cannot be published. Open its live object and resolve unexpected quality or mapping issues first.
2. Open **Inspect & share > Share > Publish MQTT** and create a publisher. The panel guides you through **Choose equipment**, **Connect to a broker**, **Preview the messages**, **Test the connection** and **Enable delivery**. Leave **Enable publishing when saved** off while setting it up.
3. Enter `mqtt://broker:1883` or `mqtts://broker:8883`. Put credentials in their separate fields, never in the endpoint. TLS checks the server hostname and certificate against the gateway's trusted certificate authorities. A self-signed broker needs its authority installed in that trust store.
4. Select the saved equipment and a topic prefix, such as `plant/models`. Choose **One object per equipment** or **Leaf topics**.
5. Choose **On change** or **Interval**. **Delivery options** contains the interval, QoS, retained-message and queue controls; broker credentials are under **Broker login (optional)**. Preview the resulting topics and payloads. **Save and test broker** explicitly saves a disabled configuration before connecting and authenticating; **Test saved broker** tests an already saved configuration. Testing sends no model messages. An enabled unsaved configuration requires a separate explicit save before testing. An accepted connection alone does not prove that the account can publish to the selected topics.
6. Enable and save when ready to send those values to that broker. Watch delivery diagnostics and inspect the broker subscriber. Disabling stops new captures and disconnects the worker; an operation already in flight can finish. Pending messages stay on disk.

Passwords are protected by the gateway's existing Data Protection keyring. The settings API reports only whether a password exists. Leaving the password field blank preserves the saved password; explicit removal clears it. Moving a protected keyring to another machine or service account may require reentering the password.

## Topics and payloads

With prefix `plant/models`, equipment `[default]Acme/Line1/Press01` produces:

| Shape | Topic |
| --- | --- |
| Equipment object | `plant/models/default/Acme/Line1/Press01` |
| Leaf topic for Load | `plant/models/default/Acme/Line1/Press01/Load` |

Each provider, equipment and field path segment is percent-encoded. A space becomes `%20`; a literal `#` becomes `%23`. Separators remain `/`. This avoids wildcard characters and preserves distinct source names. Prefixes cannot contain wildcards, empty levels, control characters or a leading `$`.

An object contains `equipmentPath`, `definitionId`, `version`, `generation`, `capturedAt`, and nested `members`. Each field envelope includes its value, data type, modeled `quality`, original `sourceQuality`, `modelIssues`, available timestamps and metadata. A leaf message carries the field envelope plus `equipmentPath` and `capturedAt`. Internal connection IDs, node addresses and reference targets are omitted. Int64 values retain the model API's exact wire representation.

`capturedAt` is when the gateway sampled the object for publishing. `sourceTimestamp` is the source-provided time when known; `receiptTimestamp` is the gateway's sample receipt time. Unknown times stay null. Publications are snapshots of current modeled values; they are not a lossless record of every controller sample.

**On change** compares values, qualities, issues, metadata and model identity. Timestamp-only changes do not create another message. Its interval controls how frequently the gateway checks for changes. **Interval** enqueues a complete snapshot at every interval, even when values are unchanged. Intervals range from 250 ms to one day. Up to 100 equipment items may be selected per publisher, with at most 16 publishers.

## Delivery, queues and recovery

Every accepted message is saved to the gateway's bounded disk queue before transmission. Queue defaults are 1,000 messages and 10 MiB per publisher; configurable limits are 1–10,000 messages and 1 KiB–64 MiB. A message payload cannot exceed 256 KiB. If an equipment object is too large, use leaf topics or reduce its fields. A capture batch is limited to 10,000 messages and 64 MiB. Preview shows at most 100 messages and 1 MiB, with the full count and a truncation indicator.

| Setting or condition | Behavior |
| --- | --- |
| QoS 0 | Removed after the socket write completes. This is best effort and does not prove broker receipt. |
| QoS 1 | Removed only after the broker's PUBACK. A retry or restart can deliver duplicates; consumers must tolerate them. Broker receipt does not prove downstream consumer processing. |
| Retain | Broker retains the most recently delivered value on each topic. Deleting or disabling a publisher does not clear retained broker messages. |
| Broker unavailable | Sampling continues within the queue limits. Delivery retries with backoff, up to 30 seconds between attempts. |
| Queue full | The whole newest capture batch is rejected. Existing queued messages remain; rejection counters and a clear error are visible. On-change mode retries the latest current value at the next capture, so intermediate rejected values are not recoverable. |
| Gateway restart | Pending messages reload and are retried. An initial current snapshot can also be captured again. |
| Change destination with backlog | Saving a different endpoint, topic, equipment selection, shape, QoS or Retain setting is blocked until the queue drains or is explicitly discarded. Pending data is never silently redirected. |
| Delete/discard | Requires a deliberate action. Messages already in flight can finish. Broker-retained messages remain until separately cleared. |

Diagnostics show connection state, pending count/bytes, delivered messages, retries, rejected messages, last delivery and the last error. Delivery/retry/rejection counters describe the current gateway process; the queue itself persists across restarts. New publishers start disabled.

**Delivery status** stays visible below setup, including errors and queue counts. While publisher edits are unsaved or a request is running, switching tools or workspace views is blocked; save or explicitly discard the edits first. Equipment names lead the selection list, with complete model paths below them.

The protected configuration is stored in `model-publishing.json` under the gateway data directory. Pending values live in `model-publishing-queue/<publisher-id>.json`. Normal process restarts preserve both. Online **configuration** backups include publisher settings and keys but exclude runtime queues. An **offline full** backup includes pending queues. Restored gateways stay in recovery quarantine, which blocks both broker tests and automatic publishing until recovery is approved and the gateway restarted. A damaged queue is not silently discarded; preserve it and repair or restore it offline.

## Synthetic Model operations workshop

The independently authored [recipe](../../examples/model-operations.json) configures three synthetic presses. It is **gateway setup**, not a `.sparkproj` import, and does not execute itself. Use an isolated development gateway. Reserve `[default]ModelOperations/`, `WorkshopPress`, `WorkshopMemory` and `workshop-press`; if they already belong to something else, use different names consistently.

### Set up and inspect

1. Inspect `modelRecipe` in the recipe. It contains nine synthetic memory source tags, WorkshopPress v1, a separate WorkshopMemory source mapping, two locations and three equipment instances.
2. Merge `modelRecipe` into the Models draft using its import flow. Review the expanded fields and reference targets, then explicitly apply. Do not import the entire outer recipe as a tag package.
3. Open the live object for each press. Loads should be 28, 64 and 91. The model supplies the field contract; the mapping uses `{Device}` to resolve the existing source tags. No controller, database or network connection is involved.
4. The `Load` contract has a 0–100 range, supported UCUM `%` unit and an example high-load alarm at 80 with a deadband of 2. `State` allows `idle`, `running` and `fault`; `CycleCount` uses an exact Int64. These are teaching defaults, not recommended process limits.

### Distinguish invalid data from alarms

Follow `valueExercises` by explicitly writing **source memory tags** in Tags:

1. Set Press01 Load to **91**. The value is valid and Good; its high-load alarm becomes active.
2. Set it to **120**. The value remains 120 and source quality remains Good, but modeled quality becomes `Uncertain_ModelValidation`. Issues explains the expected range. The alarm holds its previous active state while the modeled quality is uncertain; invalid data is not treated as a new valid process threshold crossing.
3. Set it to **70**. Model quality recovers and the high-load alarm clears below the deadband. Alarm acknowledgment remains a separate alarm workflow.
4. Set Press01 State to `maintenance`. Observe the enum issue, then restore `running`.
5. Give only Press02's Load field a **2,000 ms freshness override**. Apply, wait without writing the source, and inspect the stale issue. Write the same source value **64** again: a new receipt clears staleness even though the value is unchanged. Memory tags measure time since initialization or an explicit write; they are not periodically sampled hardware. Remove the freshness override after this exercise.

### Review a version upgrade and export dependencies

1. Inspect and merge `upgradeRecipe`. WorkshopPress v2 adds a synthetic Temperature field with default 25 °C, and WorkshopMemoryV2 keeps the original three reference mappings.
2. Review the compatibility and affected-equipment report. Apply the upgrade to **Press01 only**, with its v2 mapping. Press02 and Press03 remain pinned to v1. Adding a field still deserves review; compatibility classification is not permission to migrate every consumer automatically.
3. In a disposable Designer project, bind a numeric display to Press01 Load. Inspect dependencies to find the source tags, model, equipment and that screen.
4. Export only Press01 with source-tag inclusion. The selection should include its pinned model, mapping, ancestor locations and three authored source tags, without the other two instances. Check external dependencies. Model export never embeds connection credentials or broker publisher settings. Importing the exported model still requires the normal preview and apply review on its destination.

### Optional broker exercise

Use a separate disposable MQTT 3.1.1 broker with QoS 1 support. The existing read-only data-source simulator deliberately rejects client publications and is not a publishing target. In Docker, `127.0.0.1` refers to the container itself; set the explicit reachable lab endpoint instead.

1. Create the disabled publisher described by `publisherRecipe`. Preview first: the equipment object topic is `spark/workshop/default/ModelOperations/Plant/Line1/Press01`. Switch to leaves and check the `/Load`, `/State`, `/CycleCount` and, after upgrade, `/Temperature` topics.
2. Save disabled, test the broker, then enable deliberately while a subscriber observes `spark/workshop/#`. Write a new synthetic Load value and inspect its value, quality and timestamps.
3. Stop the broker and change Load again. Confirm queued messages and retries. Restart the broker and watch the backlog drain. The UI's delivered count means broker PUBACK at QoS 1, not downstream application completion.
4. Disable publishing before cleanup. Drain or explicitly discard pending messages, then delete the workshop publisher. Remove disposable screen references, equipment, mappings, definitions and synthetic source tags through reviewed operations. Retained messages need separate broker cleanup if Retain was enabled.

Automated verification uses an isolated loopback broker fixture, synthetic memory data, real MQTT packets and temporary directories. It checks credential redaction, QoS/retain, missing acknowledgments, queue bounds, restart replay, on-change behavior, backup coverage and recovery quarantine without modifying a running gateway.
