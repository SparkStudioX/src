using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Opc.Ua;
using Opc.Ua.Client;
using Opc.Ua.Configuration;

namespace SparkStudio.Connectors;

/// <summary>External data connectors. SQL updates require an explicit ExecuteAsync call.</summary>
public sealed partial class ConnectorService : IDisposable
{
    public const int MaximumQueryRows = 1000;
    public const int MaximumBrowseNodes = 10000;
    public const int MaximumReadNodes = 1000;
    private readonly string _dataDirectory;
    private readonly Action? _ensureOperationsAllowed;
    private readonly SemaphoreSlim _configurationLock = new(1, 1);
    private readonly ITelemetryContext _telemetry = DefaultTelemetry.Create(_ => { });
    private ApplicationConfiguration? _configuration;
    private readonly ConnectionResourcePool<ISession> _sessions;
    private readonly CancellationTokenSource _watchShutdown = new();
    private readonly CancellationToken _watchStopping;
    private int _disposed;

    public ConnectorService(string dataDirectory, Action? ensureOperationsAllowed = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDirectory);
        _dataDirectory = Path.GetFullPath(dataDirectory);
        _ensureOperationsAllowed = ensureOperationsAllowed;
        _watchStopping = _watchShutdown.Token;
        _sessions = new ConnectionResourcePool<ISession>(32, CreateSessionAsync, session => session.Connected,
            async session =>
            {
                using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await session.CloseAsync(2000, true, closing.Token);
            });
    }

    public async Task<ConnectionTestResult> TestAsync(ConnectionDefinition connection, CancellationToken cancellationToken)
    {
        _ensureOperationsAllowed?.Invoke();
        try
        {
            if (IsOpc(connection))
            {
                await WithSessionAsync(connection, async (session, ct) =>
                {
                    var request = new ReadValueIdCollection { new() { NodeId = VariableIds.Server_ServerStatus_CurrentTime, AttributeId = Attributes.Value } };
                    var response = await session.ReadAsync(null, 0, TimestampsToReturn.Neither, request, ct);
                    if (response.Results.Count != 1 || StatusCode.IsBad(response.Results[0].StatusCode))
                        throw new InvalidOperationException("The OPC UA session could not read the server's current time.");
                    return true;
                }, cancellationToken);
                return new(true, "OPC UA session and server read succeeded with the configured security mode.");
            }
            if (IsSqlite(connection))
            {
                await QuerySqliteAsync(connection, "SELECT 1", [], cancellationToken);
                return new(true, "Managed SQLite connection and read query succeeded.");
            }
            RequireSql(connection);
            await using var client = new SqlConnection(BuildConnectionString(connection));
            await client.OpenAsync(cancellationToken);
            await using var command = new SqlCommand("SELECT 1", client) { CommandTimeout = 10 };
            await command.ExecuteScalarAsync(cancellationToken);
            return new(true, "SQL Server connection and read query succeeded.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception error) when (error is SqlException or ServiceResultException or ArgumentException or InvalidOperationException or TimeoutException or OperationCanceledException)
        {
            return new(false, SafeError(error));
        }
    }

    public async Task<IReadOnlyList<OpcEndpoint>> DiscoverEndpointsAsync(string endpoint, CancellationToken cancellationToken)
    {
        _ensureOperationsAllowed?.Invoke();
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "opc.tcp" || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Supply an opc.tcp endpoint URL without embedded credentials.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        var configuration = await GetConfigurationAsync(timeout.Token);
        using var discovery = await DiscoveryClient.CreateAsync(configuration, uri, ct: timeout.Token);
        var endpoints = await discovery.GetEndpointsAsync(null, timeout.Token);
        return endpoints.Select(item =>
        {
            using var certificate = item.ServerCertificate is { Length: > 0 } ? X509CertificateLoader.LoadCertificate(item.ServerCertificate) : null;
            return new OpcEndpoint(item.EndpointUrl, item.SecurityMode.ToString(), item.SecurityPolicyUri,
                certificate?.GetCertHashString(HashAlgorithmName.SHA256), certificate?.Subject,
                item.UserIdentityTokens.Select(token => token.TokenType.ToString()).Distinct().ToArray());
        }).ToArray();
    }

    public Task<IReadOnlyList<BrowseNode>> BrowseAsync(ConnectionDefinition connection, string? nodeId, CancellationToken cancellationToken)
    {
        _ensureOperationsAllowed?.Invoke();
        var root = string.IsNullOrWhiteSpace(nodeId) ? ObjectIds.ObjectsFolder : NodeId.Parse(nodeId);
        return WithSessionAsync<IReadOnlyList<BrowseNode>>(connection, async (session, ct) =>
        {
            var descriptions = new BrowseDescriptionCollection
            {
                new() { NodeId = root, BrowseDirection = BrowseDirection.Forward,
                    ReferenceTypeId = ReferenceTypeIds.HierarchicalReferences, IncludeSubtypes = true,
                    NodeClassMask = (uint)(NodeClass.Object | NodeClass.Variable), ResultMask = (uint)BrowseResultMask.All }
            };
            var response = await session.BrowseAsync(null, null, 500, descriptions, ct);
            var result = response.Results.Single();
            var nodes = new List<BrowseNode>();
            while (true)
            {
                if (StatusCode.IsBad(result.StatusCode)) throw new ServiceResultException(result.StatusCode);
                foreach (var reference in result.References)
                {
                    // References into another server cannot be read through this session.
                    if (reference.NodeId.ServerIndex != 0) continue;
                    var localId = ExpandedNodeId.ToNodeId(reference.NodeId, session.NamespaceUris);
                    if (localId is null) continue;
                    nodes.Add(new(localId.ToString(), reference.DisplayName.Text ?? reference.BrowseName.Name,
                        reference.NodeClass == NodeClass.Variable));
                    if (nodes.Count > MaximumBrowseNodes)
                        throw new InvalidOperationException($"This folder exceeds {MaximumBrowseNodes:N0} nodes. Browse a narrower folder.");
                }
                if (result.ContinuationPoint is not { Length: > 0 }) break;
                var next = await session.BrowseNextAsync(null, false, new ByteStringCollection { result.ContinuationPoint }, ct);
                result = next.Results.Single();
            }
            return nodes.DistinctBy(x => x.NodeId).OrderBy(x => x.DisplayName, StringComparer.OrdinalIgnoreCase).ToArray();
        }, cancellationToken);
    }

    public Task<IReadOnlyList<ConnectorValue>> ReadAsync(ConnectionDefinition connection, IReadOnlyList<string> nodeIds, CancellationToken cancellationToken)
    {
        _ensureOperationsAllowed?.Invoke();
        ArgumentNullException.ThrowIfNull(nodeIds);
        if (nodeIds.Count > MaximumReadNodes) throw new ArgumentException($"Read at most {MaximumReadNodes} nodes at a time.");
        if (nodeIds.Count == 0) return Task.FromResult<IReadOnlyList<ConnectorValue>>([]);
        var requests = new ReadValueIdCollection(nodeIds.Select(id => new ReadValueId { NodeId = NodeId.Parse(id), AttributeId = Attributes.Value }));
        return WithSessionAsync<IReadOnlyList<ConnectorValue>>(connection, async (session, ct) =>
        {
            var response = await session.ReadAsync(null, 0, TimestampsToReturn.Both, requests, ct);
            if (response.Results.Count != requests.Count) throw new InvalidOperationException("OPC UA returned an incomplete read response.");
            return response.Results.Select((value, i) => ToConnectorValue(nodeIds[i], value)).ToArray();
        }, cancellationToken);
    }

    public async Task<QueryResult> QueryAsync(ConnectionDefinition connection, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken cancellationToken)
    {
        _ensureOperationsAllowed?.Invoke();
        cancellationToken.ThrowIfCancellationRequested();
        ValidateReadParameters(parameters);
        if (IsSqlite(connection)) return await QuerySqliteAsync(connection, sql, parameters, cancellationToken);
        RequireSql(connection);
        SqlQueryGuard.Validate(sql);
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count > 128) throw new ArgumentException("At most 128 query parameters are supported.");
        var stopwatch = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await using var client = new SqlConnection(BuildConnectionString(connection));
            await using var command = new SqlCommand(sql, client) { CommandTimeout = 15 };
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var parameter in parameters)
            {
                var item = BuildParameter(parameter);
                if (!names.Add(item.ParameterName)) throw new ArgumentException("Duplicate SQL parameter names are not supported.");
                command.Parameters.Add(item);
            }
            await client.OpenAsync(timeout.Token);
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleResult, timeout.Token);
            var columns = UniqueColumns(Enumerable.Range(0, reader.FieldCount).Select(reader.GetName));
            var rows = new List<Dictionary<string, object?>>();
            long bytes = 0;
            while (await reader.ReadAsync(timeout.Token))
            {
                if (rows.Count == MaximumQueryRows)
                    throw new InvalidOperationException($"Query exceeds {MaximumQueryRows:N0} rows. Add TOP or a narrower WHERE clause.");
                var row = new Dictionary<string, object?>(StringComparer.Ordinal);
                for (var i = 0; i < columns.Length; i++)
                {
                    if (await reader.IsDBNullAsync(i, timeout.Token)) { row[columns[i]] = null; continue; }
                    var type = reader.GetFieldType(i);
                    if ((type == typeof(string) && reader.GetChars(i, 0, null, 0, 0) > 1_048_576) ||
                        (type == typeof(byte[]) && reader.GetBytes(i, 0, null, 0, 0) > 1_048_576))
                        throw new InvalidOperationException("A query cell exceeds the 1 MiB connector limit.");
                    var value = NormalizeValue(reader.GetValue(i));
                    bytes += value is string text ? text.Length * 2L : 32;
                    if (bytes > 16 * 1_048_576) throw new InvalidOperationException("Query results exceed the 16 MiB connector limit.");
                    row[columns[i]] = value;
                }
                rows.Add(row);
            }
            return new(columns, rows, stopwatch.Elapsed.TotalMilliseconds);
        }
        catch (SqlException) when (timeout.IsCancellationRequested)
        {
            if (cancellationToken.IsCancellationRequested) throw new OperationCanceledException(cancellationToken);
            throw new TimeoutException("SQL query exceeded the 30 second operation limit.");
        }
        catch (SqlException error) { throw new InvalidOperationException(SafeError(error)); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new TimeoutException("SQL query exceeded the 30 second operation limit."); }
    }

    internal static string[] UniqueColumns(IEnumerable<string> columnNames)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return columnNames.Select((name, i) =>
        {
            var basis = string.IsNullOrWhiteSpace(name) ? $"Column{i + 1}" : name;
            var unique = basis;
            for (var suffix = 2; !used.Add(unique); suffix++) unique = $"{basis}_{suffix}";
            return unique;
        }).ToArray();
    }

    internal static SqlParameter BuildParameter(QueryParameter parameter)
    {
        var name = parameter.Name.StartsWith('@') ? parameter.Name : "@" + parameter.Name;
        if (!Regex.IsMatch(name, @"\A@[A-Za-z_][A-Za-z0-9_]{0,127}\z", RegexOptions.CultureInvariant))
            throw new ArgumentException("SQL parameter names must contain only letters, digits, and underscores.");
        var type = parameter.Type.ToLowerInvariant() switch
        {
            "string" or "nvarchar" => SqlDbType.NVarChar, "int" or "int32" or "integer" => SqlDbType.Int,
            "long" or "int64" or "bigint" => SqlDbType.BigInt, "number" or "double" or "float" => SqlDbType.Float,
            "decimal" => SqlDbType.Decimal, "bool" or "boolean" or "bit" => SqlDbType.Bit,
            "date" => SqlDbType.Date, "datetime" or "datetime2" => SqlDbType.DateTime2,
            "datetimeoffset" => SqlDbType.DateTimeOffset, "guid" or "uniqueidentifier" => SqlDbType.UniqueIdentifier,
            _ => throw new ArgumentException("Unsupported SQL parameter type.")
        };
        object? input = parameter.Value;
        if (input is JsonElement json)
            input = json.ValueKind switch { JsonValueKind.Null or JsonValueKind.Undefined => null, JsonValueKind.String => json.GetString(),
                JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.Number => json.GetRawText(),
                _ => throw new ArgumentException("SQL parameter values must be scalar values.") };
        object value = input is null ? DBNull.Value : type switch
        {
            SqlDbType.Int => Convert.ToInt32(input, CultureInfo.InvariantCulture),
            SqlDbType.BigInt => Convert.ToInt64(input, CultureInfo.InvariantCulture),
            SqlDbType.Float => Convert.ToDouble(input, CultureInfo.InvariantCulture),
            SqlDbType.Decimal => Convert.ToDecimal(input, CultureInfo.InvariantCulture),
            SqlDbType.Bit => Convert.ToBoolean(input, CultureInfo.InvariantCulture),
            SqlDbType.Date or SqlDbType.DateTime2 => DateTime.Parse(Convert.ToString(input, CultureInfo.InvariantCulture)!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            SqlDbType.DateTimeOffset => DateTimeOffset.Parse(Convert.ToString(input, CultureInfo.InvariantCulture)!, CultureInfo.InvariantCulture),
            SqlDbType.UniqueIdentifier => Guid.Parse(Convert.ToString(input, CultureInfo.InvariantCulture)!),
            _ => Convert.ToString(input, CultureInfo.InvariantCulture)!
        };
        if (value is string text && text.Length > 1_048_576) throw new ArgumentException("SQL parameter exceeds 1 MiB.");
        if (value is double floating && !double.IsFinite(floating)) throw new ArgumentException("SQL numeric parameters must be finite.");
        var result = new SqlParameter(name, type) { Value = value };
        if (type == SqlDbType.NVarChar) result.Size = -1;
        if (type == SqlDbType.Decimal)
        {
            result.Precision = 38;
            result.Scale = value is decimal number ? (byte)((decimal.GetBits(number)[3] >> 16) & 0x7f) : (byte)18;
        }
        return result;
    }

    internal static string BuildConnectionString(ConnectionDefinition connection, bool readOnly = true)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connection.Server);
        ArgumentException.ThrowIfNullOrWhiteSpace(connection.Database);
        var builder = new SqlConnectionStringBuilder
        {
            DataSource = connection.Server, InitialCatalog = connection.Database,
            Encrypt = SqlConnectionEncryptOption.Mandatory, TrustServerCertificate = connection.TrustServerCertificate,
            ConnectTimeout = 10, ApplicationName = "SparkStudio", PersistSecurityInfo = false,
            ApplicationIntent = readOnly ? ApplicationIntent.ReadOnly : ApplicationIntent.ReadWrite, MultipleActiveResultSets = false,
            IntegratedSecurity = string.IsNullOrWhiteSpace(connection.Username)
        };
        if (!builder.IntegratedSecurity) { builder.UserID = connection.Username; builder.Password = connection.Password ?? ""; }
        return builder.ConnectionString;
    }

    private async Task<T> WithSessionAsync<T>(ConnectionDefinition connection, Func<ISession, CancellationToken, Task<T>> action, CancellationToken cancellationToken)
    {
        if (!IsOpc(connection)) throw new ArgumentException("An opcua connection is required.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try { return await _sessions.RunAsync(connection, action, timeout.Token); }
        catch (ServiceResultException error) { throw new InvalidOperationException(SafeError(error)); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new TimeoutException("OPC UA operation exceeded the 30 second operation limit or the gateway is stopping."); }
    }

    private async Task<ISession> CreateSessionAsync(ConnectionDefinition connection, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(connection.Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "opc.tcp" || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Supply an opc.tcp endpoint URL without embedded credentials.");
        var securityMode = ParseSecurityMode(connection.SecurityMode);
            var configuration = await GetConfigurationAsync(cancellationToken);
            if (!string.IsNullOrWhiteSpace(connection.ServerCertificateSha256))
                configuration = await WithPinnedCertificateAsync(configuration, connection.ServerCertificateSha256, cancellationToken);
            var endpointConfiguration = EndpointConfiguration.Create(configuration);
            endpointConfiguration.OperationTimeout = 10_000;
            using var discovery = await DiscoveryClient.CreateAsync(configuration, uri, endpointConfiguration, ct: cancellationToken);
            var endpoints = await discovery.GetEndpointsAsync(null, cancellationToken);
            var tokenType = string.IsNullOrEmpty(connection.Username) ? UserTokenType.Anonymous : UserTokenType.UserName;
            var endpoint = endpoints.Where(e => e.SecurityMode == securityMode &&
                    Uri.TryCreate(e.EndpointUrl, UriKind.Absolute, out var advertised) && advertised.Scheme == "opc.tcp" &&
                    e.UserIdentityTokens.Any(token => token.TokenType == tokenType) &&
                    (securityMode == MessageSecurityMode.None ? e.SecurityPolicyUri == SecurityPolicies.None : IsModernPolicy(e.SecurityPolicyUri)))
                .OrderByDescending(e => PolicyRank(e.SecurityPolicyUri)).ThenByDescending(e => e.SecurityLevel).FirstOrDefault()
                ?? throw new InvalidOperationException($"Server offers no supported {securityMode} endpoint for {tokenType} authentication. No weaker security fallback was attempted.");
            // Discovery URLs often advertise server-local names; preserve the operator's reachable host and port.
            var endpointUri = new UriBuilder(endpoint.EndpointUrl) { Host = uri.Host, Port = uri.Port };
            endpoint.EndpointUrl = endpointUri.Uri.ToString();
            if (!string.IsNullOrWhiteSpace(connection.ServerCertificateSha256))
            {
                using var offeredCertificate = endpoint.ServerCertificate is { Length: > 0 } ? X509CertificateLoader.LoadCertificate(endpoint.ServerCertificate) : null;
                var pin = connection.ServerCertificateSha256.Replace(":", "").Replace(" ", "");
                if (offeredCertificate is null || !offeredCertificate.GetCertHashString(HashAlgorithmName.SHA256).Equals(pin, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The server certificate does not match this connection's configured SHA-256 fingerprint.");
            }
            IUserIdentity identity = string.IsNullOrEmpty(connection.Username) ? new UserIdentity(new AnonymousIdentityToken()) : new UserIdentity(connection.Username, System.Text.Encoding.UTF8.GetBytes(connection.Password ?? ""));
            if (securityMode == MessageSecurityMode.None && !string.IsNullOrEmpty(connection.Username))
                throw new InvalidOperationException("Username authentication requires Sign or SignAndEncrypt. Anonymous access is supported for explicitly unsecured connections.");
            return await new DefaultSessionFactory(_telemetry).CreateAsync(configuration,
                new ConfiguredEndpoint(null, endpoint, endpointConfiguration), false, true,
                "SparkStudio", 60_000, identity, null, cancellationToken);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _watchShutdown.Cancel();
        _sessions.Dispose();
        _watchShutdown.Dispose();
    }

    internal static ConnectorValue ToConnectorValue(string nodeId, DataValue value)
    {
        var timestamp = value.SourceTimestamp != DateTime.MinValue ? value.SourceTimestamp : value.ServerTimestamp;
        return new ConnectorValue(nodeId, NormalizeValue(value.Value), value.WrappedValue.TypeInfo?.ToString() ?? "Null",
            value.StatusCode.ToString(), timestamp == DateTime.MinValue ? DateTimeOffset.UtcNow : new DateTimeOffset(DateTime.SpecifyKind(timestamp, DateTimeKind.Utc)));
    }

    internal static MessageSecurityMode ParseSecurityMode(string? mode) => mode?.ToLowerInvariant() switch
    {
        null or "" or "signandencrypt" => MessageSecurityMode.SignAndEncrypt,
        "sign" => MessageSecurityMode.Sign, "none" => MessageSecurityMode.None,
        _ => throw new ArgumentException("OPC UA securityMode must be SignAndEncrypt, Sign, or None.")
    };

    private async Task<ApplicationConfiguration> WithPinnedCertificateAsync(ApplicationConfiguration source, string pin, CancellationToken cancellationToken)
    {
        var normalized = pin.Replace(":", "").Replace(" ", "");
        if (!Regex.IsMatch(normalized, "^[0-9A-Fa-f]{64}$", RegexOptions.CultureInvariant))
            throw new ArgumentException("Server certificate pin must be a 64-character SHA-256 fingerprint.");
        // A distinct validator prevents one connection's pinned certificate from authorizing another connection.
        var scoped = new ApplicationConfiguration(_telemetry)
        {
            ApplicationName = source.ApplicationName, ApplicationUri = source.ApplicationUri,
            ProductUri = source.ProductUri, ApplicationType = source.ApplicationType,
            SecurityConfiguration = source.SecurityConfiguration, ClientConfiguration = source.ClientConfiguration,
            TransportQuotas = source.TransportQuotas
        };
        await scoped.ValidateAsync(ApplicationType.Client, cancellationToken);
        scoped.CertificateValidator.CertificateValidation += (_, args) =>
        {
            if (args.Error.StatusCode == StatusCodes.BadCertificateUntrusted &&
                args.Certificate.GetCertHashString(HashAlgorithmName.SHA256).Equals(normalized, StringComparison.OrdinalIgnoreCase))
                args.Accept = true;
        };
        return scoped;
    }

    private async Task<ApplicationConfiguration> GetConfigurationAsync(CancellationToken cancellationToken)
    {
        if (_configuration is not null) return _configuration;
        await _configurationLock.WaitAsync(cancellationToken);
        try
        {
            if (_configuration is not null) return _configuration;
            var pki = Path.Combine(_dataDirectory, "pki");
            var configuration = new ApplicationConfiguration(_telemetry)
            {
                ApplicationName = "SparkStudio", ApplicationUri = $"urn:{System.Net.Dns.GetHostName()}:SparkStudio",
                ProductUri = "urn:sparkstudio:gateway", ApplicationType = ApplicationType.Client,
                SecurityConfiguration = new SecurityConfiguration
                {
                    ApplicationCertificates = new CertificateIdentifierCollection
                    {
                        new() { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "own"),
                            SubjectName = "CN=SparkStudio", CertificateType = ObjectTypeIds.RsaSha256ApplicationCertificateType }
                    },
                    TrustedPeerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "trusted") },
                    TrustedIssuerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "issuers") },
                    RejectedCertificateStore = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "rejected") },
                    AutoAcceptUntrustedCertificates = false, RejectSHA1SignedCertificates = true,
                    MinimumCertificateKeySize = 2048, AddAppCertToTrustedStore = false
                },
                TransportQuotas = new TransportQuotas { OperationTimeout = 10000, MaxMessageSize = 4 * 1024 * 1024, MaxStringLength = 1024 * 1024, MaxByteStringLength = 1024 * 1024, MaxArrayLength = 65536 },
                ClientConfiguration = new ClientConfiguration { DefaultSessionTimeout = 60000 }
            };
            await configuration.ValidateAsync(ApplicationType.Client, cancellationToken);
            var application = new ApplicationInstance(configuration, _telemetry);
            if (!await application.CheckApplicationInstanceCertificatesAsync(true, ct: cancellationToken))
                throw new InvalidOperationException("Could not initialize the SparkStudio OPC UA client certificate.");
            _configuration = configuration;
            return configuration;
        }
        finally { _configurationLock.Release(); }
    }

    private static bool IsModernPolicy(string policy) => PolicyRank(policy) > 0;
    private static int PolicyRank(string policy) => policy switch
    { SecurityPolicies.Aes256_Sha256_RsaPss => 3, SecurityPolicies.Aes128_Sha256_RsaOaep => 2, SecurityPolicies.Basic256Sha256 => 1, _ => 0 };
    private static bool IsOpc(ConnectionDefinition connection) => connection.Type.Equals("opcua", StringComparison.OrdinalIgnoreCase) || connection.Type.Equals("opc-ua", StringComparison.OrdinalIgnoreCase);
    private static void RequireSql(ConnectionDefinition connection)
    {
        if (!connection.Type.Equals("sqlserver", StringComparison.OrdinalIgnoreCase) && !connection.Type.Equals("sql-server", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A sqlserver connection is required.");
    }
    internal static object? NormalizeValue(object? value) => value switch
    {
        null or DBNull => null, byte[] binary => Convert.ToBase64String(binary),
        DateTimeOffset or DateTime or bool or string or Guid or decimal or byte or sbyte or short or ushort or int or uint or long or ulong => value,
        double number => double.IsFinite(number) ? number : number.ToString(CultureInfo.InvariantCulture),
        float number => float.IsFinite(number) ? number : number.ToString(CultureInfo.InvariantCulture),
        LocalizedText text => text.Text, NodeId id => id.ToString(), ExpandedNodeId id => id.ToString(),
        Array array => array.Cast<object?>().Select(NormalizeValue).ToArray(),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture)
    };
    internal static string OpcError(uint code)
    {
        var name = StatusCodes.GetBrowseName(code) ?? "UnknownStatus";
        var advice = code switch
        {
            StatusCodes.BadSecurityChecksFailed => "Verify that the OPC UA server trusts SparkStudio's client certificate (pki/own/certs), that SparkStudio trusts the server certificate, and that the endpoint hostname matches the server certificate. Check the server's rejected-client certificate list.",
            StatusCodes.BadCertificateUntrusted => "Verify the server certificate fingerprint independently, then configure its SHA-256 pin or add its public certificate to pki/trusted/certs.",
            StatusCodes.BadCertificateHostNameInvalid => "The endpoint hostname does not match the server certificate. Use a hostname or IP address present in the server certificate's subject alternative names.",
            StatusCodes.BadCertificateTimeInvalid or StatusCodes.BadCertificateIssuerTimeInvalid => "Check certificate validity dates and both machines' clocks.",
            StatusCodes.BadCertificateUriInvalid => "The server's application URI does not match its certificate. Correct the server certificate/application configuration.",
            StatusCodes.BadIdentityTokenInvalid or StatusCodes.BadIdentityTokenRejected or StatusCodes.BadUserAccessDenied => "Check the configured username/password and the account's OPC UA permissions.",
            _ => "Check endpoint security, network reachability, and certificate trust in the gateway data directory's pki stores."
        };
        return $"OPC UA failed ({name}, 0x{code:X8}). {advice}";
    }

    private static string SafeError(Exception error) => error switch
    {
        SqlException sql => $"SQL Server connection or query failed (error {sql.Number}). Check server reachability, credentials, SELECT permission, and the TLS certificate.",
        ServiceResultException opc => OpcError(opc.StatusCode),
        OperationCanceledException => "Connection operation timed out.",
        _ => error.Message
    };
}
