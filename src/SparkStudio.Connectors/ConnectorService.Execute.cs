using System.Diagnostics;
using Microsoft.Data.SqlClient;

namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    public async Task<ExecuteResult> ExecuteAsync(ConnectionDefinition connection, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken cancellationToken)
    {
        _ensureOperationsAllowed?.Invoke();
        DatabaseConnectors.RejectUpdates(connection); // database connector plugin
        SqlQueryGuard.ValidateUpdate(sql);
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count > 128) throw new ArgumentException("At most 128 query parameters are supported.");
        if (IsSqlite(connection)) return await ExecuteSqliteAsync(connection, sql, parameters, cancellationToken);
        RequireSql(connection);
        var stopwatch = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await using var client = new SqlConnection(BuildConnectionString(connection, readOnly: false));
            await using var command = new SqlCommand(sql, client) { CommandTimeout = 15 };
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var definition in parameters)
            {
                var item = BuildParameter(definition);
                if (!names.Add(item.ParameterName)) throw new ArgumentException("Duplicate SQL parameter names are not supported.");
                command.Parameters.Add(item);
            }
            await client.OpenAsync(timeout.Token);
            var affected = await command.ExecuteNonQueryAsync(timeout.Token);
            return new(affected, stopwatch.Elapsed.TotalMilliseconds);
        }
        catch (SqlException error) { throw new InvalidOperationException($"SQL Server update failed (error {error.Number}). Check the query, schema, constraints, update permissions and connection."); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new TimeoutException("SQL update exceeded the 30 second operation limit."); }
    }
}
