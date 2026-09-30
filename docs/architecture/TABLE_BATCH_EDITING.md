# Multiple row selection and atomic table editing

Tables support single selection with scalar form mappings, or multiple selection with local row checkboxes. Multiple selection retains exact string and integer keys across sorting, filtering and paging; `1` and `"1"` remain distinct. Select page adds the visible rows, up to 100 selected rows. Clear selection discards the selection. A source, parameter, publication or selection-definition change resets it; removed rows leave the selection on refresh. Multiple selection cannot map several rows into one scalar input.

In the table property grid, choose **Cell editing → Configure editing → Persistence → Atomic batch · database table**. Set the exact database table, row key, version column and typed editable columns. Apply editing saves one draft change; publish the application to make it available to operators. The existing single-cell Python mode remains available separately.

## Database contract

Atomic batches use the same SQLite or SQL Server connection as the published named read query. Sample-provider queries cannot write batches. The read query must return direct, complete row keys, versions and editable source columns from the declared table. The database must enforce uniqueness of the row key. Every writer must compare the captured version and advance it after changing a row. Versions are nonnegative safe integers; a version already at 9,007,199,254,740,991 cannot advance.

The saved configuration contains `tableEdit: {versionColumn, columns, batch: {table}}`. A batch cannot also contain a Python handler. Table and column names are unqualified ASCII database identifiers: 1–128 letters, digits or underscores, beginning with a letter or underscore. Schema-qualified names and dynamic identifiers are deliberately unsupported. Values are parameters, never SQL fragments. Operators submit only `{edits: [{key, version, column, value}], publishedAt, ...scope}`; table, connection and SQL always come from the published definition.

Apply accepts 1–100 cells across at most 100 rows. The gateway reconstructs screen, popup and nested template context using the published graph. It validates every declared field type and constraint and rereads query membership inside the same database transaction that performs updates. Each row's cells are grouped into one update with key-and-version predicates and one version increment. Every update must affect exactly one row. A stale or missing row, invalid value, failed database constraint, cancellation before commit or failed affected-row check rolls back the entire transaction. SQLite takes its write transaction before the membership read; SQL Server uses serializable isolation.

This atomicity applies to the database transaction. This mode executes no Python, device commands or external operations. Administrators must review database triggers; external side effects invoked by a trigger are outside the promised rollback boundary. This feature does not convert existing Python scripts into transactions.

## Operator workflow

1. Select rows, including across pages, and choose **Edit selected rows**.
2. Change the desired values. Editing a field includes that cell; its checkbox can exclude it again. Opening the dialog makes no writes. Every included value must satisfy its published type and constraints.
3. Choose **Apply all changes** to submit once, or **Cancel** to discard all staged cells. Apply stays disabled until at least one valid cell is included. Pending submission locks the draft against duplicate requests.
4. After success, the table reloads and clears the selection. Live polling never replaces typed text; a changed or missing selected row makes the draft conflict permanent until Cancel and reload. Communication loss preserves the draft but disables Apply. An unconfirmed network outcome requires a reload instead of a blind retry.

Designer Preview and viewer/read-only sessions cannot submit batches. The existing table-edit endpoint requires Operate permission and CSRF protection; published identity and nested scope are checked again on the gateway. Scalar table-to-form mappings continue using the destination input's validation constraints.

## Independently authored workshop

Use the companion source build that includes atomic table batches. The source is `examples/table-batch-workflow.json`; it contains only synthetic production records and requires gateway setup. No Python runtime is needed for batch persistence.

On an isolated local gateway, set `SPARKSTUDIO_ADMIN_AUTH_FILE` to an administrator credential file and run:

```powershell
node tools/load-table-batch-example.mjs http://127.0.0.1:5093 --publish
```

The loader creates a separate **Atomic table batch workshop** project and the reserved `batch-table-db` connection with `batch-table.db`, initialized using the gateway's synthetic `production_records` data. It refuses an already configured connection/database or existing project name; database creation never overwrites an existing file. Without `--publish`, the loader leaves a reviewable draft.

Select rows 1 and 2 across the table's pages. Stage quantities and a valid status (`queued`, `running` or `complete`), Apply, and verify both rows changed and each version advanced once. Repeat with two columns on one row to observe a single version increment. Cancel a different draft and verify nothing changed.

For the rollback exercise, stage row 1 quantity and set row 2 status to `invalid`. The text passes the declared UI length constraint, but SQLite rejects it. Reload and verify both original values and versions remain unchanged. For a conflict, open the same rows in two operator sessions and apply one session first; the older captured versions in the other session must fail as one batch.

The backend suite `TableBatchChecks` uses a disposable real SQLite database for grouping, rollback, concurrent winners, read-query membership and stale published definitions. Frontend checks cover typed selection, staged Apply/Cancel, constraints, sticky conflicts, callback loss, unknown outcomes and unmount cancellation. SQL Server follows the same connector transaction contract but requires an external SQL Server deployment for live integration testing.
