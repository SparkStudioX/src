using System.Data;
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Data.SqlClient;
using Microsoft.Data.Sqlite;
using SparkStudio.Connectors;

internal static class SqliteIntegration
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        async Task Reject(Func<Task> action, string description)
        {
            try { await action(); }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or TimeoutException)
            { check(true, description); return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var root = Path.Combine(Path.GetTempPath(), "sparkstudio-sqlite-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var service = new ConnectorService(root);
            var connection = new ConnectionDefinition("sqlite-test", "Disposable test", "sqlite", Database: "production.db");
            var absent = await service.TestAsync(connection, default);
            check(!absent.Success && absent.Message.Contains("Create it explicitly") && !Directory.Exists(Path.Combine(root, "databases")), "test never creates a missing database");
            foreach (var name in new[] { "../escape.db", "..\\escape.db", "/tmp/escape.db", "C:\\escape.db", "file:escape.db", ":memory:", "x.db;Mode=Memory", "x.db?mode=ro", " x.db", "x.db ", "x.db\n", "x/db", "x\\db", "CON.db", "nul.sqlite", "LPT9.sqlite3", "a.b.db", "", "x", new string('a', 65) + ".db" })
                await Reject(() => service.CreateSqliteDatabaseAsync(connection with { Database = name }, false, default), "unsafe SQLite filename rejected");
            check(ConnectorService.ValidateSqliteDatabaseName("local-1_data.SQLITE3") == "local-1_data.SQLITE3", "safe portable filename accepted");
            var created = await service.CreateSqliteDatabaseAsync(connection, true, default);
            check(created.Success && (await service.TestAsync(connection, default)).Success, "created SQLite database passes a real read test");
            var path = service.SqlitePath(connection, true);
            var hash = SHA256.HashData(File.ReadAllBytes(path));
            await Reject(() => service.CreateSqliteDatabaseAsync(connection, false, default), "existing SQLite database cannot be overwritten");
            check(hash.SequenceEqual(SHA256.HashData(File.ReadAllBytes(path))), "failed create preserves existing database bytes");
            var initial = await service.QueryAsync(connection, "SELECT * FROM production_records ORDER BY id", [], default);
            check(initial.Rows.Count == 3 && initial.Rows.Select(r => (string)r["status"]!).SequenceEqual(new[] { "queued", "running", "complete" }) && initial.Rows.All(r => (long)r["version"]! == 1), "synthetic sample schema and rows");
            var schema = await service.BrowseSqliteSchemaAsync(connection, default);
            check(schema.Count == 1 && schema[0].Name == "production_records" && schema[0].Columns.Count == 7 && schema[0].Columns.Single(c => c.Name == "id").PrimaryKey && !schema[0].Columns.Single(c => c.Name == "work_order").Nullable, "SQLite schema reports tables and column metadata");
            var typed = await service.QueryAsync(connection, "SELECT @text AS Value,@null AS Value,@flag AS Flag,@number AS Number,@date AS Date", [new("text", "string", "'; DELETE FROM production_records;--"), new("null", "string", null), new("flag", "bool", true), new("number", "double", 1.25), new("date", "date", "2026-01-02")], default);
            check(typed.Columns.Contains("Value_2") && typed.Rows[0]["Value_2"] is null && (long)typed.Rows[0]["Flag"]! == 1 && (double)typed.Rows[0]["Number"]! == 1.25 && ((string)typed.Rows[0]["Date"]!).StartsWith("2026-01-02"), "typed parameters, nulls and duplicate columns preserved");
            var inserted = await service.ExecuteAsync(connection, "INSERT INTO production_records(work_order,machine,quantity,status,recorded_at) VALUES(@order,@machine,@quantity,@status,@at)", [new("order", "string", "'; DROP TABLE production_records;--"), new("machine", "string", "TestCell"), new("quantity", "int", 7), new("status", "string", "queued"), new("at", "string", "2026-01-01T09:00:00Z")], default);
            check(inserted.RowsAffected == 1, "parameterized insert returns affected rows");
            var update = "UPDATE production_records SET quantity=@quantity, version=version+1 WHERE id=@id AND version=@version";
            QueryParameter[] parameters = [new("quantity", "int", 8), new("id", "int", 4), new("version", "int", 1)];
            check((await service.ExecuteAsync(connection, update, parameters, default)).RowsAffected == 1 && (await service.ExecuteAsync(connection, update, parameters, default)).RowsAffected == 0, "optimistic update reports stale version as zero rows");
            var selected = await service.QueryAsync(connection, "SELECT work_order,quantity,version FROM production_records WHERE id=@id", [new("id", "int", 4)], default);
            check((string)selected.Rows[0]["work_order"]! == "'; DROP TABLE production_records;--" && (long)selected.Rows[0]["quantity"]! == 8 && (long)selected.Rows[0]["version"]! == 2, "SQL-looking input remains literal data");
            check((await service.ExecuteAsync(connection, "DELETE FROM production_records WHERE id=@id", [new("id", "int", 4)], default)).RowsAffected == 1, "parameterized delete returns affected rows");
            await Reject(() => service.ExecuteAsync(connection, "UPDATE production_records SET quantity=-1 WHERE id=1", [], default), "constraint failure propagates without partial write");
            check((long)(await service.QueryAsync(connection, "SELECT quantity FROM production_records WHERE id=1", [], default)).Rows[0]["quantity"]! == 0, "failed update is atomic");
            foreach (var sql in new[] { "UPDATE production_records SET quantity=1", "SELECT 1; DELETE FROM production_records", "WITH q AS (SELECT 1) DELETE FROM production_records", "SELECT load_extension('anything')", "SELECT * FROM pragma_table_info('production_records')" })
                await Reject(() => service.QueryAsync(connection, sql, [], default), "read endpoint rejects write or privileged SQL");
            foreach (var sql in new[] { "CREATE TABLE x(n)", "DROP TABLE production_records", "SELECT 1", "WITH q AS (SELECT 1) UPDATE production_records SET quantity=2", "UPDATE production_records SET quantity=1;DELETE FROM production_records", "UPDATE production_records SET quantity=1 SELECT 2", "UPDATE production_records SET quantity=1 /*hidden*/ UPDATE production_records SET quantity=2", "UPDATE production_records SET quantity=1;/*comment*/;", "UPDATE production_records SET quantity=1 EXEC('x')", "UPDATE production_records SET quantity=1 RETURNING *", "INSERT INTO production_records SELECT * FROM production_records", "DELETE FROM production_records; ATTACH DATABASE 'other.db' AS other", "UPDATE production_records SET quantity=(SELECT load_extension('anything'))", "UPDATE production_records SET quantity=1 /*unterminated" })
                await Reject(() => service.ExecuteAsync(connection, sql, [], default), "DDL, batches and dangerous update syntax rejected");
            foreach (var sql in new[] { "UPDATE production_records SET quantity=@n WHERE id=@id; -- end", "/*start*/ INSERT INTO production_records(work_order,machine,quantity,status,recorded_at) VALUES('delete; --','test',1,'queued','today')", "DELETE FROM production_records WHERE id=(SELECT MAX(id) FROM production_records)", "UPDATE production_records SET `quantity`=1 WHERE id=1", "UPDATE production_records SET quantity=1 WHERE work_order='it''s ; DELETE safe'" })
                check(SqlQueryGuard.ValidateUpdate(sql) == sql, "single DML with comments, quoted data and nested select accepted");
            foreach (var suffix in new[] { "DISABLE TRIGGER trigger_name ON production_records", "ENABLE TRIGGER trigger_name ON production_records", "REVERT", "SETUSER 'another_user'", "WRITETEXT production_records.note @pointer 'other'" })
            {
                await Reject(() => Task.FromResult(SqlQueryGuard.Validate("SELECT 1 " + suffix)), "SQL Server administrative statement cannot follow a read without a separator");
                await Reject(() => Task.FromResult(SqlQueryGuard.ValidateUpdate("UPDATE production_records SET quantity=1 " + suffix)), "SQL Server administrative statement cannot follow an update without a separator");
            }
            await Reject(() => service.QueryAsync(connection, "SELECT @x", [new("x", "int", 1), new("@X", "int", 2)], default), "duplicate parameter names rejected");
            await Reject(() => service.QueryAsync(connection, "SELECT @x", [new("x\n", "int", 1)], default), "parameter name rejects terminal newline");
            await Reject(() => service.QueryAsync(connection, "SELECT @x", [new("x", "double", double.NaN)], default), "nonfinite SQL parameter rejected");
            check((await service.QueryAsync(connection, "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<5) SELECT n FROM x", [], default)).Rows.Count == 5, "bounded recursive CTE remains supported");
            await Reject(() => service.QueryAsync(connection, "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<1001) SELECT n FROM x", [], default), "row cap rejects partial result");
            await Reject(() => service.QueryAsync(connection, "SELECT zeroblob(2000000)", [], default), "native SQLite value size limit enforced before allocation");
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
            {
                var watch = Stopwatch.StartNew();
                try
                {
                    await service.QueryAsync(connection, "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x", [], cancellation.Token);
                    throw new Exception("FAILED: unbounded query must cancel");
                }
                catch (OperationCanceledException) { check(watch.Elapsed < TimeSpan.FromSeconds(3), "native SQLite progress handler cancels active query promptly"); }
            }
            check((await service.TestAsync(connection, default)).Success, "cancelled query closes cleanly and later query works");
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
            {
                try
                {
                    await service.ExecuteAsync(connection, "UPDATE production_records SET quantity=(WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x) WHERE id=1", [], cancellation.Token);
                    throw new Exception("FAILED: unbounded update must cancel");
                }
                catch (OperationCanceledException) { check(true, "native SQLite progress handler cancels active update"); }
            }
            check((long)(await service.QueryAsync(connection, "SELECT quantity FROM production_records WHERE id=1", [], default)).Rows[0]["quantity"]! == 0, "cancelled update leaves original row intact");
            using (var locked = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()))
            {
                locked.Open();
                using var transaction = locked.BeginTransaction();
                using var command = locked.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "UPDATE production_records SET quantity=quantity+1 WHERE id=1";
                command.ExecuteNonQuery();
                var timer = Stopwatch.StartNew();
                await Reject(() => service.ExecuteAsync(connection, "UPDATE production_records SET quantity=quantity+1 WHERE id=1", [], default), "locked database update stops within timeout");
                check(timer.Elapsed >= TimeSpan.FromSeconds(4) && timer.Elapsed < TimeSpan.FromSeconds(8), "SQLite writer contention waits approximately five seconds, then fails within a bounded deadline");
                transaction.Rollback();
            }
            var empty = connection with { Database = "empty.sqlite" };
            check((await service.CreateSqliteDatabaseAsync(empty, false, default)).Success && (await service.BrowseSqliteSchemaAsync(empty, default)).Count == 0, "explicit empty database creation has no sample tables");
            using (var reopened = new ConnectorService(root))
                check((await reopened.QueryAsync(connection, "SELECT count(*) AS n FROM production_records", [], default)).Rows.Count == 1, "managed database persists across connector restart");
            var mssql = new ConnectionDefinition("test", "test", "sqlserver", Server: "localhost", Database: "test");
            check(new SqlConnectionStringBuilder(ConnectorService.BuildConnectionString(mssql, false)).ApplicationIntent == ApplicationIntent.ReadWrite && new SqlConnectionStringBuilder(ConnectorService.BuildConnectionString(mssql)).ApplicationIntent == ApplicationIntent.ReadOnly, "SQL Server update routing is explicit and read routing preserved");
            var outside = Path.Combine(root, "outside");
            Directory.CreateDirectory(outside);
            var linked = Path.Combine(root, "linked");
            Directory.CreateDirectory(linked);
            var link = Path.Combine(linked, "databases");
            var linkCreated = false;
            try
            {
                if (OperatingSystem.IsWindows())
                {
                    var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-NonInteractive"); start.ArgumentList.Add("-Command");
                    start.ArgumentList.Add("New-Item -ItemType Junction -Path '" + link.Replace("'", "''") + "' -Target '" + outside.Replace("'", "''") + "' -ErrorAction Stop | Out-Null");
                    using var process = Process.Start(start)!;
                    await process.WaitForExitAsync();
                    if (process.ExitCode != 0) throw new InvalidOperationException("Could not create disposable junction fixture.");
                }
                else Directory.CreateSymbolicLink(link, outside);
                linkCreated = true;
                using var linkedService = new ConnectorService(linked);
                await Reject(() => linkedService.CreateSqliteDatabaseAsync(connection, false, default), "database directory junction/symlink escape rejected");
                check(!File.Exists(Path.Combine(outside, "production.db")), "reparse rejection never writes outside managed directory");
            }
            finally { if (linkCreated) Directory.Delete(link); }
        }
        finally
        {
            // Only this uniquely created fixture tree is owned by the test; links are removed above.
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
