using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;

namespace SparkStudio.Connectors;

/// <summary>
/// Stable extension point for read-only database connectors shipped outside the SparkStudio tree.
/// See plugins/anylog/UPGRADE.md before changing this contract.
/// </summary>
public interface IDatabaseQueryConnector
{
    string Type { get; }
    string DisplayName { get; }
    string Description { get; }
    bool SupportsUpdates { get; }
    string DefaultSql { get; }
    IReadOnlyList<string> SafeTestFailures { get; }
    IReadOnlyList<DatabaseConnectorField> Fields { get; }
    JsonObject Normalize(JsonObject connection);
    Task<ConnectionTestResult> TestAsync(IReadOnlyDictionary<string, string> settings, CancellationToken cancellationToken);
    Task<QueryResult> QueryAsync(IReadOnlyDictionary<string, string> settings, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken cancellationToken);
}

public sealed record DatabaseConnectorField(string Name, string Label, string Kind, bool Required, string? Placeholder = null, string? DefaultValue = null, string? Help = null);

public sealed record DatabaseConnectorDescription(string Type, string DisplayName, string Description, bool SupportsUpdates, string DefaultSql, IReadOnlyList<DatabaseConnectorField> Fields);

public static class DatabaseConnectors
{
    private static readonly object Gate = new();
    private static readonly List<IDatabaseQueryConnector> Items = [];
    private static readonly HashSet<string> Failures = new(StringComparer.Ordinal);

    public static bool IsKnownType(string type) => type is "opcua" or "sqlserver" or "sqlite"
        || DeviceConfiguration.IsDevice(type) || SourceConfiguration.IsSource(type) || IsRegistered(type);

    public static bool IsRegistered(string type) => TryGet(type, out _);

    public static bool TryGet(string type, [NotNullWhen(true)] out IDatabaseQueryConnector? connector)
    {
        lock (Gate) connector = Items.FirstOrDefault(item => item.Type.Equals(type, StringComparison.OrdinalIgnoreCase));
        return connector is not null;
    }

    public static void Register(IDatabaseQueryConnector connector)
    {
        ArgumentNullException.ThrowIfNull(connector);
        ArgumentException.ThrowIfNullOrWhiteSpace(connector.Type);
        lock (Gate)
        {
            if (Items.Any(item => item.Type.Equals(connector.Type, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"Database connector '{connector.Type}' is already registered.");
            foreach (var message in connector.SafeTestFailures) RememberFailure(message);
            Items.Add(connector);
        }
    }

    public static void CopySettings(string type, JsonObject submitted, JsonObject node)
    {
        if (!TryGet(type, out var connector)) return;
        node["connector"] = connector.Normalize(submitted);
    }

    public static IReadOnlyDictionary<string, string>? ReadSettings(JsonObject value)
    {
        if (value["connector"] is not JsonObject settings) return null;
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in settings)
            if (pair.Value is JsonValue item && item.TryGetValue<string>(out var text)) result[pair.Key] = text;
        return result.Count == 0 ? null : result;
    }

    public static void MarkQueryable(JsonObject connection)
    {
        if (connection["type"] is JsonValue type && type.TryGetValue<string>(out var name) && IsRegistered(name))
            connection["queryable"] = true;
    }

    public static async Task<QueryResult?> QueryAsync(ConnectionDefinition connection, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken cancellationToken)
    {
        if (!Owned(connection, out var connector)) return null;
        var settings = connection.ConnectorSettings ?? throw new ArgumentException("This connection is missing its connector settings.");
        return await connector.QueryAsync(settings, sql, parameters, cancellationToken);
    }

    public static async Task<ConnectionTestResult?> TestAsync(ConnectionDefinition connection, CancellationToken cancellationToken)
    {
        if (!Owned(connection, out var connector)) return null;
        var settings = connection.ConnectorSettings ?? throw new ArgumentException("This connection is missing its connector settings.");
        return await connector.TestAsync(settings, cancellationToken);
    }

    private static bool Owned(ConnectionDefinition connection, [NotNullWhen(true)] out IDatabaseQueryConnector? connector)
    {
        if (TryGet(connection.Type, out connector)) return true;
        if (connection.ConnectorSettings is not null)
            throw new InvalidOperationException("This connection's database connector is not loaded. Restore its plugin and restart the gateway.");
        return false;
    }

    public static void RejectUpdates(ConnectionDefinition connection)
    {
        if (TryGet(connection.Type, out var connector) && !connector.SupportsUpdates)
            throw new ArgumentException("This connection accepts SELECT queries only.");
    }

    public static string ConnectionTestFailure(string? message)
        => message is not null && Failures.Contains(message) ? message : "Connection check failed. Verify the address, authentication and certificate settings.";

    public static IReadOnlyList<DatabaseConnectorDescription> Describe()
    {
        lock (Gate) return Items.Select(item => new DatabaseConnectorDescription(item.Type, item.DisplayName, item.Description, item.SupportsUpdates, item.DefaultSql, item.Fields)).ToArray();
    }

    private static void RememberFailure(string message)
    {
        if (string.IsNullOrWhiteSpace(message) || message.Length > 240 || message.Contains('\n') || message.Contains('\r'))
            throw new ArgumentException("A database connector test message must be a single short sentence.");
        Failures.Add(message);
    }
}

public static class DatabaseConnectorLoader
{
    public static void Load(string directory)
    {
        if (!Directory.Exists(directory)) return;
        foreach (var file in Directory.EnumerateFiles(directory, "SparkStudio.Connectors.*.dll").OrderBy(path => path, StringComparer.Ordinal))
        {
            if (string.Equals(Path.GetFileName(file), "SparkStudio.Connectors.dll", StringComparison.OrdinalIgnoreCase)) continue;
            if (file.Contains(".Tests.", StringComparison.OrdinalIgnoreCase)) continue;
            var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(file));
            RegisterConnectors(assembly);
        }
    }

    private static void RegisterConnectors(Assembly assembly)
    {
        foreach (var type in assembly.GetExportedTypes())
        {
            if (type.IsAbstract || !typeof(IDatabaseQueryConnector).IsAssignableFrom(type) || type.GetConstructor(Type.EmptyTypes) is null) continue;
            if (Activator.CreateInstance(type) is IDatabaseQueryConnector connector) DatabaseConnectors.Register(connector);
        }
    }
}
