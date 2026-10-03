using System.Diagnostics;
using System.Text.Json.Serialization;

namespace SparkStudio.Connectors;

public enum SourceValueAction { Replace, Retain, Clear }
public sealed record SourceSettings(string Endpoint, string Acquisition = "poll", int IntervalMs = 1000,
    SourcePoint[]? Points = null, SourceAuthentication? Authentication = null, SourceTlsSettings? Tls = null,
    SourceLimits? Limits = null, SourceMtConnectSettings? MtConnect = null,
    SourceI3xSettings? I3x = null, SourceMqttSettings? Mqtt = null)
{
    [JsonIgnore] public SourcePoint[] SavedPoints => Points ?? [];
    [JsonIgnore] public SourceLimits EffectiveLimits => Limits ?? new();
}
public sealed record SourceAuthentication(string Mode = "none", string? Username = null,
    string? Password = null, string? Token = null, string Header = "X-API-Key");
public sealed record SourceTlsSettings(string? CaCertificateReference = null,
    string? ClientCertificateReference = null, string? ClientKeyReference = null,
    string? ServerCertificateSha256 = null);
public sealed record SourcePoint(string Id, string Name, string Address, string DataType = "String",
    string? Selector = null, bool Writable = false, string? MappingId = null, string? SuggestedPath = null);
public sealed record SourceMtConnectSettings(string? Device = null, string? Path = null,
    int HeartbeatMs = 10000, int Count = 1000, string UserAgent = "SparkStudio/1.0");
public sealed record SourceI3xSettings(bool PreferStream = true, int MaxDepth = 1,
    int ReconciliationSeconds = 30, string? ClientId = null);
public sealed record SourceMqttSettings(string ProtocolVersion = "5", string Transport = "tcp",
    string? ClientId = null, int KeepAliveSeconds = 30, bool CleanStart = true,
    int SessionExpirySeconds = 0, SourceMqttMapping[]? Mappings = null);
public sealed record SourceMqttMapping(string Id, string TopicFilter, string Root,
    string Tags = "review", string Payload = "scalar", string? Script = null,
    string? TimestampExpression = null, string? DataType = null, int Qos = 0,
    string Retained = "uncertain", int StaleAfterMs = 0, int StripLevels = 0,
    string StructuredUpdates = "snapshot", bool Enabled = true, int MaximumTags = 10000,
    int PruneAfterSeconds = 0, string Ordering = "receipt", string? SequenceExpression = null,
    string? EpochExpression = null, string Shape = "scalar");
public sealed record SourceLimits(int DocumentBytes = 1024 * 1024, int ValueBytes = 64 * 1024,
    int StateBytes = 16 * 1024 * 1024, int QueueBytes = 8 * 1024 * 1024, int QueueCount = 4096,
    int PacketBytes = 272 * 1024, int PayloadBytes = 256 * 1024, int CatalogCount = 10000,
    int CatalogBytes = 8 * 1024 * 1024, int RequestTimeoutMs = 2000, int OperationTimeoutMs = 10000,
    int ConnectTimeoutMs = 5000, int DecodeNodes = 65536, int DecodeBytes = 32 * 1024 * 1024,
    int ScriptTimeoutMs = 100, int ScriptResultBytes = 256 * 1024, int ScriptResultDepth = 16,
    int ScriptResultMembers = 4096, int ScriptResultLeaves = 1024, int WorkerCount = 2);
public sealed record SourceCapabilities(string Driver, string[] AcquisitionModes, string BrowseOrigin,
    bool CachedReads = false, int MaximumReadBatch = 256, bool CanWrite = false,
    string[]? SupportedRepresentations = null);
public sealed record SourceTestResult(bool Success, string Message, SourceCapabilities Capabilities,
    string? Version = null, IReadOnlyDictionary<string, object?>? Details = null);
public sealed record SourceBrowseRequest(string? Parent = null, int PageSize = 100,
    string? ContinuationToken = null, long Generation = 0, long BindingRevision = 0);
public sealed record SourceBrowseEntry(string Address, string Name, bool IsVariable,
    string? DataType = null, string? Selector = null, string? Parent = null,
    IReadOnlyDictionary<string, object?>? Metadata = null, string? MappingId = null,
    string? SuggestedPath = null);
public sealed record SourceBrowsePage(IReadOnlyList<SourceBrowseEntry> Entries,
    string? ContinuationToken = null, bool Truncated = false, long Generation = 0,
    long BindingRevision = 0);
public sealed record SourceReadRequest(IReadOnlyList<SourcePoint> Points,
    long Generation = 0, long BindingRevision = 0);
public sealed record SourceReadBatch(IReadOnlyList<SourceValue> Values);
public sealed record SourceBindingRevision(long Revision, IReadOnlyList<SourcePoint> Points,
    IReadOnlyList<SourceMqttMapping>? Mappings = null);
public sealed record SourceMonitorRequest(long Generation, SourceBindingRevision Bindings);
public sealed record SourceValue(string PointId, object? Value, string DataType, string Quality,
    DateTimeOffset? SourceTimestamp = null, DateTimeOffset? ReceiptTimestamp = null,
    SourceValueAction Action = SourceValueAction.Replace, string? NativeStatus = null,
    long Generation = 0, long BindingRevision = 0, string? Epoch = null,
    ulong? Sequence = null, long IngressOrdinal = 0, bool Retained = false,
    long MonotonicReceipt = 0)
{
    public ConnectorValue ToConnectorValue() => new(PointId, Value, DataType, Quality,
        SourceTimestamp ?? ReceiptTimestamp ?? DateTimeOffset.UtcNow, Action, ReceiptTimestamp, NativeStatus);
    public static SourceValue NoData(SourcePoint point, long generation = 0, long revision = 0) =>
        new(point.Id, null, point.DataType, "Bad_NoData", ReceiptTimestamp: DateTimeOffset.UtcNow,
            Action: SourceValueAction.Clear, Generation: generation, BindingRevision: revision,
            MonotonicReceipt: Stopwatch.GetTimestamp());
}
public sealed record SourceStatus(string State, string? Message = null, long Generation = 0,
    long BindingRevision = 0, string? Reason = null, string? NativeStatus = null,
    long LostUpdates = 0, IReadOnlyDictionary<string, object?>? Diagnostics = null);
public sealed record SourceDiscoveryItem(string MappingId, string Address, string? Selector,
    string Name, string DataType, string SuggestedPath, object? Value = null,
    string Quality = "Good", DateTimeOffset? SourceTimestamp = null, bool Retained = false,
    string Shape = "scalar");
public sealed record SourceDiscoveryBatch(IReadOnlyList<SourceDiscoveryItem> Items,
    long Generation, long BindingRevision);
public sealed record SourcePublication(IReadOnlyList<SourceValue> Values, IReadOnlyList<SourceDiscoveryItem> Discoveries,
    long Generation, long BindingRevision)
{
    // The owner adds a transport fence; the gateway evaluates it under its commit lock.
    [JsonIgnore] public Func<bool>? CanCommit { get; init; }
}
public interface ISourceSink
{
    void OnValues(IReadOnlyList<SourceValue> values);
    void OnStatus(SourceStatus status);
    void OnDiscovery(SourceDiscoveryBatch discovery);
    ValueTask<bool> OnPublicationAsync(SourcePublication publication, CancellationToken ct) {
        ct.ThrowIfCancellationRequested();
        if (publication.Discoveries.Count > 0) OnDiscovery(new(publication.Discoveries, publication.Generation, publication.BindingRevision));
        if (publication.Values.Count > 0) OnValues(publication.Values);
        return ValueTask.FromResult(true);
    }
}
public interface ISourceSession : IAsyncDisposable
{
    SourceCapabilities Capabilities { get; }
    Task<SourceTestResult> TestAsync(CancellationToken ct);
    Task<SourceBrowsePage> BrowseAsync(SourceBrowseRequest request, CancellationToken ct);
    Task<SourceReadBatch> ReadAsync(SourceReadRequest request, CancellationToken ct);
    Task<ISourceMonitor> StartMonitoringAsync(SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime);
}
public interface ISourceMonitor : IAsyncDisposable
{
    Task UpdateBindingsAsync(SourceBindingRevision revision, CancellationToken ct);
}
