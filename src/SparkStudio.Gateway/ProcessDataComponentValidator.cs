using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class ProcessDataComponentValidator
{
    private static readonly string[] HistorySettings = ["historyPaths", "historyMinutes", "historyMaxPoints"];
    public static void Validate(JsonObject project)
    {
        foreach (var component in ProjectTemplates.Components(project))
        {
            if (component["props"] is not JsonObject props) continue;
            var type = ProjectStore.Required(component, "type");
            if (type is "alarmStatusTable" or "alarmJournalTable")
            {
                if (props.ContainsKey("alarmMinimumPriority") && (props["alarmMinimumPriority"] is not JsonValue priority || !priority.TryGetValue<int>(out var value) || value is < 1 or > 4))
                    throw new ArgumentException("Alarm minimum priority must be 1–4.");
            }
            else if (props.ContainsKey("alarmMinimumPriority")) throw new ArgumentException("Alarm priority settings require an alarm component.");
            if (type == "historicalTrend")
            {
                if (props["historyPaths"] is not JsonArray paths || paths.Count is < 1 or > 32 || paths.Any(node => node is not JsonValue text || !text.TryGetValue<string>(out var path) || path.Length > 1024 || !path.StartsWith('[') || !path.Contains(']') || path.Contains('{') || path.Any(char.IsControl)))
                    throw new ArgumentException("A historical trend requires 1–32 fully resolved tag paths.");
                if (paths.Select(node => node!.GetValue<string>()).Distinct(StringComparer.Ordinal).Count() != paths.Count) throw new ArgumentException("Historical trend paths must be unique.");
                foreach (var (key, minimum, maximum) in new[] { ("historyMinutes", 1, 44640), ("historyMaxPoints", 2, 10000) })
                    if (props.ContainsKey(key) && (props[key] is not JsonValue value || !value.TryGetValue<int>(out var number) || number < minimum || number > maximum)) throw new ArgumentException($"{key} is outside its supported range.");
            }
            else if (HistorySettings.Any(props.ContainsKey)) throw new ArgumentException("History settings require a historical trend.");
        }
    }
}
