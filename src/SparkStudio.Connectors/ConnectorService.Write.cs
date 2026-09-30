using System.Text.Json;
using Opc.Ua;

namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    /// <summary>One explicit OPC UA write. Never retried; a transport failure may have changed the device.</summary>
    public Task<string> WriteValueAsync(ConnectionDefinition connection, string nodeId, string dataType, JsonElement value, CancellationToken cancellationToken, Action? beforeDispatch = null)
    {
        _ensureOperationsAllowed?.Invoke();
        object typed = dataType switch
        {
            "Boolean" => value.GetBoolean(), "Int16" => value.GetInt16(), "Int32" => value.GetInt32(),
            "Int64" => value.GetInt64(), "Float" => value.GetSingle(), "Double" => value.GetDouble(),
            "String" => value.GetString() ?? throw new ArgumentException("A write cannot contain null text."),
            _ => throw new ArgumentException("Unsupported scalar write type.")
        };
        if (typed is float single && !float.IsFinite(single) || typed is double number && !double.IsFinite(number)) throw new ArgumentException("Write values must be finite.");
        return WithSessionAsync(connection, async (session, ct) =>
        {
            var values = new WriteValueCollection { new() { NodeId = NodeId.Parse(nodeId), AttributeId = Attributes.Value, Value = new DataValue(new Variant(typed)) } };
            ct.ThrowIfCancellationRequested();
            beforeDispatch?.Invoke();
            var response = await session.WriteAsync(null, values, ct);
            if (response.Results.Count != 1) throw new InvalidOperationException("The server returned an incomplete write response; the outcome is uncertain.");
            return response.Results[0].ToString();
        }, cancellationToken);
    }
}
