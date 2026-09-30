using System.Data;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using SQLitePCL;

namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    private readonly SemaphoreSlim _sqliteSlots = new(4, 4);
    private static bool IsSqlite(ConnectionDefinition connection) => string.Equals(connection.Type, "sqlite", StringComparison.OrdinalIgnoreCase);

    public static string ValidateSqliteDatabaseName(string? database)
    {
        if (database is null || !Regex.IsMatch(database, @"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(db|sqlite|sqlite3)\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            throw new ArgumentException("SQLite database must be a simple filename such as production.db (up to 64 letters, digits, underscores or hyphens before .db, .sqlite or .sqlite3).");
        var stem = Path.GetFileNameWithoutExtension(database);
        if (Regex.IsMatch(stem, @"\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            throw new ArgumentException("Reserved device names cannot be used for SQLite databases.");
        return database;
    }

    internal string SqlitePath(ConnectionDefinition connection, bool mustExist)
    {
        if (!IsSqlite(connection)) throw new ArgumentException("A sqlite connection is required.");
        var name = ValidateSqliteDatabaseName(connection.Database);
        var directory = Path.Combine(_dataDirectory, "databases");
        var path = Path.Combine(directory, name);
        CheckManagedPath(path);
        foreach (var suffix in new[] { "-journal", "-wal", "-shm" }) CheckManagedPath(path + suffix);
        if (mustExist && !File.Exists(path))
            throw new InvalidOperationException("Managed SQLite database does not exist. Create it explicitly before testing or querying this connection.");
        return path;
    }

    // The managed directory is service-owned. Reject existing links in every ancestor and SQLite sidecar.
    // This is not an isolation boundary against an administrator changing the filesystem concurrently.
    private static void CheckManagedPath(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new ArgumentException("Managed SQLite paths cannot contain symbolic links, junctions, or other reparse points.");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    private static SqliteConnection OpenSqlite(string path, bool readOnly)
    {
        CheckManagedPath(path);
        var client = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWrite,
            // Native authorizers/progress callbacks belong to this operation and
            // must never leak through a pooled sqlite handle into the next caller.
            Pooling = false, DefaultTimeout = 5, ForeignKeys = true
        }.ToString());
        try
        {
            client.Open();
            client.EnableExtensions(false);
            using var command = client.CreateCommand();
            command.CommandText = "PRAGMA trusted_schema = OFF";
            command.ExecuteNonQuery();
            if (!readOnly)
            {
                // WAL permits a table transaction and readers to proceed together.
                // Existing databases are upgraded on the first writable open.
                command.CommandText = "PRAGMA journal_mode = WAL";
                if (!string.Equals(Convert.ToString(command.ExecuteScalar()), "wal", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The managed SQLite database could not enable WAL journaling.");
                command.CommandText = "PRAGMA synchronous = FULL";
                command.ExecuteNonQuery();
            }
            return client;
        }
        catch { client.Dispose(); throw; }
    }

    private async Task<T> RunSqliteAsync<T>(CancellationToken cancellationToken, Func<CancellationToken, T> operation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await _sqliteSlots.WaitAsync(timeout.Token);
            try { return await Task.Run(() => { timeout.Token.ThrowIfCancellationRequested(); return operation(timeout.Token); }, timeout.Token); }
            finally { _sqliteSlots.Release(); }
        }
        catch (SqliteException) when (cancellationToken.IsCancellationRequested) { throw new OperationCanceledException(cancellationToken); }
        catch (Exception error) when (timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested && error is SqliteException or OperationCanceledException)
        { throw new TimeoutException("SQLite operation exceeded the 30 second operation limit."); }
        catch (SqliteException error)
        { throw new InvalidOperationException($"SQLite operation failed (error {error.SqliteErrorCode}). Check the query, declared parameter types, database schema, constraints and file access."); }
        catch (IOException) { throw new InvalidOperationException("Managed SQLite file operation failed. Check database existence, ownership and disk space."); }
        catch (UnauthorizedAccessException) { throw new InvalidOperationException("The gateway cannot access the managed SQLite database directory."); }
    }

    private static void RestrictSqlite(SqliteConnection client, bool allowWrites, CancellationToken ct, bool schema = false, bool transactions = false)
    {
        var handle = client.Handle!;
        raw.sqlite3_limit(handle, raw.SQLITE_LIMIT_LENGTH, 1_048_576);
        raw.sqlite3_limit(handle, raw.SQLITE_LIMIT_SQL_LENGTH, 65_536);
        raw.sqlite3_limit(handle, raw.SQLITE_LIMIT_COLUMN, 256);
        raw.sqlite3_limit(handle, raw.SQLITE_LIMIT_ATTACHED, 0);
        raw.sqlite3_progress_handler(handle, 1000, _ => ct.IsCancellationRequested ? 1 : 0, null!);
        strdelegate_authorizer authorize = (_, action, first, second, database, _) =>
        {
            if (action is raw.SQLITE_SELECT or raw.SQLITE_RECURSIVE) return raw.SQLITE_OK;
            if (transactions && action == raw.SQLITE_TRANSACTION) return raw.SQLITE_OK;
            if (action == raw.SQLITE_READ) return database is null or "" or "main" or "temp" ? raw.SQLITE_OK : raw.SQLITE_DENY;
            if (action == raw.SQLITE_FUNCTION)
                return second is not null && new[] { "load_extension", "readfile", "writefile", "fts3_tokenizer" }.Contains(second, StringComparer.OrdinalIgnoreCase) ? raw.SQLITE_DENY : raw.SQLITE_OK;
            if (schema && action == raw.SQLITE_PRAGMA && first.Equals("table_info", StringComparison.OrdinalIgnoreCase)) return raw.SQLITE_OK;
            if (allowWrites && action is raw.SQLITE_INSERT or raw.SQLITE_UPDATE or raw.SQLITE_DELETE)
                return database == "main" && !first.StartsWith("sqlite_", StringComparison.OrdinalIgnoreCase) ? raw.SQLITE_OK : raw.SQLITE_DENY;
            return raw.SQLITE_DENY;
        };
        if (raw.sqlite3_set_authorizer(handle, authorize, null!) != raw.SQLITE_OK)
            throw new InvalidOperationException("Could not restrict the SQLite connection.");
    }

    private static void BindSqlite(SqliteCommand command, IReadOnlyList<QueryParameter> parameters)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count > 128) throw new ArgumentException("At most 128 query parameters are supported.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var definition in parameters)
        {
            var parameter = BuildParameter(definition);
            if (!names.Add(parameter.ParameterName)) throw new ArgumentException("Duplicate SQL parameter names are not supported.");
            command.Parameters.AddWithValue(parameter.ParameterName, parameter.Value);
        }
    }

    private Task<QueryResult> QuerySqliteAsync(ConnectionDefinition connection, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken ct)
    {
        SqlQueryGuard.Validate(sql);
        var path = SqlitePath(connection, true);
        return RunSqliteAsync(ct, cancellation =>
        {
            var stopwatch = Stopwatch.StartNew();
            using var client = OpenSqlite(path, true);
            RestrictSqlite(client, false, cancellation);
            using var command = client.CreateCommand();
            command.CommandText = sql;
            BindSqlite(command, parameters);
            using var reader = command.ExecuteReader(CommandBehavior.SingleResult);
            var columns = UniqueColumns(Enumerable.Range(0, reader.FieldCount).Select(reader.GetName));
            var rows = new List<Dictionary<string, object?>>();
            long bytes = 0;
            while (reader.Read())
            {
                cancellation.ThrowIfCancellationRequested();
                if (rows.Count == MaximumQueryRows) throw new InvalidOperationException($"Query exceeds {MaximumQueryRows:N0} rows. Add LIMIT or a narrower WHERE clause.");
                var row = new Dictionary<string, object?>();
                for (var i = 0; i < columns.Length; i++)
                {
                    var value = NormalizeValue(reader.GetValue(i));
                    bytes += value is string text ? text.Length * 2L : 32;
                    if (bytes > 16 * 1_048_576) throw new InvalidOperationException("Query results exceed the 16 MiB connector limit.");
                    row[columns[i]] = value;
                }
                rows.Add(row);
            }
            return new QueryResult(columns, rows, stopwatch.Elapsed.TotalMilliseconds);
        });
    }

    private Task<ExecuteResult> ExecuteSqliteAsync(ConnectionDefinition connection, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken ct)
    {
        var path = SqlitePath(connection, true);
        return RunSqliteAsync(ct, cancellation =>
        {
            var stopwatch = Stopwatch.StartNew();
            using var client = OpenSqlite(path, false);
            RestrictSqlite(client, true, cancellation);
            using var command = client.CreateCommand();
            command.CommandText = sql;
            BindSqlite(command, parameters);
            cancellation.ThrowIfCancellationRequested();
            var count = command.ExecuteNonQuery();
            return new ExecuteResult(count, stopwatch.Elapsed.TotalMilliseconds);
        });
    }

    public Task<ConnectionTestResult> CreateSqliteDatabaseAsync(ConnectionDefinition connection, bool initializeSampleData, CancellationToken ct)
    {
        _ensureOperationsAllowed?.Invoke();
        var path = SqlitePath(connection, false);
        return RunSqliteAsync(ct, cancellation =>
        {
            if (File.Exists(path) || Directory.Exists(path)) throw new InvalidOperationException("Managed SQLite database already exists; creation never overwrites existing data.");
            var directory = Path.GetDirectoryName(path)!;
            CheckManagedPath(directory);
            Directory.CreateDirectory(directory);
            CheckManagedPath(directory);
            var staging = Path.Combine(directory, "creating-" + Guid.NewGuid().ToString("N") + ".db");
            try
            {
                using (new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
                using (var client = OpenSqlite(staging, false))
                {
                    using var command = client.CreateCommand();
                    command.CommandText = "PRAGMA user_version = 1";
                    command.ExecuteNonQuery();
                    if (initializeSampleData)
                    {
                        command.CommandText = """
                            CREATE TABLE production_records (
                              id INTEGER PRIMARY KEY, work_order TEXT NOT NULL, machine TEXT NOT NULL,
                              quantity INTEGER NOT NULL CHECK(quantity >= 0),
                              status TEXT NOT NULL CHECK(status IN ('queued','running','complete')),
                              recorded_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
                            INSERT INTO production_records(work_order,machine,quantity,status,recorded_at)
                            VALUES ('DEMO-1001','Press01',0,'queued','2026-01-01T08:00:00Z'),
                                   ('DEMO-1002','Press02',45,'running','2026-01-01T08:15:00Z'),
                                   ('DEMO-1003','Press03',120,'complete','2026-01-01T08:30:00Z');
                            """;
                        command.ExecuteNonQuery();
                    }
                }
                cancellation.ThrowIfCancellationRequested();
                SqlitePath(connection, false);
                File.Move(staging, path, false);
                return new ConnectionTestResult(true, initializeSampleData ? "Managed SQLite database created with synthetic production_records sample data." : "Empty managed SQLite database created.");
            }
            finally { if (File.Exists(staging)) File.Delete(staging); }
        });
    }

    public Task<IReadOnlyList<DatabaseTable>> BrowseSqliteSchemaAsync(ConnectionDefinition connection, CancellationToken ct)
    {
        _ensureOperationsAllowed?.Invoke();
        var path = SqlitePath(connection, true);
        return RunSqliteAsync<IReadOnlyList<DatabaseTable>>(ct, cancellation =>
        {
            using var client = OpenSqlite(path, true);
            RestrictSqlite(client, false, cancellation, schema: true);
            using var command = client.CreateCommand();
            command.CommandText = "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 101";
            var names = new List<string>();
            using (var reader = command.ExecuteReader()) while (reader.Read()) names.Add(reader.GetString(0));
            if (names.Count > 100) throw new InvalidOperationException("Schema browsing is limited to 100 tables.");
            var tables = new List<DatabaseTable>();
            foreach (var name in names)
            {
                cancellation.ThrowIfCancellationRequested();
                command.CommandText = "SELECT name,type,\"notnull\",pk FROM pragma_table_info(@table)";
                command.Parameters.Clear();
                command.Parameters.AddWithValue("@table", name);
                var columns = new List<DatabaseColumn>();
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    if (columns.Count == 256) throw new InvalidOperationException("Schema tables are limited to 256 columns.");
                    var primaryKey = reader.GetInt64(3) != 0;
                    columns.Add(new(reader.GetString(0), reader.GetString(1), reader.GetInt64(2) == 0 && !primaryKey, primaryKey));
                }
                tables.Add(new(name, columns));
            }
            return tables;
        });
    }
}
