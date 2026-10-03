using System.Diagnostics;
using System.Text;

namespace SparkStudio.Connectors;

public sealed record SourceMqttScriptTestResult(bool Success, bool Skip, IReadOnlyList<SourceValue> Values,
    IReadOnlyList<SourceDiscoveryItem> Discoveries, string? Error = null, double ElapsedMs = 0,
    string? StructuredUpdates = null);

public static class SourceMqttScriptTester
{
    public static async Task<SourceMqttScriptTestResult> TestAsync(ConnectionDefinition connection, SourceMqttMapping mapping,
        string topic, string payload, bool retained, CancellationToken ct)
    {
        var source = connection.Source ?? throw new ArgumentException("Source settings are required.");
        var utf8 = new UTF8Encoding(false, true);
        if (utf8.GetByteCount(payload) > source.EffectiveLimits.PayloadBytes) throw new ArgumentException("Script sample exceeds the MQTT payload byte cap.");
        if (utf8.GetByteCount(topic) > 65535 || topic.Length == 0 || topic.Contains('+') || topic.Contains('#') || topic.Any(char.IsControl)) throw new ArgumentException("Supply a valid bounded raw MQTT topic.");
        if (!SourceMqttMappingEngine.Matches(mapping.TopicFilter, topic)) throw new ArgumentException("Sample topic does not match the candidate mapping.");
        var points = source.SavedPoints.Where(point => point.MappingId == mapping.Id || point.MappingId is null && point.Address == topic).ToArray();
        var candidate = connection with { Source = source with { Points = points, Mqtt = (source.Mqtt ?? new()) with { Mappings = [mapping] } } };
        SourceConfiguration.Validate("mqtt", candidate.Source);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(Math.Clamp(source.EffectiveLimits.OperationTimeoutMs, 1, 30000));
        var elapsed = Stopwatch.StartNew();
        try
        {
            await using var engine = new SourceMqttMappingEngine(candidate, new(1, points, [mapping]), 1, preview: true);
            await engine.WarmAsync(deadline.Token);
            elapsed.Restart();
            var result = await engine.ProcessAsync(new(topic, utf8.GetBytes(payload), retained, false, 1), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), deadline.Token);
            return new(result.Error is null, result.Skipped, result.Values, result.Discoveries, result.Error, elapsed.Elapsed.TotalMilliseconds, mapping.StructuredUpdates);
        }
        catch (Exception error) when (error is IOException or PlatformNotSupportedException or TimeoutException or OperationCanceledException)
        { if (ct.IsCancellationRequested) throw; return new(false, false, [], [], error.Message, elapsed.Elapsed.TotalMilliseconds, mapping.StructuredUpdates); }
    }
}
