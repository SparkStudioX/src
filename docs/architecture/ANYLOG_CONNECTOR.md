# AnyLog query node

SparkStudio can use an AnyLog query node as a named-query connection. You write the same kind of `SELECT` used for SQL Server. The connector sends that statement to the query node's REST port as:

```text
run client () sql <dbms> format=json and <select>
```

`format=json` is added so screens receive columns and rows. The `SELECT` text itself is not rewritten. `@name` parameters are still declared on the named query; before the command is sent, each one is replaced with a typed literal. AnyLog's REST command does not accept a separate parameter list.

This connector is a plugin under `plugins/anylog/`. SparkStudio core only has a small registration seam, so an upstream SparkStudio update does not have to merge the AnyLog client. The upgrade steps are in [plugins/anylog/UPGRADE.md](../../plugins/anylog/UPGRADE.md).

## Create the connection

Open **Gateway Settings → Data → Connections → New Connection** and choose **AnyLog query node**. The choice appears when the gateway was built with the plugin and has loaded `plugins/SparkStudio.Connectors.AnyLog.dll`.

| Field | Meaning |
| --- | --- |
| Query node address | Hostname or IP address of the query node. Do not include the port. |
| REST port | Port of the node's REST interface. `32349` is filled in as a common default; use the port configured on that node. |
| DBMS | Logical database name. It must be letters, digits and underscores, and it is inserted as `<dbms>` in the command above. |

Save, then **Test connection**. The test posts `run client () get status`. A successful test means the node accepted a command. It does not prove that the DBMS contains a particular table; run a named query for that.

The connection is read-only. Named queries on it stay **Rows (SELECT)**. INSERT, UPDATE and DELETE, including atomic table batches, stay on SQLite and SQL Server.

## Write the query

In the project, create a named query and choose the AnyLog connection. Example:

```sql
SELECT sensor, value
FROM temperature
WHERE sensor = @sensor AND timestamp >= NOW() - 1 hour
```

With DBMS `aloperator` and `@sensor` set to `BCT`, the node receives:

```text
run client () sql aloperator format=json and SELECT sensor, value FROM temperature WHERE sensor = 'BCT' AND timestamp >= NOW() - 1 hour
```

Parameter rules match the SQL Server named-query types: string, integer, long, floating point, decimal, boolean, date and GUID. Strings are single-quoted and embedded quotes are doubled. Numbers stay numeric literals. Missing values become `NULL`. Placeholders inside quotes or comments are left as written.

AnyLog's own SQL limits still apply. A query is one statement, normally one table. Joins, nested queries and T-SQL `TOP` are outside what a query node typically accepts; use `LIMIT` and AnyLog's `NOW() - N hours/days/minutes` form. The connector still refuses a statement that is not a single `SELECT` or `WITH … SELECT`, and it refuses stacked statements.

Results are capped at 1,000 rows, about 16 MiB and 1 MiB per cell, with a 30-second limit. A larger result fails instead of returning a partial table. Screens, dropdowns, lists and query tables bind to the named query the same way they bind to a SQL Server query.

The gateway posts the command to `http://<address>:<port>/` with `User-Agent: AnyLog/1.23` and `Content-Type: text/plain`. When the command is a single line of at most 3,500 characters, the same text is also sent in the `command` header. Multiline SQL is sent in the body only, so a `--` comment cannot comment out the rest of the command.

## Build and test

From the repository root:

```powershell
dotnet run --project plugins/anylog/SparkStudio.Connectors.AnyLog.Tests
dotnet build src/SparkStudio.Gateway
```

The gateway build compiles the plugin and copies `SparkStudio.Connectors.AnyLog.dll` into the gateway output `plugins/` folder. Restart the gateway after that copy. Publishing the gateway copies the same file into the published `plugins/` folder.

The connector tests cover command wrapping, parameter quoting, the SELECT screen, JSON rows and plugin loading. They do not contact a live query node.
