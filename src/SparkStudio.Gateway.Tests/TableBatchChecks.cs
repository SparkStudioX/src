using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class TableBatchChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string label) { if (!value) throw new Exception("FAILED batch: " + label); passed++; }
        async Task Reject(Func<Task> action, string label, bool validationOnly = false) { try { await action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or KeyNotFoundException) { if (validationOnly && error is not ArgumentException) throw new Exception("Expected a request validation response, not a publication conflict: " + label, error); passed++; return; } throw new Exception("FAILED batch accepted: " + label); }
        var root = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.Combine(root, "SparkStudio.TableBatch." + Guid.NewGuid().ToString("N"));
        if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(root)) throw new Exception("Unsafe test directory");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            catalog.GatewayStore.SaveConnection(new JsonObject { ["id"] = "batch", ["name"] = "Disposable batch", ["type"] = "sqlite", ["database"] = "batch.db" });
            var project = JsonNode.Parse("""
            {"id":"batch","name":"Batch","revision":0,"parameters":{},"screens":[{"id":"main","name":"Main","width":800,"height":600,"components":[
            {"id":"table","type":"table","x":0,"y":0,"width":700,"height":500,"props":{"queryId":"records","rowKey":"id","selectionMode":"multiple","tableEdit":{"versionColumn":"version","batch":{"table":"production_records"},"columns":[{"key":"quantity","type":"number","min":0,"max":10000,"integer":true},{"key":"status","type":"string","required":true,"maxLength":20}]}}}]}],"templates":[]}
            """)!.AsObject();
            var definitions = JsonNode.Parse("""
            [{"id":"records","name":"Records","connectionId":"batch","sql":"SELECT id,version,quantity,status FROM production_records WHERE id <= 2 ORDER BY id","parameters":[]}]
            """)!.AsArray();
            var workspace = catalog.Create("Batch", project, definitions);
            using var connectors = new ConnectorService(directory);
            var connection = workspace.Store.GetConnection("batch");
            await connectors.CreateSqliteDatabaseAsync(connection, true, default);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(workspace.Store, connectors);
            var python = new PythonRunner(tags, queries, workspace.Scripts, new ConfigurationBuilder().Build());
            var actions = new RuntimeActions(workspace.Publication, python, queries);
            var stamp = workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            TableCellEditRequest Cell(object key, object version, string column, object value) => new(JsonSerializer.SerializeToElement(key), JsonSerializer.SerializeToElement(version), column, JsonSerializer.SerializeToElement(value));
            TableEditRequest Request(params TableCellEditRequest[] cells) => new(stamp, null, default, default, null, default, Edits: cells);
            Task<JsonObject> Apply(params TableCellEditRequest[] cells) => actions.ExecuteTableBatchEditAsync("main", "table", Request(cells), default);
            async Task<string> Data() => JsonSerializer.Serialize((await connectors.QueryAsync(connection, "SELECT id,version,quantity,status FROM production_records ORDER BY id", [], default)).Rows);
            var result = await Apply(Cell(1, 1, "quantity", 5), Cell(1, 1, "status", "running"), Cell(2, 1, "quantity", 6));
            Check(result["success"]!.GetValue<bool>() && result["result"]!["rowsAffected"]!.GetValue<int>() == 2 && result["result"]!["cellsApplied"]!.GetValue<int>() == 3, "one result for all staged cells");
            var rows = (await connectors.QueryAsync(connection, "SELECT * FROM production_records ORDER BY id", [], default)).Rows;
            Check((long)rows[0]["version"]! == 2 && (long)rows[1]["version"]! == 2 && (long)rows[2]["version"]! == 1 && (string)rows[0]["status"]! == "running", "multiple cells advance each changed row version exactly once");
            var before = await Data();
            await Reject(() => Apply(Cell(1, 2, "quantity", 999), Cell(2, 2, "status", "invalid-status")), "second database constraint failure", validationOnly: true);
            Check(await Data() == before, "second-row constraint failure rolls back first row and all versions");
            await Reject(() => connectors.ExecuteTableBatchAsync(connection, "SELECT * FROM production_records", [], "production_records", "id", "version", _ => [
                new(new("rowKey", "long", 1),2,[new("quantity","number",888)]), new(new("rowKey","long",2),1,[new("quantity","number",999)])], default), "second affected-row mismatch inside transaction");
            Check(await Data() == before, "failed affected-row predicate rolls back preceding successful update");
            using (var blockedConnectors = new ConnectorService(directory, () => throw new InvalidOperationException("Read-only preview")))
                await Reject(() => blockedConnectors.ExecuteTableBatchAsync(connection, "SELECT * FROM production_records", [], "production_records", "id", "version", _ => throw new Exception("Validation must not run"), default), "connector recovery gate prevents batch execution");
            using (var cancellation = new CancellationTokenSource())
            {
                try { await connectors.ExecuteTableBatchAsync(connection, "SELECT * FROM production_records", [], "production_records", "id", "version", _ => { cancellation.Cancel(); return [new(new("rowKey", "long", 1),2,[new("quantity","number",888)])]; }, cancellation.Token); throw new Exception("Cancelled validation reached commit"); }
                catch (OperationCanceledException) { passed++; }
                Check(await Data() == before, "cancellation after membership read leaves transaction unchanged");
            }
            foreach (var cells in new[] {
                new[]{Cell(1,2,"quantity",7),Cell(2,1,"quantity",8)}, new[]{Cell(1,2,"quantity",7),Cell(3,1,"quantity",8)},
                new[]{Cell(1,2,"quantity",7),Cell(1,2,"quantity",8)}, new[]{Cell("1",2,"quantity",7)},
                new[]{Cell(1,2,"quantity",1.5)}, new[]{Cell(1,2,"quantity",10001)}, new[]{Cell(1,2,"work_order","forged")},
                new[]{Cell(1,2,"version",4)}, new[]{Cell(1,2,"status","")}, Array.Empty<TableCellEditRequest>(),
                Enumerable.Repeat(Cell(1,2,"quantity",1),101).ToArray(), new TableCellEditRequest[]{null!} })
            {
                await Reject(() => Apply(cells), "invalid, forged, stale or oversized intent");
                Check(await Data() == before, "invalid batch leaves every row untouched");
            }
            var mixed = Request(Cell(1,2,"quantity",7)) with { Column = "quantity" };
            await Reject(() => actions.ExecuteTableBatchEditAsync("main", "table", mixed, default), "mixed scalar and batch intents");
            await Reject(() => actions.ExecuteTableEditAsync("main", "table", Request(Cell(1,2,"quantity",7)), default), "batch cannot enter scalar Python handler");
            var json = JsonSerializer.Serialize(new { publishedAt = stamp, edits = new[]{new { key=1,version=2,column="quantity",value=7 }} });
            var decoded = JsonSerializer.Deserialize<TableEditRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
            Check(decoded.Key.ValueKind == JsonValueKind.Undefined && decoded.Edits!.Count == 1, "HTTP batch JSON needs no dummy scalar values");
            using (var cancelled = new CancellationTokenSource())
            {
                cancelled.Cancel();
                try { await actions.ExecuteTableBatchEditAsync("main", "table", Request(Cell(1,2,"quantity",7)), cancelled.Token); throw new Exception("cancel accepted"); }
                catch (OperationCanceledException) { passed++; }
                Check(await Data() == before, "cancelled batch changes nothing");
            }
            var concurrent = await Task.WhenAll(Enumerable.Range(0,2).Select(async index => {
                try { await Apply(Cell(1,2,"quantity",10+index),Cell(2,2,"quantity",20+index)); return true; }
                catch (ArgumentException) { return false; }
            }));
            Check(concurrent.Count(success => success) == 1, "one concurrent captured-version batch wins");
            rows = (await connectors.QueryAsync(connection, "SELECT * FROM production_records ORDER BY id", [], default)).Rows;
            Check((long)rows[0]["version"]! == 3 && (long)rows[1]["version"]! == 3 && (long)rows[1]["quantity"]! - (long)rows[0]["quantity"]! == 10, "concurrent rows belong to one complete winner");
            var draft = workspace.Store.GetProject(); draft["screens"]![0]!["components"]![0]!["props"]!["tableEdit"]!["columns"]![0]!["max"] = 1; workspace.Store.SaveProject(draft);
            await Apply(Cell(1,3,"quantity",42));
            Check((long)(await connectors.QueryAsync(connection, "SELECT quantity FROM production_records WHERE id=1", [], default)).Rows[0]["quantity"]! == 42, "unpublished changed constraint cannot replace authoritative published definition");
            workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>());
            await Reject(() => Apply(Cell(1,4,"quantity",1)), "stale publication token");
            foreach (var identifier in new[]{"records;DELETE", "dbo.records", "records]", " version", "x\n", "1table"})
            {
                var invalid = workspace.Store.GetProject(); invalid["screens"]![0]!["components"]![0]!["props"]!["tableEdit"]!["batch"]!["table"] = identifier;
                await Reject(() => Task.FromResult(workspace.Store.SaveProject(invalid)), "SQL identifier cannot be supplied as executable SQL");
            }
            var scopedProject = project.DeepClone().AsObject();
            var tableComponent = project["screens"]![0]!["components"]![0]!.DeepClone();
            scopedProject["screens"] = JsonNode.Parse("""
            [{"id":"main","name":"Scoped batch","width":800,"height":600,"components":[{"id":"rows","type":"repeater","x":0,"y":0,"width":700,"height":500,"props":{"templateId":"outer","rows":[{"id":"one","parameters":{"recordId":"1"}},{"id":"two","parameters":{"recordId":"2"}}]}}]},
             {"id":"detail","name":"Detail","kind":"popup","width":800,"height":600,"parameters":{"recordId":"0"},"components":[]}]
            """);
            scopedProject["templates"] = JsonNode.Parse("""
            [{"id":"outer","name":"Outer","width":700,"height":250,"parameters":{"recordId":"1"},"parameterTypes":{"recordId":"number"},"components":[{"id":"inner","type":"template","x":0,"y":0,"width":680,"height":240,"props":{"templateId":"inner"}}]},
             {"id":"inner","name":"Inner","width":680,"height":240,"parameters":{"recordId":"{recordId}"},"parameterTypes":{"recordId":"number"},"components":[{"id":"open","type":"button","x":0,"y":0,"width":100,"height":40,"props":{"action":"openPopup","targetScreenId":"detail","parameters":{"recordId":"{recordId}"}}}]}]
            """);
            scopedProject["templates"]![1]!["components"]!.AsArray().Add(tableComponent!.DeepClone());
            scopedProject["screens"]![1]!["components"]!.AsArray().Add(tableComponent.DeepClone());
            var scopedQueries = definitions.DeepClone().AsArray();
            scopedQueries[0]!["sql"] = "SELECT id,version,quantity,status FROM production_records WHERE id=@recordId";
            scopedQueries[0]!["parameters"] = JsonNode.Parse("""[{"name":"recordId","type":"int","defaultValue":1}]""");
            var nested = catalog.Create("Nested batch", scopedProject, scopedQueries);
            var nestedStamp = nested.Publication.Publish(nested.Store, nested.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            var nestedActions = new RuntimeActions(nested.Publication, python, new QueryExecutor(nested.Store, connectors));
            InstancePathStep[] path = [new("rows", "two"), new("inner")];
            var selectedRows = (await connectors.QueryAsync(connection, "SELECT id,version FROM production_records ORDER BY id", [], default)).Rows;
            var firstVersion = (long)selectedRows[0]["version"]!; var secondVersion = (long)selectedRows[1]["version"]!;
            var nestedRequest = Request(Cell(2,secondVersion,"quantity",52)) with { PublishedAt = nestedStamp, InstancePath = path };
            Check((await nestedActions.ExecuteTableBatchEditAsync("main", "table", nestedRequest, default))["success"]!.GetValue<bool>(), "nested repeated table reconstructs typed query parameter before atomic write");
            await Reject(() => nestedActions.ExecuteTableBatchEditAsync("main", "table", nestedRequest with { Edits = [Cell(1,firstVersion,"quantity",53)] }, default), "other repeated row cannot be forged into batch membership");
            var popupRequest = Request(Cell(2,secondVersion+1,"quantity",54)) with { PublishedAt = nestedStamp, PopupOrigin = new("main", "open", InstancePath: path) };
            Check((await nestedActions.ExecuteTableBatchEditAsync("detail", "table", popupRequest, default))["success"]!.GetValue<bool>(), "popup batch reconstructs its nested repeater opener");
            await Reject(() => nestedActions.ExecuteTableBatchEditAsync("detail", "table", popupRequest with { PopupOrigin = null }, default), "popup batch requires authoritative opener");
            await Reject(() => nestedActions.ExecuteTableBatchEditAsync("detail", "table", popupRequest with { PopupOrigin = new("main","open",InstancePath:[new("rows","missing"),new("inner")]) }, default), "forged nested popup row rejected");
            Check((long)(await connectors.QueryAsync(connection,"SELECT version FROM production_records WHERE id=1",[],default)).Rows[0]["version"]! == firstVersion, "cross-scope attempts cannot change another row");
            Console.WriteLine($"PASS {passed} atomic batch checks (real SQLite).");
            return passed;
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
}
