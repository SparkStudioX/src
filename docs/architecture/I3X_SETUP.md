# i3X setup walkthrough

Connect to an i3X 1.0 API, browse its elements, and create read-only tags for selected current values. Start with polling and one element so you can verify the API address, authentication and data type before adding a larger model.

**Build availability:** these steps require a SparkStudio build whose **New Connection** menu includes **i3X source**. The published Windows `v0.2.0-preview.12` and Docker `0.2.0-preview.11-docker.1` do not include this source feature. This is a development-build guide, reviewed October 2, 2026.

## Where do I create the tags?

The recommended route is in the connection: browse elements, select values, then **Preview point and tag import → Apply reviewed import**. Apply saves the selected source points and creates their gateway tags together. You do not need to recreate them in Tags.

Alternatively, save point definitions in the connection and create tags later in **Tags**. **Add point** and **Import / edit JSON** change the point-map draft only; they require **Save connection** and do not create tags. Both routes bind a tag to a stable saved point, rather than treating a displayed element name as its identity.

## Before you start

Have an engineering session signed in as a gateway administrator and obtain the following from the i3X service owner:

- The complete i3X 1.0 API base URL, for example `https://i3x.example.com/v1`.
- The service's authentication mode: **None**, username/password, bearer token or API key. Obtain credentials and the API-key header name only when the service requires them.
- A known element you are permitted to browse and read, its expected value/type, and any supported subscription transport.
- Certificate references for a private CA or mutual TLS, if required.

The API must be reachable from the gateway machine or container. **Outside loopback, SparkStudio requires HTTPS for i3X.** Plain HTTP is permitted only for a local loopback service. Authentication follows the service's requirements: **None** is allowed for local and remote services that do not require credentials. A browser reaching the service does not establish gateway connectivity; `127.0.0.1` refers to the gateway's own host or container.

## 1. Create and test the connection

1. Open **Gateway Settings → Configuration → Connections → New Connection → i3X source**.
2. Give it a recognizable name, such as `Line 1 i3X`, and leave it enabled.
3. Set **Base URL** to the service's full API root. Include `/v1` if it is part of that root; do not enter an individual element or current-value URL.
4. Set **Authentication mode** to the service's mode. Leave **None** selected when it accepts requests without credentials, including for a remote HTTPS service. Otherwise choose **Username and password**, **Bearer token**, or **API key** and fill the displayed credential fields. For an API key, set **API-key header** to the service's required header; its default is `X-API-Key`.
5. Leave **Acquisition** at **Polling** and **Poll / sync interval (ms)** at `1000` for the initial check. The supported interval is 1,000–60,000 ms.
6. Leave **Client identity** blank to generate and retain an identity on first save. Keep **Prefer advertised SSE, with sync fallback** checked and **Reconcile current state every (seconds)** at `30` for later subscription use.
7. Choose **Save connection → Test connection**. Test is unavailable while the connection has unsaved changes or is disabled.

Expect a successful API connectivity result. This does not yet prove that your selected element returns usable data. The following read check establishes that.

For certificate settings, expand **Certificates and server identity** and enter existing gateway certificate reference names. These fields do not accept certificate contents or local file paths. A saved credential placeholder retains its secret when left unchanged; **Clear password** or **Clear token** removes it.

## Connection field reference

These settings identify the API and control one shared acquisition session. They do not create tags. Start with polling, then browse and import one known value before choosing subscriptions.

| Field | Meaning, defaults and example |
| --- | --- |
| Connection name | Your label in SparkStudio, such as `Line 1 i3X`. It is separate from the API's element IDs and subscription client identity. |
| Connection enabled | Leave checked to acquire values and permit Test/Browse/Read. Unchecking stops acquisition and blocks new operations after **Save connection**; operations already underway may finish. |
| Base URL | The complete API root, such as `https://i3x.example.com/v1`, up to 2,048 characters. SparkStudio appends routes such as `info` and `objects/value`. Do not enter a particular element URL, credentials, query string or fragment. A trailing slash is optional. The new-connection example `https://api.i3x.dev/v1` is not a preconfigured account: use the URL supplied by your service owner. Outside loopback, HTTPS is required; authentication depends on the service. |
| Acquisition | **Polling** is the default and repeatedly reads the saved points' current values. **Subscription / stream** creates a server subscription, receives updates and periodically checks current state. Both are read-only; tags share this connection rather than creating separate sessions. |
| Poll / sync interval (ms) | Default `1000`; range `1000`–`60000`. `1000` means one second. This is the delay after a completed polling read or subscription sync request. Request duration adds to that delay. Pushed SSE updates do not wait for this interval. |
| Authentication mode | Default **None**, allowed for both local and remote services that accept requests without credentials. Choose **Username and password**, **Bearer token**, or **API key** only when required by the service. SparkStudio does not require credentials solely because the API is remote. The HTTPS requirement outside loopback still applies. |
| Username — shown for Username and password | The API account name, for example `spark-reader`, not the SparkStudio login or subscription client identity. A nonblank username is required. Give the account the read/browse and, when used, subscription permissions your service requires. |
| Password — shown for Username and password | The API account's password. A saved password is protected on this gateway: leave the placeholder unchanged to retain it, or use **Clear password** to remove it. |
| Bearer token — shown for Bearer token | Paste the token only, without the `Bearer ` prefix. SparkStudio supplies that prefix in the authorization header. A nonblank token is required; leave a saved placeholder unchanged to retain it, or use **Clear token** to remove it. |
| API key — shown for API key | The nonblank secret key supplied by the service. It is sent in the configured API-key header, not appended to the URL. Saved-key retention and **Clear token** work like the bearer token field. |
| API-key header — shown for API key | Default `X-API-Key`; use the exact header name required by the service, such as `X-I3X-Key`. It must start with a letter, contain only letters/digits/hyphens, and be at most 64 characters. `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Cookie` and `Authorization` cannot be used here. |
| Prefer advertised SSE, with sync fallback | Checked by default; used only with **Subscription / stream**. Uses server-sent events when the API advertises stream support. Uncheck to use subscription sync instead. An unadvertised stream or HTTP `501 Not Implemented` uses sync; other failures are reported as recovery or faults rather than silently changing delivery mode. |
| Reconcile current state every (seconds) | Default `30`; range `5`–`300`. Used only with **Subscription / stream**. Reloads current values to repair drift even while delivery remains connected. This recovers current state, not missed transient events or a lossless history. Polling already reads current state and does not use this setting. |
| Client identity | Leave blank on first save to generate and persist an identity. Used in subscription requests; it is not a username or credential. Keep the generated value, or choose a stable name such as `spark-line1-i3x`, up to 128 characters. Clearing the field on an existing connection retains its saved identity. Polling does not send this identity. |

Credential values are limited to 8,192 characters and cannot contain carriage returns, newlines or NUL characters. Use a token/key in its dedicated field rather than pasting an entire HTTP header.

The following optional fields appear under **Certificates and server identity**. Ask the gateway administrator for an existing certificate reference name; do not paste PEM contents, a private key or an absolute file path.

| Field | Meaning and example |
| --- | --- |
| Trusted CA certificate reference | A gateway-installed PEM CA reference, such as `factory-ca.pem`, for the server's issuing CA. Leave blank for the operating system's normal trust store. Setting this reference uses a custom root trust store for this connection. |
| Client certificate reference | Used only when the API requires mutual TLS. Use an installed certificate-plus-key PEM pair, such as `i3x-client.pem` with the key reference below, or a PKCS#12/PFX reference containing its private key that can be loaded without a password, such as `i3x-client.pfx`. |
| Client private-key reference | The installed private-key PEM reference for the client certificate, such as `i3x-client.key`. A key reference requires a client certificate reference. Leave blank when the client certificate's PKCS#12 file already includes its key. |
| Server certificate SHA-256 pin | Optional exact certificate identity from the service owner: 64 hexadecimal characters, without colons or separators. Pinning checks the exact certificate, hostname and validity dates; it uses the pin instead of normal certificate-chain trust. Leave blank to use normal or configured-CA trust. Replacing the server certificate requires updating the pin. |

Certificate reference names are at most 128 characters, start with a letter or digit, and otherwise use letters/digits/underscore/dot/hyphen. They cannot contain `..`. Certificates and keys must already be provisioned in the gateway's certificate store before a connection can use them.

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

## Point and tag import field reference

An **element ID** identifies the service value; a **Point ID** identifies its saved binding in SparkStudio; a **Tag path** is your gateway name for that binding. These are different fields. For example, an element named `urn:line1:machine#state` might return `{"running":true,"temperature":24.5,"axes":[{"position":10.2}]}`. One saved point can select `/running` as Boolean and another can select `/temperature` as Double while retaining the same raw element ID.

| Field or action | Meaning and example |
| --- | --- |
| Point ID | A stable SparkStudio identifier, such as `machine_running`, used by tags and UDT members. Keep the generated ID unless choosing one before first save. It is fixed in the point editor afterward; it is not the service's element ID. IDs must be unique within the connection, 1–128 characters, start with a letter/digit, and otherwise contain letters/digits/underscore/dot/colon/hyphen. Reviewed browse import generates this identity from the connection, raw address and selector. |
| Point name | Your display label, such as `Machine running`. Required, up to 256 characters. Renaming the label does not change the raw service address or tag path. |
| Raw address | The exact, case-sensitive opaque element ID from the service, such as `urn:line1:machine#state`. Preserve `#` and other ID characters; do not URL-encode it, turn it into a folder path or append a selector. Required, up to 2,048 characters, without control characters. |
| Selector (separate from address) | A JSON pointer inside the element's **value**, not the surrounding response/quality/timestamp envelope. Empty selects the whole value. `/running` selects `true`; `/axes/0/position` selects the first axis's position. A slash in a member name is escaped as `~1` and a tilde as `~0`, for example `/motor~1status` selects a property named `motor/status`. Nonempty pointers must start with `/`, use valid escapes and be at most 512 characters. A missing/null selected member becomes `Bad_NoData` unless the service already reports `Bad`. |
| Data type | Match the selected value. Browsing suggests Boolean for boolean schemas, Int64 for integer schemas and Double for numeric schemas; a new manual point starts as String. Supported types are Boolean, Int16, UInt16, Int32, UInt32, Int64, Float, Double and String. Numeric strings such as `"42"` are not silently converted to numbers, and `0`/`1` are not converted to Boolean. A whole object/array can use String to return JSON text; select a member for a scalar value. |
| Import root | Your proposed gateway folder, initially `[default]Sources/<connection-id>`, for example `[default]I3XDemo`. Set it before selecting values. It supplies paths for newly selected rows; changing it does not rewrite existing selections' Tag paths. It is not sent to the i3X service. |
| Tag path — shown for selected imports | The exact gateway path to create, for example `[default]I3XDemo/Running`. Edit proposed paths independently of raw IDs and selectors. Use a concrete `[default]` path of at most 512 characters. After the provider prefix, do not use empty, `.` or `..` segments, control characters, brackets/braces or backslashes. Paths must be distinct and must not collide with existing definitions. Suggested names include stable suffixes to prevent display-name collisions; you can replace them with your own unused paths. |
| Apply point to draft / Import or edit JSON | Changes the connection's saved-point draft only. **Save connection** is still required, and these actions do not create tags. JSON uses `id`, `name`, `address`, `dataType` and optional `selector`; points must remain read-only. |
| Preview point and tag import / Apply reviewed import | Reviews then atomically saves the selected points **and** creates their tags. No subsequent connection save is needed for this import. A changed connection/tag configuration invalidates the review. Each transaction accepts 1–1,000 selected points. |

The saved map is limited to 10,000 points and 768 KiB of serialized point definitions. Removing or changing the type of a point referenced by a tag or UDT is blocked until those bindings are updated. In **Tags**, choose **Device / industrial source point → Device / source connection → Saved point**; its saved identity, type and read-only status supply the binding. Do not paste the raw element ID into the Saved point field. Opening Browse or saving a point map does not create tags automatically.

## 3. Verify current values

1. Under **Saved source points**, choose **Read** beside the imported point, or **Read first 256 points** for a small map.
2. Confirm the expected value, `Good` quality, **Source** timestamp and **Receipt** timestamp. A healthy i3X reading requires a valid UTC source timestamp ending in `Z`; a missing or invalid timestamp produces `Bad_DecodingError`. Receipt describes gateway arrival and does not replace an invalid source time.
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

After polling works, change **Acquisition** to **Subscription / stream**, retain **Prefer advertised SSE, with sync fallback**, and choose **Save connection → Test connection**. The connector uses advertised server-sent events when available. It uses subscription synchronization when SSE is not advertised, the preference is unchecked, or the stream endpoint returns HTTP `501 Not Implemented`. Other stream failures remain visible as recovery or faulted acquisition; they do not silently force sync. The **Poll / sync interval (ms)** controls the delay between completed sync requests and does not throttle pushed SSE updates.

Keep **Reconcile current state every (seconds)** at `30`, or choose a value from `5` to `300` appropriate to your service. Reconciliation repairs current-state drift even while a subscription remains connected. Check **Diagnostics** after enabling the mode and verify a changing value again. Subscriptions are best effort and current-state updates can coalesce; this is not a lossless event journal.

## Advanced limits and timeouts

These 12 fields appear under **Effective limits and timeouts** for i3X. Leave the defaults for an initial connection. They are ceilings and deadlines, not requests for faster polling. Smaller ceilings can reject valid large responses/models; Diagnostics identifies the rejected limit. Per-connection settings also share the gateway's global resource budgets.

| Field | Default; supported range | What it bounds |
| --- | --- | --- |
| HTTP / XML document bytes | `1048576` (1 MiB); 1,024–8,388,608 | Decoded JSON bytes in one HTTP response. Despite the shared label, i3X uses JSON. A sync response or SSE event is also bounded by Ingress queue bytes, whichever is smaller. See the decode-memory relationship below before increasing this value. |
| Bytes per value | `65536` (64 KiB); 1–65,536 | JSON bytes of one selected value. This includes the whole JSON text when selecting an object/array as String. An oversized selected value is rejected visibly. |
| Canonical state bytes | `16777216` (16 MiB); 1,024–16,777,216 | Selected/current-value state, including selector fan-out and the connection's value mailbox. More saved members can require more state even when they share one raw element ID. |
| Ingress queue bytes | `8388608` (8 MiB); 1,024–8,388,608 | Admission and byte ceiling for each subscription sync response or SSE event, further limited by HTTP document bytes. It is used by i3X subscription delivery, not only by MQTT. Raising it above the document limit does not enlarge an allowed i3X response/event. |
| Pending input records | `4096`; 1–4,096 | Maximum updates across one sync response or within one SSE event. This is an i3X subscription response/event limit, not the number of saved tags. |
| Catalog entries | `10000`; 1–10,000 | Cached browse-model capacity and generated selector-entry capacity. Exceeding the configured model capacity can reject browsing rather than merely hiding excess rows. |
| Catalog metadata bytes | `8388608` (8 MiB); 1,024–8,388,608 | Memory admitted for cached IDs, display names, relationships and schemas. Catalog snapshots are cached for up to five minutes; an expired continuation token requires restarting Browse. |
| Request timeout (ms) | `2000`; 100–30,000 | Deadline for an individual JSON HTTP request, including its response and decode admission. For SSE it bounds opening the stream; a healthy quiet stream has no inactivity timeout. Use reconciliation and Diagnostics to assess current-value health. |
| User operation timeout (ms) | `10000`; 100–30,000 | Entire user Test/Browse/Read operation, including waiting for an operation slot and all required requests/batches. It does not replace the per-request timeout. |
| Connect timeout (ms) | `5000`; 100–30,000 | Establishing the HTTP connection. The request or user-operation deadline can expire sooner. |
| Decoded nodes | `65536`; 1–65,536 | JSON parser tokens, including property names and container boundaries. Wide or deeply nested documents can reach this limit before reaching the byte limit. |
| Decode working bytes | `33554432` (32 MiB); 1,024–33,554,432 | Temporary decode admission for input/copies/parsed values. i3X reserves eight times the configured HTTP document byte limit per concurrent decode. Lower limits reduce admission/concurrency or reject decoding. |

For i3X, **Decode working bytes must be at least eight times HTTP / XML document bytes** to admit even one decode. With the maximum 32 MiB decode ceiling, a document ceiling above 4 MiB cannot be admitted, even though the shared document field individually accepts up to 8 MiB. For example, a 2 MiB document limit needs at least 16 MiB decode working bytes. The default 1 MiB/32 MiB pair leaves room for four concurrent decode reservations.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| i3X source is missing | Build availability above; current published installers lack this feature. |
| Save rejects the URL or authentication | Use HTTPS for a non-loopback API. **None** is allowed; when selecting another mode, supply its required username, password, token/key and valid header name. |
| Test fails or requests are unauthorized | Full API root, gateway network access, certificate trust, credential mode, API-key header and browse/read permissions. |
| Browse works but a value has bad quality | Exact element ID, selected member, declared type and the service's per-element current-value response. Inspect Diagnostics. |
| `Bad_WaitingForInitialData` or `Bad_NoData` | No accepted initial value, or the service returned no current value for that element/member. |
| `Bad_TypeMismatch` or `Bad_DecodingError` | Selected member's actual shape/type; preserve the raw ID and use a separate JSON pointer. |
| Missing source timestamp or `Bad_DecodingError` despite the expected value | The i3X value/quality/timestamp response must include a valid UTC timestamp ending in `Z`. Receipt time is not a fallback for malformed source metadata. |
| Import conflicts or a stale preview | Tag-path collisions, referenced definitions, point/tag capacity or changed configuration. Resolve and preview again. |
| Stream is connected but values drift | Reconciliation interval, supported SSE/sync behavior and recovery diagnostics; compare with the service's current state. |

The resulting tags are read-only and cannot be used as equipment command targets. Once values have acceptable quality, add a display in Designer and use **fx → Tag** to bind its property; see [property bindings](PROPERTY_BINDINGS.md). Save and explicitly publish the project for operators. Saving gateway connections or tags does not publish a project.

For other source setup paths, see [MQTT](MQTT_SETUP.md) and [MTConnect](MTCONNECT_SETUP.md).
