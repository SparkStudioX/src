# Read-query testing

Designer **Named queries** provides a read-test deadline of 1, 5, 15 or 30 seconds and a **Cancel read query** button while a saved read runs. These are test controls, not saved named-query properties. Save or discard a query draft before running it.

The deadline is enforced on the gateway. It includes waiting for a managed SQLite worker, opening the provider and reading rows. Existing provider-specific limits may stop an operation sooner. The browser Cancel button aborts its request; the gateway receives request cancellation and passes it to the provider. Leaving the Designer page aborts an outstanding read; switching between retained Designer sections may keep it running, so use Cancel read query first. No stale result is applied after cancellation. The browser says cancellation was requested rather than claiming it observed the database stop.

The Designer retains exact integer and decimal strings for conversion by the gateway and rejects blank numeric values, integer overflow and nonfinite numbers. Gateway read preflight checks declared types and duplicate names before opening SQLite or SQL Server. Parameter errors identify the name/type, never the submitted value. Values remain bound separately from SQL text.

Updates retain their deliberate **Execute update** action and have no new cancel or test-deadline control. A read-test deadline supplied to an update request is rejected before database access. No update is automatically retried. A lost response or interrupted update can leave an uncertain outcome; this increment does not establish transaction rollback or SQL Server recovery behavior.

## Workshop setup

The independently authored [query-testing.json](../../examples/query-testing.json) uses a separate managed SQLite file and synthetic production records. It requires gateway setup and therefore is not a standalone portable `.sparkproj`.

On the isolated test gateway, use the [authenticated test workflow](SECURITY.md#verification-commands) and run:

```powershell
$env:SPARKSTUDIO_TEST_AUTH_FILE = '.data/test-evidence/security-test-accounts.json'
node --import ./tools/test-auth-session.mjs tools/load-query-testing-example.mjs
```

The loader accepts only loopback port 5091. It refuses an existing project name, connection ID or configured database path. Database creation never overwrites a file. Setup is additive, not a transaction; an interrupted run may leave created resources requiring review. The new project remains unpublished, and the loader never runs the slow query.

1. Open the new **Read query workshop** from Projects.
2. Inspect the shared `sqlite-query-workshop` connection and synthetic `query-workshop.db`. In Connections, Test verifies the database; Diagnostics lists the three draft query references.
3. Review the three named reads and workshop screen. Only the fast records query is bound to the table. Explicitly publish the project when ready; the slow query is never run automatically.
4. In Named queries, run **Typed quantity** with `minimum` set to `45`; expect two synthetic records. Enter a nonnumeric value; expect an input error without a database query. Restore `0`; expect three records.
5. Select **Slow read for cancellation**, choose **1 second**, and run it. Expect a gateway deadline error. Select **30 seconds**, run it and immediately press **Cancel read query**. Expect a cancellation-requested message, with no result applied.
6. Run **Production records** again. Expect the same three records, showing that the connector remains usable. Publishing the workshop enables the fast read-only table for operators; test controls stay in Designer.

The recursive slow query is an intentionally expensive read. Use this workshop on an isolated development gateway. There are no machine connections or application writes in its queries.

## API and verification

The draft execution request accepts optional `timeoutMs` from 250 through 30,000 milliseconds for read queries. Gateway deadline expiry returns HTTP 504. Existing requests without that field, runtime queries and query-property refresh retain their previous call contract and provider limits. Native SQLite uses a cancellation-aware progress handler; SQL Server receives the linked cancellation token through its async open/read operations.

Run `node tools/test-query-cancellation.mjs` for offline input validation plus real disposable SQLite cancellation, deadline and recovery checks. The generated C# harness stays in ignored `.data/test-evidence/`. `node --import ./tools/test-auth-session.mjs tools/test-query-cancellation.mjs --api` checks a disposable authenticated gateway on port 5091. Fixtures use a new SQLite database and project, never the live development data on port 5090.

SQLite cancellation tests are actual provider execution. SQL Server tests in this increment cover preflight contracts only; no live SQL Server is available. Pool health, full provider catalog, transaction boundaries and real SQL Server TLS/restart/recovery acceptance remain under G06.
