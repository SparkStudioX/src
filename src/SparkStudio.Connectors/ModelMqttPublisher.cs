namespace SparkStudio.Connectors;

/// <summary>Sequential outbound MQTT publications over the existing bounded, certificate-validating transport.</summary>
public sealed class ModelMqttPublisher : IAsyncDisposable
{
    private readonly SourceMqttWire wire;
    private ModelMqttPublisher(SourceMqttWire wire) => this.wire = wire;
    public static async Task<ModelMqttPublisher> ConnectAsync(string endpoint, string clientId, string? username,
        string? password, string dataDirectory, CancellationToken cancellation)
    {
        var uri = new Uri(endpoint);
        if (uri.Scheme is not ("mqtt" or "mqtts")) throw new ArgumentException("Use mqtt:// or mqtts:// for model publishing.");
        var source = new SourceSettings(endpoint, Authentication: new(username is null ? "none" : "username", username, password),
            Mqtt: new("3.1.1", uri.Scheme == "mqtts" ? "tls" : "tcp", clientId));
        var wire = await SourceMqttWire.ConnectAsync(new(clientId, "Model publisher", "mqtt", Source: source), dataDirectory, cancellation);
        wire.Start(_ => false, (_, _) => { });
        return new(wire);
    }
    public Task PublishAsync(string topic, ReadOnlyMemory<byte> payload, int qos, bool retain, CancellationToken cancellation)
        => wire.PublishAsync(topic, payload, qos, retain, cancellation);
    public ValueTask DisposeAsync() => wire.DisposeAsync();
}
