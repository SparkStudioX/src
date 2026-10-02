# i3X setup walkthrough

Connect to an i3X 1.0 API, browse its elements, and create read-only tags for selected current values. Start with polling and one element so you can verify the API address, authentication and data type before adding a larger model.

**Build availability:** these steps require a SparkStudio build whose **New Connection** menu includes **i3X source**. The published Windows `v0.2.0-preview.12` and Docker `0.2.0-preview.11-docker.1` do not include this source feature. This is a development-build guide, reviewed October 2, 2026.

## Where do I create the tags?

The recommended route is in the connection: browse elements, select values, then **Preview point and tag import → Apply reviewed import**. Apply saves the selected source points and creates their gateway tags together. You do not need to recreate them in Tags.

Alternatively, save point definitions in the connection and create tags later in **Tags**. **Add point** and **Import / edit JSON** change the point-map draft only; they require **Save connection** and do not create tags. Both routes bind a tag to a stable saved point, rather than treating a displayed element name as its identity.

## Before you start

Have an engineering session signed in as a gateway administrator and obtain the following from the i3X service owner:

- The complete i3X 1.0 API base URL, for example `https://i3x.example.com/v1`.
- The required username/password, bearer token or API key, including its header name.
- A known element you are permitted to browse and read, its expected value/type, and any supported subscription transport.
- Certificate references for a private CA or mutual TLS, if required.

The API must be reachable from the gateway machine or container. **Outside loopback, SparkStudio requires HTTPS and configured authentication for i3X.** Plain HTTP with **None** authentication is permitted only for a local loopback service. A browser reaching the service does not establish gateway connectivity; `127.0.0.1` refers to the gateway's own host or container.

## 1. Create and test the connection

1. Open **Gateway Settings → Configuration → Connections → New Connection → i3X source**.
2. Give it a recognizable name, such as `Line 1 i3X`, and leave it enabled.
3. Set **Base URL** to the service's full API root. Include `/v1` if it is part of that root; do not enter an individual element or current-value URL.
4. Set **Authentication mode** to the service's mode: **Username and password**, **Bearer token**, or **API key**. Fill the displayed credential fields. For an API key, set **API-key header** to the service's required header; its default is `X-API-Key`.
5. Leave **Acquisition** at **Polling** and **Poll / sync interval (ms)** at `1000` for the initial check. The supported interval is 1,000–60,000 ms.
6. Leave **Client identity** blank to generate and retain an identity on first save. Keep **Prefer advertised SSE, with sync fallback** checked and **Reconcile current state every (seconds)** at `30` for later subscription use.
7. Choose **Save connection → Test connection**. Test is unavailable while the connection has unsaved changes or is disabled.

Expect a successful API connectivity result. This does not yet prove that your selected element returns usable data. The following read check establishes that.

For certificate settings, expand **Certificates and server identity** and enter existing gateway certificate reference names. These fields do not accept certificate contents or local file paths. A saved credential placeholder retains its secret when left unchanged; **Clear password** or **Clear token** removes it.

## 2. Browse an element and import its tag

1. Under **Browse source**, choose **Browse / refresh**.
2. Navigate the model using **Browse children**. Use **Load next page** when offered; a folder is a navigation entry, not automatically a value tag.
3. Set **Import root** to an unused tag folder such as `[default]I3XDemo` before selecting points.
4. Select one readable value's checkbox. Inspect its raw element ID and any selector. In the selected-points table, confirm the data type and edit the **Tag path** to a useful name, such as `[default]I3XDemo/Running` for a Boolean value.
5. Choose **Preview point and tag import**. Review the proposed rows and total tag count, then choose **Apply reviewed import**.

Apply commits the selected point definitions and tags together; no follow-up **Save connection** is needed for this import. If configuration changes invalidate the preview, preview again. Each transaction permits at most 1,000 selected points. Unsupported or non-value entries can remain browse-only.

### Keep element IDs and selectors separate

i3X element IDs are opaque. Copy the exact ID returned by the service, including characters such as `#`; do not turn it into a tag folder path or append a member selector to it.

For a structured element, a point might use:

| Field | Illustrative value | Meaning |
| --- | --- | --- |
| Raw address | `urn:line1:machine#state` | Complete service element ID |
| Selector (separate from address) | `/running` | JSON pointer to a member of that element's value |
| Data type | `Boolean` | Selected member's type |
| Tag path | `[default]I3XDemo/Running` | Your gateway's independently chosen name |

For a scalar element, leave the selector empty. Prefer the browsed selector when available; its spelling follows the service's actual structured value.

## 3. Verify current values

1. Under **Saved source points**, choose **Read** beside the imported point, or **Read first 256 points** for a small map.
2. Confirm the expected value, `Good` quality, **Source** timestamp and **Receipt** timestamp. Source can be `unknown` when the service supplies no source time; Receipt describes gateway arrival.
3. Open **Tags**, find the path you created, and inspect its current value and quality.
4. If possible, have the service owner change a known test value. Confirm the next polling result reaches the tag.

Open **Diagnostics** for acquisition, per-element failures, reconnection and resource-limit details. A reachable information endpoint or a connected transport does not prove that every selected element is healthy. Large `Int64` values retain their exact decimal digits and can appear as decimal strings in the browser; avoid converting them to rounded floating-point display values.

## Add a tag later from the Tags tab

1. If the desired point is not saved yet, choose **Add point** in the connection. Enter a stable **Point ID**, **Point name**, exact **Raw address**, optional separate **Selector**, and **Data type**. Choose **Apply point to draft → Save connection**. A manually entered address still needs a successful read to confirm it matches the service.
2. Open **Tags → New Tag → Device point tag** and enter the **Tag path**.
3. Confirm **Value source** is **Device / industrial source point**, choose **Device / source connection**, then **Saved point**.
4. Leave the tag enabled and choose **Save**. The saved point supplies its type and read-only status.

Acquisition belongs to the connection. Tag scan-group settings do not create independent polling or subscription sessions. For reusable equipment structures, see [tag models](TAG_MODELS.md).

## Optional subscriptions

After polling works, change **Acquisition** to **Subscription / stream**, retain **Prefer advertised SSE, with sync fallback**, and choose **Save connection → Test connection**. The connector uses advertised server-sent events when available and falls back to subscription synchronization when needed. The **Poll / sync interval (ms)** controls that synchronization cadence.

Keep **Reconcile current state every (seconds)** at `30`, or choose a value from `5` to `300` appropriate to your service. Reconciliation repairs current-state drift even while a subscription remains connected. Check **Diagnostics** after enabling the mode and verify a changing value again. Subscriptions are best effort and current-state updates can coalesce; this is not a lossless event journal.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| i3X source is missing | Build availability above; current published installers lack this feature. |
| Save rejects the URL or authentication | A non-loopback API requires both HTTPS and configured authentication. |
| Test fails or requests are unauthorized | Full API root, gateway network access, certificate trust, credential mode, API-key header and browse/read permissions. |
| Browse works but a value has bad quality | Exact element ID, selected member, declared type and the service's per-element current-value response. Inspect Diagnostics. |
| `Bad_WaitingForInitialData` or `Bad_NoData` | No accepted initial value, or the service returned no current value for that element/member. |
| `Bad_TypeMismatch` or `Bad_DecodingError` | Selected member's actual shape/type; preserve the raw ID and use a separate JSON pointer. |
| Import conflicts or a stale preview | Tag-path collisions, referenced definitions, point/tag capacity or changed configuration. Resolve and preview again. |
| Stream is connected but values drift | Reconciliation interval, supported SSE/sync behavior and recovery diagnostics; compare with the service's current state. |

The resulting tags are read-only and cannot be used as equipment command targets. Once values have acceptable quality, add a display in Designer and use **fx → Tag** to bind its property; see [property bindings](PROPERTY_BINDINGS.md). Save and explicitly publish the project for operators. Saving gateway connections or tags does not publish a project.

For other source setup paths, see [MQTT](MQTT_SETUP.md) and [MTConnect](MTCONNECT_SETUP.md).
