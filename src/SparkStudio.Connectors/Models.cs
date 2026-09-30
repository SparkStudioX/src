namespace SparkStudio.Connectors;

public sealed record ConnectionDefinition(string Id, string Name, string Type,
    string? Endpoint = null, string? Server = null, string? Database = null,
    string? Username = null, string? Password = null, string? SecurityMode = null,
    bool TrustServerCertificate = false, string? ServerCertificateSha256 = null);

public sealed record ConnectionTestResult(bool Success, string Message);
public sealed record BrowseNode(string NodeId, string DisplayName, bool IsVariable);
public sealed record ConnectorValue(string NodeId, object? Value, string DataType,
    string Quality, DateTimeOffset Timestamp);
public sealed record QueryParameter(string Name, string Type, object? Value);
public sealed record QueryResult(string[] Columns, IReadOnlyList<Dictionary<string, object?>> Rows,
    double DurationMs);
public sealed record ExecuteResult(int RowsAffected, double DurationMs);
public sealed record DatabaseColumn(string Name, string DataType, bool Nullable, bool PrimaryKey);
public sealed record DatabaseTable(string Name, IReadOnlyList<DatabaseColumn> Columns);
public sealed record OpcEndpoint(string EndpointUrl, string SecurityMode, string SecurityPolicy,
    string? ServerCertificateSha256, string? ServerCertificateSubject, string[] UserTokenTypes);
public sealed record OpcMonitorSettings(double AbsoluteDeadband = 0, uint QueueSize = 16);
