using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Model alarms are expanded into the existing alarm engine, never a separate notification engine.</summary>
public static class ModelAlarmTemplates
{
    public const string Prefix = "model_";
    public static void Validate(JsonObject field)
    {
        if (!field.ContainsKey("alarms")) return;
        if (TagDefinitionValidator.DataType(field) is "String" or "Boolean") throw new ArgumentException("Alarm templates require numeric fields.");
        if (field["alarms"] is not JsonArray templates || templates.Count > 16 || templates.Any(item => item is not JsonObject))
            throw new ArgumentException("A model field supports at most 16 alarm templates.");
        var alarms = templates.OfType<JsonObject>().Select(item => Parse(item, "[default]ModelValidation/Field", true)).ToArray();
        ProcessDataService.Validate(new(1, 30, alarms, []));
    }

    private static AlarmDefinition Parse(JsonObject template, string path, bool enabled)
    {
        TagModel.Fields(template, "id", "name", "enabled", "mode", "setpoint", "deadband", "priority", "message");
        var id = TagDefinitionValidator.Text(template, "id");
        var name = TagDefinitionValidator.Text(template, "name");
        var mode = TagDefinitionValidator.Text(template, "mode");
        var message = ProjectStore.Optional(template, "message");
        if (message is not null && (message.Length > 2048 || message.Any(char.IsControl))) throw new ArgumentException("Alarm messages must contain at most 2048 characters without control characters.");
        return new(id, name, path, enabled && TagDefinitionValidator.Enabled(template), mode, Number(template, "setpoint"),
            Number(template, "deadband", 0), Integer(template, "priority", 1), message);
    }

    private static double Number(JsonObject value, string field, double? fallback = null)
    {
        if (!value.ContainsKey(field) && fallback is not null) return fallback.Value;
        var scalar = JsonSerializer.SerializeToElement(value[field]);
        if (scalar.ValueKind != JsonValueKind.Number || !scalar.TryGetDouble(out var number) || !double.IsFinite(number))
            throw new ArgumentException($"Alarm {field} must be a finite number.");
        return number;
    }

    private static int Integer(JsonObject value, string field, int fallback)
    {
        if (!value.ContainsKey(field)) return fallback;
        if (value[field] is not JsonValue scalar || !scalar.TryGetValue<int>(out var number)) throw new ArgumentException($"Alarm {field} must be an integer.");
        return number;
    }

    public static AlarmDefinition[] Expand(IEnumerable<JsonObject> definitions)
    {
        var result = new List<AlarmDefinition>();
        foreach (var field in definitions)
        {
            if (field["alarms"] is not JsonArray templates) continue;
            var path = TagDefinitionValidator.Text(field, "path");
            var enabled = field["effectiveEnabled"]?.GetValue<bool>() ?? TagDefinitionValidator.Enabled(field);
            foreach (var template in templates.OfType<JsonObject>())
            {
                var alarm = Parse(template, path, enabled);
                var key = Prefix + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(path + "\n" + alarm.Id)))[..48];
                result.Add(alarm with { Id = key });
            }
        }
        if (result.Count > 2000) throw new ArgumentException("Expanded model alarm templates exceed the gateway limit of 2,000 alarms.");
        return result.ToArray();
    }
}
