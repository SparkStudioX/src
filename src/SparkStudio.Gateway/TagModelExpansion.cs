using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

internal sealed class TagModelExpansion(JsonObject model, Func<JsonObject, JsonObject> normalize, IEnumerable<JsonObject>? externalDefinitions)
{
    private readonly Dictionary<string, JsonObject> groups = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> types = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (int Count, int Height)> shapes = new(StringComparer.Ordinal);
    private readonly HashSet<string> paths = new(StringComparer.Ordinal);
    private readonly JsonArray output = [];
    private bool providerEnabled;
    public JsonArray Expand()
    {
        var directTags = TagModel.Array(model, "tags", TagModel.MaximumTags);
        var instances = TagModel.Array(model, "instances", TagModel.MaximumInstances);
        var hierarchy = model.ContainsKey("hierarchy") ? TagModelMetadata.Hierarchy(model) : new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var provider = Provider();
        ReadGroups(); ReadTypes();
        ModelMappingProfiles.Validate(model);
        foreach (var key in types.Keys) CountLeaves(key, new HashSet<string>(StringComparer.Ordinal));
        foreach (var definition in types.Values) ValidateDefinition(definition);
        var total = directTags.Count;
        foreach (var instance in instances.OfType<JsonObject>()) total = checked(total + shapes[TypeKey(instance)].Count);
        if (total > TagModel.MaximumTags) throw new ArgumentException($"A gateway supports at most {TagModel.MaximumTags} configured tags, including UDT members.");
        var roots = InstanceRoots(instances);
        foreach (var tag in directTags.OfType<JsonObject>())
        {
            var path = TagDefinitionValidator.Text(tag, "path");
            if (Ancestors(path).Any(roots.Contains)) throw new ArgumentException($"Direct tags cannot occupy UDT instance namespace: {path}.");
            Add(tag, true);
        }
        foreach (var instance in instances.OfType<JsonObject>()) ExpandInstance(instance, provider, hierarchy);
        var all = output.OfType<JsonObject>().Concat(externalDefinitions ?? []).ToArray();
        if (all.Length > TagModel.MaximumTags) throw new ArgumentException("Expanded authored/UDT/source definitions exceed 10,000 tags.");
        TagExpressions.Order(all);
        _ = ModelAlarmTemplates.Expand(all);
        return output;
    }
    private static HashSet<string> InstanceRoots(JsonArray instances)
    {
        var roots = new HashSet<string>(StringComparer.Ordinal);
        foreach (var instance in instances.OfType<JsonObject>())
        {
            var path = TagDefinitionValidator.Path(TagDefinitionValidator.Text(instance, "path"));
            if (!roots.Add(path)) throw new ArgumentException($"Overlapping UDT instance path: {path}.");
        }
        foreach (var root in roots)
            if (Ancestors(root).Skip(1).Any(roots.Contains)) throw new ArgumentException($"Overlapping UDT instance path: {root}.");
        return roots;
    }
    private JsonObject Provider()
    {
        if (model["provider"] is not JsonObject provider) throw new ArgumentException("A default provider configuration is required.");
        TagModel.Fields(provider, "name", "enabled", "requireDeclaredHierarchy");
        if (TagDefinitionValidator.Text(provider, "name") != "default") throw new ArgumentException("Only the default provider is supported.");
        providerEnabled = TagDefinitionValidator.Enabled(provider);
        if (provider.ContainsKey("requireDeclaredHierarchy") && (provider["requireDeclaredHierarchy"] is not JsonValue required || !required.TryGetValue<bool>(out _)))
            throw new ArgumentException("requireDeclaredHierarchy must be a Boolean.");
        return provider;
    }
    private void ReadGroups()
    {
        foreach (var group in TagModel.Array(model, "scanGroups", 32).OfType<JsonObject>())
        {
            TagModel.Fields(group, "name", "publishingIntervalMs", "enabled");
            var name = TagModel.Name(group, "name"); TagDefinitionValidator.PublishingInterval(group); TagDefinitionValidator.Enabled(group);
            if (!groups.TryAdd(name, group)) throw new ArgumentException($"Duplicate scan group: {name}.");
        }
    }
    private void ReadTypes()
    {
        foreach (var definition in TagModel.Array(model, "udtDefinitions", TagModel.MaximumDefinitions).OfType<JsonObject>())
        {
            TagModel.Fields(definition, "id", "version", "members", "description", "semanticType", "semanticId", "attributes", "parameters");
            TagModelMetadata.Validate(definition, false); _ = TagModelParameters.Declarations(definition);
            var key = TagModel.DefinitionKey(definition);
            if (!types.TryAdd(key, definition)) throw new ArgumentException($"Duplicate UDT definition: {key}.");
            var members = TagModel.Array(definition, "members", 128);
            if (members.Count == 0) throw new ArgumentException("UDT definitions require at least one member.");
            var memberPaths = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in members.OfType<JsonObject>())
            {
                var memberPath = TagModel.MemberPath(TagDefinitionValidator.Text(member, "path"));
                if (!memberPaths.Add(memberPath)) throw new ArgumentException($"Duplicate UDT member path: {memberPath} in {key}.");
            }
            ValidateMemberNamespaces(memberPaths);
        }
    }
    private static void ValidateMemberNamespaces(HashSet<string> paths)
    {
        foreach (var path in paths)
            if (Ancestors(path).Skip(1).FirstOrDefault(paths.Contains) is string ancestor)
                throw new ArgumentException($"Member {path} overlaps member {ancestor}. A member cannot also be a folder; declare descendants inside a nested type or use separate member paths.");
    }
    private string TypeKey(JsonObject item)
    {
        var key = TagModel.Name(item, "definitionId") + "@" + TagModel.Version(item);
        if (!types.ContainsKey(key)) throw new ArgumentException($"Missing UDT definition: {key}.");
        return key;
    }
    private (int Count, int Height) CountLeaves(string key, HashSet<string> stack)
    {
        if (!stack.Add(key)) throw new ArgumentException($"UDT composition cycle: {key}.");
        if (stack.Count > TagModel.MaximumNestingDepth) throw new ArgumentException("UDT composition nesting is limited to 4 levels.");
        if (shapes.TryGetValue(key, out var cached)) { stack.Remove(key); return cached; }
        var count = 0; var height = 1;
        foreach (var member in types[key]["members"]!.AsArray().OfType<JsonObject>())
        {
            if (TagDefinitionValidator.Kind(member) == "type")
            {
                var nested = CountLeaves(TypeKey(member), stack); count += nested.Count; height = Math.Max(height, nested.Height + 1);
            }
            else count++;
            if (count > TagModel.MaximumTags) throw new ArgumentException("A composed type exceeds the 10,000-tag allowance.");
            if (height > TagModel.MaximumNestingDepth) throw new ArgumentException("UDT composition nesting is limited to 4 levels.");
        }
        stack.Remove(key); shapes[key] = (count, height); return (count, height);
    }
    private void ValidateDefinition(JsonObject definition)
    {
        var declarations = TagModelParameters.Declarations(definition); var names = declarations.Keys;
        foreach (var member in definition["members"]!.AsArray().OfType<JsonObject>())
        {
            if (TagDefinitionValidator.Kind(member) == "type") { ValidateNested(member, declarations); continue; }
            TagModel.ValidateTagFields(member); TagDefinitionValidator.Enabled(member); TagDefinitionValidator.PublishingInterval(member);
            if (member["scanGroup"] is not null && !groups.ContainsKey(TagModel.Name(member, "scanGroup"))) throw new ArgumentException("Missing scan group in UDT definition.");
            if (names.Count > 0) ValidateMemberParameters(member, names);
            ValidateStaticMember(member, names.Count > 0);
        }
        ValidateRelativeShape(definition);
    }
    private static void ValidateMemberParameters(JsonObject member, IEnumerable<string> names)
    {
        foreach (var field in new[] { "connectionId", "nodeId", "target" }) if (member.ContainsKey(field)) ValidateParameterField(member[field], names);
        if (member["inputs"] is JsonObject inputs) foreach (var pair in inputs) ValidateParameterField(pair.Value, names);
        if (!member.ContainsKey("value")) return;
        ValidateParameterField(member["value"], names);
        if (member["value"] is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || !text.Contains('{')) return;
        var placeholders = TagModelParameters.Placeholders(text, names);
        if (placeholders.Length != 1 || text != "{" + placeholders[0] + "}") throw new ArgumentException("A memory value requires a whole-field placeholder.");
    }
    private void ValidateNested(JsonObject member, IReadOnlyDictionary<string, JsonObject> parentParameters)
    {
        TagModel.Fields(member, "path", "kind", "definitionId", "version", "parameters", "enabled");
        TagDefinitionValidator.Enabled(member); var nested = types[TypeKey(member)];
        var declarations = TagModelParameters.Declarations(nested); var supplied = Parameters(member);
        foreach (var pair in supplied)
        {
            if (!declarations.TryGetValue(pair.Key, out var declaration)) throw new ArgumentException($"Unknown nested type parameter: {pair.Key}.");
            ValidateNestedValue(pair.Value, declaration, parentParameters);
        }
        foreach (var pair in declarations)
            if (pair.Value["required"]?.GetValue<bool>() == true && !pair.Value.ContainsKey("default") && !supplied.ContainsKey(pair.Key))
                throw new ArgumentException($"Required nested type parameter is missing: {pair.Key}.");
    }
    private static void ValidateNestedValue(JsonNode? value, JsonObject declaration, IReadOnlyDictionary<string, JsonObject> parentParameters)
    {
        if (value is not JsonValue scalar || !scalar.TryGetValue<string>(out var text)) { TagModelParameters.ValidateValue(declaration, value); return; }
        var placeholders = TagModelParameters.Placeholders(text, parentParameters.Keys);
        if (placeholders.Length == 0) { TagModelParameters.ValidateValue(declaration, value); return; }
        var expected = TagDefinitionValidator.Text(declaration, "type");
        if (placeholders.Length != 1 || text != "{" + placeholders[0] + "}")
        {
            if (expected != "String") throw new ArgumentException("A non-string nested parameter requires a whole-field placeholder.");
            return;
        }
        var supplied = TagDefinitionValidator.Text(parentParameters[placeholders[0]], "type");
        if (supplied != expected && !(supplied == "Int64" && expected == "Double")) throw new ArgumentException("Nested parameter types must match the parent parameter.");
    }
    private static void ValidateParameterField(JsonNode? value, IEnumerable<string> names)
    {
        if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text)) _ = TagModelParameters.Placeholders(text, names);
    }
    private void ValidateStaticMember(JsonObject member, bool parameterized)
    {
        if (!parameterized) { _ = normalize(TagModel.ConcreteMember(member, "[default]UdtValidation")); return; }
        var kind = TagDefinitionValidator.Kind(member);
        if (kind != "opcua" || member.ContainsKey("dataType")) TagDefinitionValidator.DataType(member);
        if (kind == "expression")
        {
            var concrete = (JsonObject)member.DeepClone(); concrete["path"] = "[default]UdtValidation/Member";
            if (concrete["inputs"] is not JsonObject inputs) throw new ArgumentException("Expression inputs must be an object.");
            foreach (var pair in inputs.ToArray()) inputs[pair.Key] = "[default]UdtValidation/Input";
            TagExpressions.Compile(concrete);
        }
        if (kind == "memory")
        {
            if (member["value"] is not JsonValue scalar) throw new ArgumentException("A memory member needs a scalar value.");
            if (!scalar.TryGetValue<string>(out var text) || !text.Contains('{')) _ = TagDefinitionValidator.MemoryValue(TagDefinitionValidator.DataType(member), scalar);
        }
        if (kind is "opcua" or "device") { TagDefinitionValidator.Text(member, "connectionId"); TagDefinitionValidator.Text(member, "nodeId"); TagDefinitionValidator.AbsoluteDeadband(member); TagDefinitionValidator.MonitorQueueSize(member); }
        if (kind == "reference") TagDefinitionValidator.Text(member, "target");
    }
    private void ValidateRelativeShape(JsonObject definition)
    {
        var dependencies = new Dictionary<string, string[]>(StringComparer.Ordinal);
        var leaves = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        void Visit(JsonObject current, string prefix)
        {
            foreach (var member in current["members"]!.AsArray().OfType<JsonObject>())
            {
                var path = prefix + TagDefinitionValidator.Text(member, "path");
                if (TagDefinitionValidator.Kind(member) == "type") { Visit(types[TypeKey(member)], path + "/"); continue; }
                var inputs = member["inputs"] as JsonObject;
                var targets = inputs?.Select(input => input.Value?.GetValue<string>() ?? "").ToArray() ?? (member["target"] is JsonValue target ? [target.GetValue<string>()] : []);
                if (!dependencies.TryAdd(path, targets.Where(target => target.StartsWith("./", StringComparison.Ordinal) && !target.Contains('{')).Select(target => prefix + target[2..]).ToArray()))
                    throw new ArgumentException("Composed UDT members have duplicate paths.");
                leaves[path] = member;
            }
        }
        Visit(definition, "");
        foreach (var pair in dependencies)
        {
            if (Ancestors(pair.Key).Skip(1).Any(dependencies.ContainsKey)) throw new ArgumentException("A UDT leaf cannot contain nested member paths.");
            foreach (var target in pair.Value) if (!dependencies.ContainsKey(target)) throw new ArgumentException($"Missing relative UDT member input: {target}.");
            if (TagDefinitionValidator.Kind(leaves[pair.Key]) == "reference" && pair.Value.Length == 1
                && leaves[pair.Key]["dataType"]?.GetValue<string>() != leaves[pair.Value[0]]["dataType"]?.GetValue<string>())
                throw new ArgumentException("Reference member dataType must exactly match its relative target.");
        }
        var stack = new HashSet<string>(StringComparer.Ordinal); var heights = new Dictionary<string, int>(StringComparer.Ordinal);
        int Check(string path)
        {
            if (!stack.Add(path)) throw new ArgumentException("Expression/reference dependency cycle in UDT definition.");
            if (stack.Count > 64 && TagDefinitionValidator.Kind(leaves[path]) is "expression" or "reference") throw new ArgumentException("Expression/reference dependency chains are limited to 64 tags.");
            if (heights.TryGetValue(path, out var height)) { stack.Remove(path); return height; }
            height = TagDefinitionValidator.Kind(leaves[path]) is "expression" or "reference" ? 1 : 0;
            foreach (var dependency in dependencies[path]) height = Math.Max(height, 1 + Check(dependency));
            if (height > 64) throw new ArgumentException("Expression/reference dependency chains are limited to 64 tags.");
            stack.Remove(path); heights[path] = height; return height;
        }
        foreach (var path in dependencies.Keys) Check(path);
    }
    private void ExpandInstance(JsonObject instance, JsonObject provider, Dictionary<string, JsonObject> hierarchy)
    {
        TagModel.Fields(instance, "path", "definitionId", "version", "enabled", "parameters", "overrides", "mappingProfileId");
        var root = TagDefinitionValidator.Path(TagDefinitionValidator.Text(instance, "path"));
        if (provider["requireDeclaredHierarchy"]?.GetValue<bool>() == true && !Ancestors(root).Skip(1).Any(hierarchy.ContainsKey))
            throw new ArgumentException($"Instance {root} must be under a declared hierarchy node.");
        var overrides = !instance.ContainsKey("overrides") ? new JsonObject()
            : instance["overrides"] as JsonObject ?? throw new ArgumentException("Instance overrides must be an object keyed by member path.");
        var usedOverrides = new HashSet<string>(StringComparer.Ordinal); var definition = types[TypeKey(instance)];
        ExpandType(definition, root, "", TagModelParameters.Bind(definition, Parameters(instance)), instance, overrides, usedOverrides, TagDefinitionValidator.Enabled(instance));
        foreach (var pair in overrides) if (!usedOverrides.Contains(pair.Key)) throw new ArgumentException($"Override references removed or missing member: {root}/{pair.Key}.");
    }
    private void ExpandType(JsonObject definition, string root, string prefix, TagModelParameters.Binding binding, JsonObject instance, JsonObject overrides, HashSet<string> usedOverrides, bool enabled)
    {
        foreach (var member in definition["members"]!.AsArray().OfType<JsonObject>())
        {
            var memberPath = TagDefinitionValidator.Text(member, "path"); var modelPath = prefix + memberPath;
            if (TagDefinitionValidator.Kind(member) == "type")
            {
                var parameters = new JsonObject(); var inheritedDefaults = new HashSet<string>(StringComparer.Ordinal);
                foreach (var pair in Parameters(member))
                {
                    var whole = pair.Value is JsonValue scalar && scalar.TryGetValue<string>(out var text) && text.StartsWith('{') && text.EndsWith('}') && text.Count(character => character == '{') == 1;
                    parameters[pair.Key] = TagModelParameters.Substitute(pair.Value, binding, whole, out var source);
                    if (source == "parameter-default") inheritedDefaults.Add(pair.Key);
                }
                var nested = types[TypeKey(member)];
                var nestedBinding = TagModelParameters.Bind(nested, parameters); nestedBinding.Defaults.UnionWith(inheritedDefaults);
                ExpandType(nested, root + "/" + memberPath, modelPath + "/", nestedBinding, instance, overrides, usedOverrides, enabled && TagDefinitionValidator.Enabled(member));
                continue;
            }
            ExpandMember(member, root, modelPath, binding, instance, overrides, usedOverrides, enabled);
        }
    }
    private void ExpandMember(JsonObject member, string root, string modelPath, TagModelParameters.Binding binding, JsonObject instance, JsonObject overrides, HashSet<string> usedOverrides, bool enabled)
    {
        var authored = ModelMappingProfiles.Resolve(model, instance, modelPath, member); var provenance = new JsonObject(); var fields = System.Array.Empty<string>();
        var mapped = authored.Where(pair => !JsonNode.DeepEquals(pair.Value, member[pair.Key])).Select(pair => pair.Key).ToArray();
        if (overrides.TryGetPropertyValue(modelPath, out var patch))
        {
            if (patch is not JsonObject edits) throw new ArgumentException("Member overrides must be objects.");
            TagModel.Fields(edits, "value", "enabled", "publishingIntervalMs", "scanGroup", "connectionId", "nodeId", "absoluteDeadband", "queueSize", "expression", "inputs", "target", "unit", "unitSystem", "description", "range", "freshnessMs", "enumValues", "semanticType", "semanticId", "attributes", "alarms");
            fields = edits.Select(pair => pair.Key).ToArray(); usedOverrides.Add(modelPath);
            foreach (var pair in edits) authored[pair.Key] = pair.Value?.DeepClone();
        }
        ResolveMember(authored, binding, fields, provenance);
        foreach (var field in mapped.Where(field => !fields.Contains(field, StringComparer.Ordinal))) provenance[field] = "mapping-profile";
        var tag = Add(TagModel.ConcreteMember(authored, root), enabled);
        tag["udtInstance"] = instance["path"]!.DeepClone(); tag["udtDefinition"] = instance["definitionId"]!.DeepClone(); tag["udtVersion"] = instance["version"]!.DeepClone();
        tag["udtMember"] = modelPath; tag["modelPath"] = modelPath; tag["fieldProvenance"] = provenance;
        tag["overrideFields"] = new JsonArray(fields.Select(field => (JsonNode?)JsonValue.Create(field)).ToArray());
    }
    private static void ResolveMember(JsonObject member, TagModelParameters.Binding binding, string[] overrides, JsonObject provenance)
    {
        foreach (var pair in member) provenance[pair.Key] = overrides.Contains(pair.Key, StringComparer.Ordinal) ? "override" : "definition";
        foreach (var field in new[] { "connectionId", "nodeId", "target", "value" })
        {
            if (!member.ContainsKey(field) || field == "value" && !binding.HasDeclarations) continue;
            member[field] = TagModelParameters.Substitute(member[field], binding, field == "value", out var source);
            if (field == "value") member[field] = TagModelParameters.Memory(TagDefinitionValidator.DataType(member), member[field]);
            if (!overrides.Contains(field, StringComparer.Ordinal)) provenance[field] = source;
        }
        if (member["inputs"] is not JsonObject inputs) return;
        foreach (var pair in inputs.ToArray())
        {
            inputs[pair.Key] = TagModelParameters.Substitute(pair.Value, binding, false, out var source);
            provenance["inputs." + pair.Key] = overrides.Contains("inputs", StringComparer.Ordinal) ? "override" : source;
        }
    }
    private JsonObject Add(JsonObject authored, bool instanceEnabled)
    {
        TagModel.ValidateTagFields(authored);
        var tag = normalize(authored); var path = TagDefinitionValidator.Text(tag, "path");
        if (!paths.Add(path)) throw new ArgumentException($"Tag or UDT member path conflict: {path}.");
        var enabled = providerEnabled && instanceEnabled && TagDefinitionValidator.Enabled(tag);
        if (tag["scanGroup"] is not null)
        {
            var name = TagModel.Name(tag, "scanGroup");
            if (!groups.TryGetValue(name, out var group)) throw new ArgumentException($"Missing scan group: {name} (used by {path}).");
            tag["publishingIntervalMs"] = TagDefinitionValidator.PublishingInterval(group); enabled &= TagDefinitionValidator.Enabled(group);
        }
        tag["effectiveEnabled"] = enabled; output.Add(tag); return tag;
    }
    private static JsonObject Parameters(JsonObject item) => !item.ContainsKey("parameters") ? new() : item["parameters"] as JsonObject ?? throw new ArgumentException("Instance/nested parameters must be an object.");
    private static IEnumerable<string> Ancestors(string path)
    {
        yield return path;
        while (path.LastIndexOf('/') is var slash && slash >= 0) { path = path[..slash]; yield return path; }
    }
}
