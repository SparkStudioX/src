using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed partial class TagEngine
{
    private Dictionary<string, JsonObject> modelContracts = new(StringComparer.Ordinal);
    private long modelAlarmGeneration = -1;
    private AlarmDefinition[] modelAlarmDefinitions = [];

    private TagValue ApplyModelContract(TagValue reading, DateTimeOffset now)
    {
        if (modelContracts.TryGetValue(reading.Path, out var definition)) return ModelFieldContract.Evaluate(definition, reading, now);
        return reading.ModelIssues is null ? reading : reading with { Quality = reading.SourceQuality ?? reading.Quality, SourceQuality = null, ModelIssues = null };
    }

    private void RefreshModelContracts()
    {
        foreach (var path in modelContracts.Keys)
            if (values.TryGetValue(path, out var reading)) SetValue(reading);
    }

    public (long Generation, AlarmDefinition[] Alarms) ModelAlarmConfiguration()
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            var generation = store.TagConfigurationGeneration;
            if (generation != modelAlarmGeneration)
            {
                modelAlarmDefinitions = ModelAlarmTemplates.Expand(store.GetRuntimeTagDefinitions().OfType<JsonObject>());
                modelAlarmGeneration = generation;
            }
            return (modelAlarmGeneration, modelAlarmDefinitions);
        }
    }
}
