# Upgrading SparkStudio without losing AnyLog

AnyLog's query-node client lives in this directory. SparkStudio's SQL Server, SQLite, OPC UA and industrial drivers stay in `src/`. When you take a new SparkStudio drop, merge that drop into this branch. Files under `plugins/anylog/` are not in upstream SparkStudio, so they should not conflict.

The gateway still needs a thin seam so it can discover the plugin. Those edits are marked `database connector plugin` in source. After a merge, search for that phrase. If a conflict dropped one of the lines below, put it back. Do not copy the AnyLog HTTP client into `ConnectorService` or the React connection form.

## Seam to keep

| Location | What the line does |
| --- | --- |
| `src/SparkStudio.Gateway/SparkStudio.Gateway.csproj` | Imports `plugins/anylog/integrate.targets` only when that file exists. A SparkStudio tree without this directory still builds. |
| `src/SparkStudio.Gateway/Program.cs` | Loads `plugins/*.dll` at startup and exposes `GET /api/database-connectors`. |
| `src/SparkStudio.Connectors/DatabaseConnectors.cs` | The stable host API: register, validate, query, test and describe. New file, so a merge should add it rather than conflict. |
| `src/SparkStudio.Connectors/Models.cs` | `ConnectionDefinition` gains optional `ConnectorSettings`. |
| `src/SparkStudio.Connectors/SqlQueryGuard.cs` | The SELECT screen is public so the plugin can use the same read-only check. |
| `src/SparkStudio.Connectors/ConnectorService.cs` | `QueryAsync` and `TestAsync` delegate when a plugin owns the connection type. |
| `src/SparkStudio.Connectors/ConnectorService.Execute.cs` | Updates are rejected for a read-only plugin. |
| `src/SparkStudio.Gateway/ProjectStore.cs` | Saves a `connector` object, reloads it, marks the connection queryable, and keeps fixed plugin test messages. |
| `src/SparkStudio.Gateway/ProjectStore.Plugins.cs` | Blocks an update query on a read-only plugin. New file. |
| `apps/web/src/databaseConnectors.ts` and `DatabaseConnectorFields.tsx` | Connection and query forms render fields from `GET /database-connectors`. New files. |
| `apps/web/src/Connections.tsx`, `Queries.tsx`, `types.ts`, `deviceConnections.ts` | Call those helpers. The AnyLog labels are not hardcoded into the SQL Server form. |
| `tools/check-source.mjs` | Allows `plugins/anylog/` as authored source. |

`plugins/anylog/integrate.targets` builds `SparkStudio.Connectors.AnyLog` and copies only `SparkStudio.Connectors.AnyLog.dll` into the gateway output and publish `plugins/` folders.

## After the merge

1. Build and run the plugin tests: `dotnet run --project plugins/anylog/SparkStudio.Connectors.AnyLog.Tests`
2. Build the gateway: `dotnet build src/SparkStudio.Gateway`
3. Confirm `plugins/SparkStudio.Connectors.AnyLog.dll` is next to the built gateway, then start it.
4. In **Gateway Settings → Data → Connections**, confirm **AnyLog query node** is in **New Connection**.
5. Save a connection, test it, and run one `SELECT`.

If the menu entry is missing, the gateway process did not load the DLL. Rebuild so the targets copy runs, and restart the process that is actually serving the API.

## Changing the AnyLog client

Change `plugins/anylog/SparkStudio.Connectors.AnyLog/` when the REST command, JSON shape or connection fields change. The host calls `IDatabaseQueryConnector`; it does not know the `run client ()` text. Keep test failures as fixed sentences listed on `SafeTestFailures`. Do not return node payloads, SQL or credentials in those sentences. The gateway stores only messages on that list.

A second connector can implement the same interface and ship as another `SparkStudio.Connectors.*.dll` in the gateway `plugins/` folder. Give it its own directory beside `anylog` if it should survive the next SparkStudio merge the same way.
