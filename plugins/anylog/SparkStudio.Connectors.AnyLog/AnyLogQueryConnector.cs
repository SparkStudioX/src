using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Connectors.AnyLog;

/// <summary>Reads an AnyLog query node. Users write a SELECT; the REST call sends <c>sql &lt;dbms&gt; format=json …</c> with <c>destination: network</c>.</summary>
public sealed class AnyLogQueryConnector : IDatabaseQueryConnector
{
    private readonly Func<HttpMessageHandler> _handlers;

    public AnyLogQueryConnector() : this(static () => new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(10) }) { }

    internal AnyLogQueryConnector(Func<HttpMessageHandler> handlers) => _handlers = handlers;

    public string Type => "anylog";
    public string DisplayName => "AnyLog query node";
    public string Description => "Query an AnyLog node with SELECT.";
    public bool SupportsUpdates => false;
    public string DefaultSql => "SELECT * FROM your_table LIMIT 100";
    public IReadOnlyList<string> SafeTestFailures { get; } = [AnyLogCommands.UnreachableMessage];
    public IReadOnlyList<DatabaseConnectorField> Fields { get; } =
    [
        new("host", "Query node address", "text", true, "192.168.1.20", Help: "Hostname or IP address. Do not include the port."),
        new("port", "REST port", "port", true, "32349", "32349", "REST port of the query node. 32349 is a common default; use the port configured on the node."),
        new("dbms", "DBMS", "text", true, "aloperator", Help: "Logical database name inserted into sql <dbms>.")
    ];

    public JsonObject Normalize(JsonObject connection) => AnyLogCommands.Normalize(connection);

    public async Task<ConnectionTestResult> TestAsync(IReadOnlyDictionary<string, string> settings, CancellationToken cancellationToken)
    {
        try
        {
            var (host, port, _) = AnyLogCommands.ReadSettings(settings);
            var body = await SendAsync(host, port, "get status", network: false, cancellationToken);
            return string.IsNullOrWhiteSpace(body)
                ? new ConnectionTestResult(false, AnyLogCommands.UnreachableMessage)
                : new ConnectionTestResult(true, "Connection and read check succeeded.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception error) when (error is HttpRequestException or InvalidOperationException or TimeoutException or ArgumentException)
        {
            return new ConnectionTestResult(false, AnyLogCommands.UnreachableMessage);
        }
    }

    public async Task<QueryResult> QueryAsync(IReadOnlyDictionary<string, string> settings, string sql, IReadOnlyList<QueryParameter> parameters, CancellationToken cancellationToken)
    {
        var (host, port, dbms) = AnyLogCommands.ReadSettings(settings);
        var command = AnyLogCommands.Prepare(dbms, sql, parameters);
        var clock = Stopwatch.StartNew();
        var body = await SendAsync(host, port, command, network: true, cancellationToken);
        return AnyLogCommands.Parse(body, clock.Elapsed.TotalMilliseconds);
    }

    private async Task<string> SendAsync(string host, int port, string command, bool network, CancellationToken cancellationToken)
    {
        using var client = new HttpClient(_handlers(), disposeHandler: true) { Timeout = TimeSpan.FromSeconds(30) };
        var address = new UriBuilder(Uri.UriSchemeHttp, host, port) { Path = "/" }.Uri;
        using var request = new HttpRequestMessage(HttpMethod.Get, address);
        request.Headers.TryAddWithoutValidation("User-Agent", "AnyLog/1.23");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/plain"));
        request.Headers.TryAddWithoutValidation("command", AnyLogCommands.ForHeader(command));
        if (network) request.Headers.TryAddWithoutValidation("destination", "network");
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"The AnyLog query node returned HTTP {(int)response.StatusCode}.");
            return await ReadBodyAsync(response.Content, cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("The AnyLog query exceeded the 30 second operation limit.");
        }
        catch (HttpRequestException)
        {
            throw new InvalidOperationException(AnyLogCommands.UnreachableMessage);
        }
    }

    private static async Task<string> ReadBodyAsync(HttpContent content, CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        while (true)
        {
            var count = await stream.ReadAsync(chunk, cancellationToken);
            if (count == 0) break;
            if (buffer.Length + count > AnyLogCommands.MaximumResponseBytes)
                throw new InvalidOperationException("Query results exceed the 16 MiB connector limit.");
            buffer.Write(chunk, 0, count);
        }
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
}
