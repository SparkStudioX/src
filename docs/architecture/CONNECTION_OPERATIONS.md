# Connection operations

Gateway configuration administrators manage shared connections in **Gateway Settings → Configuration → Connections** or the Designer's **Connections** workspace. Named queries belong to projects; their connection IDs point at the shared gateway configuration.

## SQL Server authentication

Preview.11 uses the core Microsoft.Data.SqlClient 7.0.3 package. Connections use
SQL username/password authentication, or Windows integrated security when the
username is empty. Encryption remains mandatory; certificate trust follows the
explicit saved connection setting. Microsoft Entra authentication, interactive
sign-in and the Windows WAM broker are outside the supported connection model.
The optional Azure authentication extension and its native broker are not shipped.
Microsoft documents this dependency separation in the [SqlClient package guide](https://learn.microsoft.com/en-us/sql/connect/ado-net/download-microsoft-sqlclient-data-provider?view=sql-server-ver17).
Actual SQL Server connectivity still requires acceptance against a test server;
SQLite and connection-string checks do not establish it.

## Lifecycle

- **Save connection** accepts new IDs without a revision. Existing entries must send their current `revision`; a stale or missing revision returns HTTP 409 without changing saved configuration. **Cancel changes** appears while editing and retrieves the current saved entry. Only a successful retrieval discards the draft; failures preserve edited credentials and fields.
- Renaming preserves the connection ID and its references. Changing the connector type requires a new connection.
- **Connection enabled** takes effect when saved. Disabling immediately invalidates OPC UA subscription callbacks, cancels their watches and reports `Bad_Disabled` on bound tags. The last value remains available with bad quality; it is not represented as current good data.
- Disabled entries block new tests, browse calls, schema/database operations and query operations when they resolve the connection. An operation admitted before disable may finish; disabling is not a transaction rollback or an emergency equipment stop.
- Re-enabling preserves tags and named-query references. Tag subscriptions reconnect normally. The saved test result is cleared on every configuration save, including rename, disable and re-enable; test again against the new revision.
- Existing records with no `revision` or `enabled` load as revision 0 and enabled. Saving upgrades that entry in place. Password omission preserves the encrypted password; an explicit empty password clears it.

**Delete connection** opens a confirmation for the selected saved entry. Removal requires its current revision and checks saved references atomically with persistence. Gateway tags (including disabled tags), UDT members and current draft/published named queries in active or archived projects block deletion. Change or remove those references first. In-progress OPC UA operations and stopping subscriptions also block removal; wait for their completion before retrying. A stale editor cannot recreate a removed connection. Create replacements using a new connection ID.

Deletion removes the saved connection and its protected credentials, then releases idle cached sessions outside configuration locks. It retains managed SQLite databases and OPC certificate stores. Scripts can resolve connection IDs dynamically and are not exhaustively analyzed; review those uses before removal. Unsaved edits and older publication-history entries are outside the saved-reference check.

## Entering an OPC UA address

Typing an `opc.tcp://` address is supported. The connector discovers endpoints internally, selects a modern policy compatible with the saved security mode and authentication, and preserves the entered host and port. It never silently falls back to a weaker security mode. **Discover endpoints** is a configuration aid: **Use endpoint** copies the advertised address, mode and server certificate fingerprint into the draft. It does not save the connection or establish that the certificate is authentic.

Encrypted connections need either a trusted server certificate or a verified SHA-256 pin. Verify the fingerprint with the server administrator before selecting/saving it. Enter credentials when the server requires username/password authentication; an empty username requests anonymous access. Test results now identify missing credentials, unsupported security modes, untrusted certificates, incorrect pins and certificate hostname/validity problems separately. The OPC UA server may also need to trust SparkStudio's client certificate.

In a container, `localhost` refers to that container. Use a reachable server hostname or address matching its certificate, rather than the host computer's loopback address.

## Tests and observations

**Test connection** performs a read check, then stores the start/completion timestamps, duration, success and configuration revision in `connections.json`. It does not continuously monitor health. The latest-started test is the only overlapping test allowed to update status, and a test captured before a configuration save cannot overwrite the newer entry. Canceled tests do not overwrite the last completed result.

Stored results use fixed messages for success, missing managed SQLite databases, OPC UA authentication/security failures or a generic failure. Raw exception messages, passwords and connection strings are not persisted in diagnostics. Connections still retain their normal protected credentials in the gateway store.

The collapsed **Diagnostics** section shows counts for existing references and tags, or **No saved references** when there are none. Empty reference, subscription and tag-value sections stay hidden. Open it for a read-only snapshot:

- Gateway tag definitions and UDT members referencing the connection.
- Named queries in every current project draft and published query snapshot, including archived projects and published script-only named queries. SQL text is not returned. Scripts may choose a connection dynamically; such references cannot be inferred from this list.
- OPC UA subscription state and last notification time.
- Up to 100 configured tag values with quality, type and source timestamp. Values longer than 512 characters are shortened. The source timestamp describes a value notification and can remain old when a value does not change.

The section loads its counts once and updates automatically every 15 seconds while expanded and the document is visible, without overlapping requests or creating an extra OPC UA read/write session. A failed read or mismatched saved revision retains the last valid snapshot with a warning and contextual **Retry diagnostics**. Reopen Connections when its revision changes. Up to 500 references are shown with explicit omitted counts. A save or selection change clears older UI results. Automatic shared-resource updates do not overwrite a connection draft or its edited credentials. The confirmation rechecks references on the server; a displayed count is not a deletion lock.

Public certificate-store administration is separate under Configuration → Public OPC certificates. Diagnostics do not perform continuous SQL health polling or equipment writes.

## Workshop: SQLite lifecycle and dependencies

Use the **SQLite data controls** setup workshop from `examples/catalog.json` on a disposable gateway. This is a gateway-setup example, not a self-contained `.sparkproj`; its database connection and managed SQLite data are installed explicitly by the workshop loader. It needs the G05 connection operations build or later.

1. Follow the SQLite data controls loader instructions to install the synthetic sample. Open its connection in **Connections**. Run **Test connection** and inspect the completion time. Reload the page; the result should remain visible.
2. Open **Diagnostics**. The loader publishes this project during setup, so the sample named queries should appear as both draft and published references. Wait for an automatic update after later query edits or publication.
3. Rename the connection and save. Its ID stays unchanged, so named queries continue to use it. The previous test result disappears because the saved revision changed.
4. Open the same connection in two Designer tabs. Save a rename in the first. Saving the older entry from the second should report a conflict. Use **Cancel changes** in that tab to discard the older edit and inspect the new name.
5. Clear **Connection enabled**, then save. New named-query executions should fail with an explicit disabled-connection message; the managed SQLite file and reference list remain intact. The Test, Create database and Browse schema actions are unavailable while disabled.
6. Enable and save the entry, then test it. Queries should work again without recreating the database. Keep diagnostics visible and verify that its observation timestamp advances automatically. Failed observations keep the previous data visibly outdated until a successful read.
7. Choose **Delete connection** and confirm. The saved named-query references must prevent deletion; the connection and database remain usable. Cancel the review. To exercise successful removal without dismantling the workshop, create a separate unused connection, save it and delete it. For an unused managed SQLite connection, optionally create its database before deletion and verify that the database file is retained afterward.

For the optional OPC UA lab, use a dedicated read-only test server and a configured tag. Verify its value, quality and source timestamp in quick watch. Disable and save the connection: the tag should immediately show `Bad_Disabled`, and its subscription group should stop. Re-enable it and wait for a fresh good notification. Do not infer that a PLC or process has stopped when its client connection is disabled.

## Verification

`node tools/test-gateway-connections.mjs --model` exercises legacy defaults, revision conflicts, credential protection, overlapping/stale tests, restart persistence, disabled subscription behavior, safe removal, UDT/archived published-only dependencies and fixed error-message redaction with authored local fixtures. Connector reliability checks verify active-lease protection, failed-persistence rollback and deferred transport cleanup. `--opc-integration` verifies encrypted read-only sessions against a disposable server, including untrusted, correct and incorrect pins and cross-connection trust isolation.

`node tools/test-gateway-connections.mjs` requires disposable test accounts in the ignored test-auth file and accepts loopback port 5091 only. It verifies administrator boundaries, SQLite test/rename/disable/re-enable behavior, query references, disabled OPC UA quality and revision-checked deletion. Its retained fixture connections are disabled and its test project is archived; it never changes port 5090 or writes to equipment.

## Concurrency and recording controls

OPC UA read/write operations can use up to four pooled sessions per connection,
within 32 total cached sessions. Transport failures retire the affected session;
ordinary operation errors do not discard an otherwise healthy connection.
Subscription mappings support an optional nonnegative absolute deadband and a
queue size from 1 to 1000 (default 16). Browser telemetry still coalesces to the
latest value, so this is not a guarantee of lossless acquisition; configure tag
history for the bounded recording contract.

Managed SQLite uses WAL, full synchronous commits and a five-second busy timeout.
WAL permits readers during an unrelated writer transaction. Connection pooling
remains disabled because every operation installs its own native authorization
policy; do not enable pooling without preserving that security boundary.
