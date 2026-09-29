namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    /// <summary>Validate declared scalar types before attempting a database connection. Values are never included in errors.</summary>
    public static void ValidateReadParameters(IReadOnlyList<QueryParameter> parameters)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count > 128) throw new ArgumentException("At most 128 query parameters are supported.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var definition in parameters)
        {
            try
            {
                var parameter = BuildParameter(definition);
                if (!names.Add(parameter.ParameterName)) throw new ArgumentException("Duplicate SQL parameter names are not supported.");
            }
            catch (Exception error) when (error is FormatException or OverflowException or InvalidCastException)
            { throw new ArgumentException($"Invalid value for query parameter '{definition.Name}' ({definition.Type}). Check its declared type."); }
        }
    }
}
