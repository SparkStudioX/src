using System.Collections;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.XPath;
using Scriban;
using Scriban.Parsing;
using Scriban.Runtime;
using SparkStudio.Connectors;

// No user script runs until the supervisor assigns the process to a hard memory boundary
// and sends a request. stdout is exclusively framed IPC, never script output.
var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
if (args.Contains("--fixture-startup-hang")) Thread.Sleep(Timeout.Infinite);
Evaluate(new("{\"value\":1}", "warm", false, DateTimeOffset.UtcNow.ToString("O"), "(json payload).value"));
Evaluate(new("<root><value>1</value></root>", "warm", false, DateTimeOffset.UtcNow.ToString("O"), "xml.xpath payload \"/root/value\" | string.to_double"));
await SourceScriptProtocol.WriteAsync(output, "ready", CancellationToken.None);
while (true)
{
    SourceScriptRequest request;
    try { request = await SourceScriptProtocol.ReadAsync<SourceScriptRequest>(input, CancellationToken.None); }
    catch (EndOfStreamException) { break; }
    SourceScriptResponse response;
    try
    {
        // Only the connector test assembly can request these launcher arguments; user scripts
        // cannot enter them. They independently exercise supervisor kill and allocation caps.
        if (args.Contains("--fixture-hang")) Thread.Sleep(Timeout.Infinite);
        if (args.Contains("--fixture-memory")) { var allocations = new List<byte[]>(); while (true) { var allocation = new byte[1024 * 1024]; Array.Fill(allocation, (byte)1); allocations.Add(allocation); } }
        if (args.Contains("--fixture-oom")) { var overCap = new byte[256 * 1024 * 1024]; Array.Fill(overCap, (byte)1); GC.KeepAlive(overCap); }
        response = Evaluate(request);
    }
    catch (Exception error) when (error is not OutOfMemoryException)
    { response = new(false, Error: error.Message.Length > 1024 ? error.Message[..1024] : error.Message); }
    await SourceScriptProtocol.WriteAsync(output, response, CancellationToken.None);
}

static SourceScriptResponse Evaluate(SourceScriptRequest request)
{
    if (Encoding.UTF8.GetByteCount(request.Payload) > 256 * 1024 || request.Script.Length > 64 * 1024)
        throw new InvalidDataException("Script input exceeds its limit.");
    var globals = new ScriptObject();
    globals.SetValue("payload", request.Payload, true); globals.SetValue("topic", request.Topic, true);
    globals.SetValue("retained", request.Retained, true); globals.SetValue("received", request.Received, true);
    var levels = new ScriptArray(); foreach (var level in request.Topic.Split('/')) levels.Add(level); globals.SetValue("levels", levels, true);
    globals.Import("json", new Func<string, object?>(payload => ParseJson(payload, request)));
    var xml = new ScriptObject(); xml.Import("xpath", new Func<string, string, string>( (payload, xpath) => XPath(payload, xpath, request))); globals.SetValue("xml", xml, true);
    // Only the documented string namespace is exposed. No loader, include, environment,
    // reflection, arbitrary CLR model, object import, filesystem or network objects exist.
    var standard = new TemplateContext(); var builtins = new ScriptObject();
    builtins.SetValue("string", standard.BuiltinObject["string"], true);
    using var cancellation = new CancellationTokenSource(90);
    var context = new TemplateContext(builtins)
    {
        StrictVariables = true, EnableRelaxedMemberAccess = false, EnableRelaxedIndexerAccess = false,
        EnableRelaxedTargetAccess = false, EnableRelaxedFunctionAccess = false, TemplateLoader = null,
        MemberFilter = _ => false, LoopLimit = 10000, RecursiveLimit = 32, ObjectRecursionLimit = 16,
        LimitToString = 64 * 1024, OutputLimit = 256 * 1024,
        OnStringLimit = ScriptLimitBehavior.Throw, OnOutputLimit = ScriptLimitBehavior.Throw,
        RegexTimeOut = TimeSpan.FromMilliseconds(50), CancellationToken = cancellation.Token
    };
    context.PushGlobal(globals);
    object? Run(string script)
    {
        if (script.Length > 64 * 1024) throw new InvalidDataException("Expression exceeds its limit.");
        var template = Template.Parse(script, parserOptions: new ParserOptions { ExpressionDepthLimit = 64 }, lexerOptions: new LexerOptions { Mode = ScriptMode.ScriptOnly });
        if (template.HasErrors) throw new InvalidDataException("Invalid extraction script: " + string.Join("; ", template.Messages));
        return template.Evaluate(context);
    }
    var result = Run(request.Script);
    var state = new ResultBudget(request);
    var typed = state.Convert(result, 0);
    if (typed is null && !request.MetadataOnly) return new(true, Skip: true);
    var bytes = JsonSerializer.SerializeToUtf8Bytes(typed);
    if (bytes.Length > Math.Min(request.ResultBytes, 256 * 1024)) throw new InvalidDataException("Script result exceeds its byte limit.");
    using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 64 });
    string? timestamp = null; ulong? sequence = null; string? epoch = null;
    if (!string.IsNullOrWhiteSpace(request.TimestampExpression))
    {
        var value = Run(request.TimestampExpression);
        if (value is not string text || !DateTimeOffset.TryParseExact(text,
            WorkerDateFormats.Utc, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed) || parsed.Offset != TimeSpan.Zero)
            throw new InvalidDataException("Timestamp expression must return a valid UTC ISO-8601 timestamp.");
        timestamp = parsed.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
    }
    if (!string.IsNullOrWhiteSpace(request.SequenceExpression))
    {
        var value = Run(request.SequenceExpression);
        if (request.OrderByTimestamp)
        {
            if (value is not string text || !DateTimeOffset.TryParseExact(text, WorkerDateFormats.Utc, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)) throw new InvalidDataException("Ordering timestamp must be UTC ISO-8601.");
            sequence = (ulong)parsed.UtcTicks;
        }
        else sequence = value switch { int n when n >= 0 => (ulong)n, long n when n >= 0 => (ulong)n, uint n => n, ulong n => n, string text when ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var n) => n, _ => throw new InvalidDataException("Sequence expression must return a nonnegative exact integer.") };
    }
    if (!string.IsNullOrWhiteSpace(request.EpochExpression))
    {
        var value = Run(request.EpochExpression);
        epoch = value switch { string text when text.Length <= 1024 => text, int n => n.ToString(CultureInfo.InvariantCulture), long n => n.ToString(CultureInfo.InvariantCulture), _ => throw new InvalidDataException("Epoch expression must return a bounded string or integer.") };
    }
    return new(true, typed is null ? null : document.RootElement.Clone(), Timestamp: timestamp, Sequence: sequence, Epoch: epoch, Skip: typed is null);
}

static object? ParseJson(string payload, SourceScriptRequest request)
{
    if (Encoding.UTF8.GetByteCount(payload) > 256 * 1024) throw new InvalidDataException("JSON input exceeds its byte limit.");
    using var document = JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 64 });
    var nodes = 0; long tracked = Encoding.UTF8.GetByteCount(payload);
    object? Convert(JsonElement element, int depth)
    {
        if (depth > 64 || ++nodes > Math.Min(request.DecodeNodes, 65536)) throw new InvalidDataException("JSON node/depth limit exceeded.");
        // Reserve conservative node/string overhead before materializing the ScriptObject graph.
        tracked += 256 + element.GetRawText().Length * 2L;
        if (tracked > Math.Min(request.DecodeBytes, 32 * 1024 * 1024)) throw new InvalidDataException("JSON temporary budget exceeded.");
        if (element.ValueKind == JsonValueKind.Object)
        {
            var result = new ScriptObject();
            foreach (var property in element.EnumerateObject()) { if (result.ContainsKey(property.Name)) throw new InvalidDataException("Duplicate JSON property."); result.SetValue(property.Name, Convert(property.Value, depth + 1), true); }
            return result;
        }
        if (element.ValueKind == JsonValueKind.Array) { var result = new ScriptArray(); foreach (var child in element.EnumerateArray()) result.Add(Convert(child, depth + 1)); return result; }
        return SourceScriptProtocol.Scalar(element);
    }
    return Convert(document.RootElement, 0);
}

static string XPath(string payload, string expression, SourceScriptRequest request)
{
    if (Encoding.UTF8.GetByteCount(payload) > 256 * 1024 || expression.Length > 4096) throw new InvalidDataException("XML or XPath input exceeds its limit.");
    var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 256 * 1024, MaxCharactersFromEntities = 0 };
    // Preflight nodes/depth before XPathDocument materializes its index. XPath runs in the
    // killable worker; its native traversal is covered by the supervisor's whole-call deadline.
    using (var reader = XmlReader.Create(new StringReader(payload), settings))
    {
        var nodes = 0; long tracked = payload.Length * 2L;
        while (reader.Read()) { if (reader.Depth > 64 || ++nodes > Math.Min(request.DecodeNodes, 65536)) throw new InvalidDataException("XML node/depth limit exceeded."); tracked += 256 + (reader.HasValue ? reader.Value.Length * 2L : 0); if (tracked > Math.Min(request.DecodeBytes, 32 * 1024 * 1024)) throw new InvalidDataException("XML temporary budget exceeded."); }
    }
    using var source = XmlReader.Create(new StringReader(payload), settings);
    var navigator = new XPathDocument(source).CreateNavigator(); var evaluated = navigator.Evaluate(expression);
    string value;
    if (evaluated is XPathNodeIterator matches) { if (!matches.MoveNext()) throw new InvalidDataException("XPath did not select a node."); value = matches.Current!.Value; }
    else value = evaluated switch { bool flag => flag ? "true" : "false", double number when double.IsFinite(number) => number.ToString("R", CultureInfo.InvariantCulture), string text => text, _ => throw new InvalidDataException("Unsupported XPath result.") };
    if (Encoding.UTF8.GetByteCount(value) > Math.Min(request.ValueBytes, 64 * 1024)) throw new InvalidDataException("XPath result exceeds its scalar byte limit."); return value;
}

sealed class ResultBudget(SourceScriptRequest request)
{
    private int members; private int leaves; private long tracked;
    private readonly HashSet<object> active = new(ReferenceEqualityComparer.Instance);
    public object? Convert(object? value, int depth)
    {
        if (depth > Math.Min(request.ResultDepth, 16) || ++members > Math.Min(request.ResultMembers, 4096)) throw new InvalidDataException("Result depth/member limit exceeded.");
        tracked += 64; if (tracked > Math.Min(request.ResultBytes, 256 * 1024)) throw new InvalidDataException("Result byte budget exceeded.");
        if (value is null) { CountLeaf(); return null; }
        if (value is ScriptObject obj)
        {
            if (!active.Add(value)) throw new InvalidDataException("Cyclic result."); var result = new Dictionary<string, object?>();
            foreach (var pair in obj) { tracked += Encoding.UTF8.GetByteCount(pair.Key) + 8L; result.Add(pair.Key, Convert(pair.Value, depth + 1)); }
            active.Remove(value); return result;
        }
        if (value is IList list)
        {
            if (!active.Add(value)) throw new InvalidDataException("Cyclic result."); var result = new List<object?>();
            foreach (var child in list) result.Add(Convert(child, depth + 1)); active.Remove(value); return result;
        }
        CountLeaf();
        if (value is string text) { var bytes = Encoding.UTF8.GetByteCount(text); if (bytes > Math.Min(request.ValueBytes, 64 * 1024)) throw new InvalidDataException("Result scalar exceeds its byte limit."); tracked += bytes; return text; }
        if (value is bool) return value;
        if (value is sbyte or byte or short or ushort or int or uint or long) return System.Convert.ToInt64(value, CultureInfo.InvariantCulture);
        if (value is ulong unsigned && unsigned <= long.MaxValue) return (long)unsigned;
        if (value is float single && float.IsFinite(single)) return (double)single;
        if (value is double number && double.IsFinite(number)) return number;
        if (value is decimal dec) { var converted = (double)dec; if (double.IsFinite(converted) && (decimal)converted == dec) return converted; }
        throw new InvalidDataException("Result is not a supported finite scalar, object, or array.");
    }
    private void CountLeaf() { if (++leaves > Math.Min(request.ResultLeaves, 1024)) throw new InvalidDataException("Result leaf limit exceeded."); }
}

internal static class WorkerDateFormats
{
    internal static readonly string[] Utc = ["O", "yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"];
}
