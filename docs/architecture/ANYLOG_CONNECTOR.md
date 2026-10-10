# AnyLog query node

SparkStudio can use an AnyLog query node as a named-query connection. You write the same kind of `SELECT` used for SQL Server. The connector sends that statement as an HTTP GET. The `command` header is:

```text
sql <dbms> format=json <select>
```

The header `destination: network` is the REST form of `run client ()`. Putting `run client ()` in a POST body makes this node return HTTP 400, `Unrecognized Command`. `format=json` is added so screens receive columns and rows. The `SELECT` text itself is not rewritten. `@name` parameters are still declared on the named query; before the command is sent, each one is replaced with a typed literal. AnyLog's REST command does not accept a separate parameter list.

The connector requires Windows preview.16, Docker preview.16-docker.1 or a later compatible build. This connector is a plugin under `plugins/anylog/`, contributed from a community fork. SparkStudio core only has a small registration seam for read-only database connectors; the seam and how another connector can use it are described in [plugins/anylog/PLUGIN_SEAM.md](../../plugins/anylog/PLUGIN_SEAM.md).

## Create the connection

Open **Gateway Settings → Data → Connections → New Connection** and choose **AnyLog query node**. The choice appears when the gateway was built with the plugin and has loaded `plugins/SparkStudio.Connectors.AnyLog.dll`.

| Field | Meaning |
| --- | --- |
| Query node address | Hostname or IP address of the query node. Do not include the port. |
| REST port | Port of the node's REST interface. `32349` is filled in as a common default; use the port configured on that node. |
| DBMS | Logical database name. It must be letters, digits and underscores, and it is inserted as `<dbms>` in the command above. |

Save, then **Test connection**. The test sends `get status` in the command header. A successful test means the node accepted a command. It does not prove that the DBMS contains a particular table; run a named query for that.

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
sql aloperator format=json SELECT sensor, value FROM temperature WHERE sensor = 'BCT' AND timestamp >= NOW() - 1 hour
```

Parameter rules match the SQL Server named-query types: string, integer, long, floating point, decimal, boolean, date and GUID. Strings are single-quoted and embedded quotes are doubled. Numbers stay numeric literals. Missing values become `NULL`. Placeholders inside quotes are left as written. Comments are removed before sending.

AnyLog's own SQL limits still apply. A query is one statement, normally one table. Joins, nested queries and T-SQL `TOP` are outside what a query node typically accepts; use `LIMIT` and AnyLog's `NOW() - N hours/days/minutes` form. The connector still refuses a statement that is not a single `SELECT` or `WITH … SELECT`, and it refuses stacked statements.

The node returns a JSON object. Table rows are the objects in `Query`. `Statistics` is not shown as table data. Results are capped at 1,000 rows, about 16 MiB and 1 MiB per cell, with a 30-second limit. A larger result fails instead of returning a partial table. Screens, dropdowns, lists and query tables bind to the named query the same way they bind to a SQL Server query.

The gateway calls `http://<address>:<port>/` with `User-Agent: AnyLog/1.23`. The command travels in the `command` header, and a query also sends `destination: network`. A line break in the SELECT becomes a space in that header, so `--` and `/* */` comments are removed first. The command is limited to 3,500 characters of printable ASCII; a SELECT or parameter value with accented or other non-ASCII characters is rejected with a message instead of being sent.

## Build and test

From the repository root:

```powershell
dotnet run --project plugins/anylog/SparkStudio.Connectors.AnyLog.Tests
dotnet build src/SparkStudio.Gateway
```

The gateway build compiles the plugin and copies `SparkStudio.Connectors.AnyLog.dll` into the gateway output `plugins/` folder. Restart the gateway after that copy. Publishing the gateway copies the same file into the published `plugins/` folder.

The connector tests cover command wrapping, parameter quoting, the SELECT screen, JSON rows and plugin loading. They do not contact a live query node.
