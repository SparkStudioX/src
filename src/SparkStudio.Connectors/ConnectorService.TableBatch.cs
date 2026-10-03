using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

namespace SparkStudio.Connectors;

public sealed record AtomicTableRow(QueryParameter Key, long Version, IReadOnlyList<QueryParameter> Values);

public sealed partial class ConnectorService
{
    public static void ValidateTableIdentifier(string value)
    {
        if (!Regex.IsMatch(value, @"\A[A-Za-z_][A-Za-z0-9_]{0,127}\z", RegexOptions.CultureInvariant))
            throw new ArgumentException("Atomic table and column names require 1–128 ASCII letters, digits or underscores, starting with a letter or underscore.");
    }

    /// <summary>Read membership and update declared cells inside one database transaction. No script or external operation runs.</summary>
    public async Task<ExecuteResult> ExecuteTableBatchAsync(ConnectionDefinition connection, string readSql, IReadOnlyList<QueryParameter> parameters,
        string table, string rowKey, string versionColumn, Func<QueryResult, IReadOnlyList<AtomicTableRow>> validate, CancellationToken cancellation)
    {
        _ensureOperationsAllowed?.Invoke();
        foreach (var identifier in new[] { table, rowKey, versionColumn }) ValidateTableIdentifier(identifier);
        if (rowKey == versionColumn) throw new ArgumentException("Row key and version column must differ.");
        SqlQueryGuard.Validate(readSql); ValidateReadParameters(parameters);
        var stopwatch = Stopwatch.StartNew();
        if (IsSqlite(connection)) return await RunSqliteAsync(token =>
        {
            using var client = OpenSqlite(SqlitePath(connection, true), false);
            RestrictSqlite(client, true, token, transactions: true);
            using var transaction = client.BeginTransaction();
            using var read = client.CreateCommand(); read.Transaction = transaction; read.CommandText = readSql; BindSqlite(read, parameters);
            QueryResult result;
            using (var reader = read.ExecuteReader(CommandBehavior.SingleResult)) result = ReadBatchRows(reader, token);
            var rows = validate(result); ValidateAtomicRows(rows, rowKey, versionColumn);
            foreach (var row in rows)
            {
                token.ThrowIfCancellationRequested();
                using var update = client.CreateCommand(); update.Transaction = transaction;
                var command = BatchCommand(table, rowKey, versionColumn, row); update.CommandText = command.Sql; BindSqlite(update, command.Parameters);
                if (update.ExecuteNonQuery() != 1) throw new InvalidOperationException("Batch conflict: every target must match exactly one current row. No batch changes were committed.");
            }
            token.ThrowIfCancellationRequested(); transaction.Commit();
            return new ExecuteResult(rows.Count, stopwatch.Elapsed.TotalMilliseconds);
        }, cancellation);
        RequireSql(connection);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await using var client = new SqlConnection(BuildConnectionString(connection, readOnly: false));
            await client.OpenAsync(timeout.Token);
            await using var transaction = (SqlTransaction)await client.BeginTransactionAsync(IsolationLevel.Serializable, timeout.Token);
            await using var read = new SqlCommand(readSql, client, transaction) { CommandTimeout = 15 };
            foreach (var parameter in parameters) read.Parameters.Add(BuildParameter(parameter));
            QueryResult result;
            await using (var reader = await read.ExecuteReaderAsync(CommandBehavior.SingleResult, timeout.Token)) result = ReadBatchRows(reader, timeout.Token);
            var rows = validate(result); ValidateAtomicRows(rows, rowKey, versionColumn);
            foreach (var row in rows)
            {
                var command = BatchCommand(table, rowKey, versionColumn, row);
                await using var update = new SqlCommand(command.Sql, client, transaction) { CommandTimeout = 15 };
                foreach (var parameter in command.Parameters) update.Parameters.Add(BuildParameter(parameter));
                if (await update.ExecuteNonQueryAsync(timeout.Token) != 1) throw new InvalidOperationException("Batch conflict: every target must match exactly one current row. No batch changes were committed.");
            }
            timeout.Token.ThrowIfCancellationRequested(); await transaction.CommitAsync(timeout.Token);
            return new ExecuteResult(rows.Count, stopwatch.Elapsed.TotalMilliseconds);
        }
        catch (SqlException error) { throw new InvalidOperationException($"Atomic SQL batch failed (error {error.Number}). Check the declared table, constraints, permissions and current row versions."); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw new TimeoutException("Atomic table batch exceeded its 30 second operation limit."); }
    }

    private static QueryResult ReadBatchRows(DbDataReader reader, CancellationToken cancellation)
    {
        var columns = UniqueColumns(Enumerable.Range(0, reader.FieldCount).Select(reader.GetName));
        var rows = new List<Dictionary<string, object?>>(); long bytes = 0;
        while (reader.Read())
        {
            cancellation.ThrowIfCancellationRequested();
            if (rows.Count == MaximumQueryRows) throw new ArgumentException("Atomic table membership exceeds 1,000 rows. Narrow its published read query.");
            var row = new Dictionary<string, object?>(StringComparer.Ordinal);
            for (var index = 0; index < columns.Length; index++)
            {
                var value = NormalizeValue(reader.GetValue(index));
                if (value is string { Length: > 1048576 } || value is byte[] { Length: > 1048576 }) throw new ArgumentException("A table cell exceeds the 1 MiB connector limit.");
                bytes += value is string text ? text.Length * 2L : 32;
                if (bytes > 16 * 1048576) throw new ArgumentException("Table membership exceeds the 16 MiB connector limit.");
                row[columns[index]] = value;
            }
            rows.Add(row);
        }
        return new QueryResult(columns, rows, 0);
    }

    private static void ValidateAtomicRows(IReadOnlyList<AtomicTableRow> rows, string rowKey, string versionColumn)
    {
        if (rows.Count is < 1 or > 100 || rows.Sum(row => row.Values.Count) > 100) throw new ArgumentException("An atomic batch requires 1–100 cells across at most 100 rows.");
        foreach (var row in rows)
        {
            if (row.Version is < 0 or >= 9007199254740991L || row.Values.Count == 0) throw new ArgumentException("The row version cannot be advanced safely.");
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var value in row.Values)
            {
                ValidateTableIdentifier(value.Name);
                if (!names.Add(value.Name) || value.Name.Equals(rowKey, StringComparison.OrdinalIgnoreCase) || value.Name.Equals(versionColumn, StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("Batch columns must be unique and cannot overwrite row identity or version.");
            }
        }
    }

    private static (string Sql, QueryParameter[] Parameters) BatchCommand(string table, string rowKey, string versionColumn, AtomicTableRow row)
    {
        var assignments = row.Values.Select((value, index) => $"[{value.Name}]=@v{index}");
        var sql = $"UPDATE [{table}] SET {string.Join(",", assignments)},[{versionColumn}]=[{versionColumn}]+1 WHERE [{rowKey}]=@rowKey AND [{versionColumn}]=@version";
        return (sql, [.. row.Values.Select((value, index) => value with { Name = $"v{index}" }), row.Key with { Name = "rowKey" }, new("version", "long", row.Version)]);
    }
}
