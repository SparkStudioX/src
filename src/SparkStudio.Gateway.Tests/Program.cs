using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using SparkStudio.Gateway;

if (args.Contains("--source-load-test"))
{
    try { await SourceLoadProbe.RunAsync(args); }
    catch (Exception error) { Console.Error.WriteLine($"Source load probe failed: {error}"); Environment.ExitCode = 1; }
    return;
}

if (args.Contains("--load-test"))
{
    try { await GatewayLoadProbe.RunAsync(args); }
    catch (Exception error) { Console.Error.WriteLine($"Gateway load probe failed: {error}"); Environment.ExitCode = 1; }
    return;
}

if (args.Contains("--live-opc"))
{
    try { await LiveOpcAcceptance.RunAsync(); }
    catch (Exception error) { Console.Error.WriteLine($"Live OPC acceptance failed: {error.GetType().Name}: {error.Message}"); Environment.ExitCode = 1; }
    return;
}

var suites = new List<(string Name, Func<Task<int>> Run)> { ("Gateway model and journal", () => Task.FromResult(RunModelChecks())) };
var only = new Dictionary<string, string> {
    ["--unified-publication-only"] = "UnifiedPublicationChecks", ["--equipment-commands-only"] = "EquipmentCommandChecks",
    ["--interaction-events-only"] = "InteractionEventChecks", ["--input-constraints-only"] = "InputConstraintChecks"
};
var selected = only.FirstOrDefault(item => args.Contains(item.Key)).Value;
var suiteArgument = Array.IndexOf(args, "--suite");
if (suiteArgument >= 0)
{
    if (suiteArgument + 1 >= args.Length) throw new ArgumentException("--suite needs a check class name.");
    selected = args[suiteArgument + 1];
}
if (selected is not null) suites.Clear();
foreach (var type in Assembly.GetExecutingAssembly().GetTypes().Where(type => type.Name.EndsWith("Checks", StringComparison.Ordinal)).OrderBy(type => type.Name))
{
    if (selected is not null && type.Name != selected) continue;
    var method = type.GetMethods(BindingFlags.Public | BindingFlags.Static).FirstOrDefault(method =>
        method.GetParameters().Length == 0 && (method.Name is "Run" or "RunAsync") && (method.ReturnType == typeof(int) || method.ReturnType == typeof(Task<int>)));
    if (method is null) continue;
    suites.Add((type.Name, async () => { var result = method.Invoke(null, null); return result is Task<int> task ? await task : (int)result!; }));
}
if (suites.Count == 0) throw new ArgumentException("No matching test suite.");
await TestReport.RunAsync("Gateway", args, suites);

static int RunModelChecks()
{
var passed = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new Exception("FAILED: " + description);
    passed++;
}
void Reject(Action action, string description)
{
    try { action(); } catch (ArgumentException) { passed++; return; }
    throw new Exception("FAILED to reject: " + description);
}
JsonObject Resource(string trigger = "startup", string id = "test", string? name = null) => new()
{
    ["id"] = id, ["name"] = name ?? id, ["type"] = "gateway", ["event"] = trigger, ["code"] = "result = 1"
};
JsonObject Draft(params JsonObject[] resources) => new() { ["revision"] = 0, ["resources"] = new JsonArray(resources.Select(item => (JsonNode)item).ToArray()) };
JsonObject Normalize(JsonObject resource) => ScriptResourceStore.ValidateDraft(Draft(resource))["resources"]![0]!.AsObject();
DateTimeOffset Instant(string value) => DateTimeOffset.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
void Next(string cron, string zone, string after, string expected, string description) =>
    Check(ScriptCron.Next(cron, zone, Instant(after)) == Instant(expected), description);

var startup = Normalize(Resource());
Check(startup["timeoutMs"]!.GetValue<int>() == 10000 && startup["threading"]!.GetValue<string>() == "dedicated" && !startup["enabled"]!.GetValue<bool>(), "legacy gateway defaults preserve disabled scripts and add dedicated ten-second execution");
var legacyStartup = Resource(); legacyStartup["intervalMs"] = 1000;
Check(!Normalize(legacyStartup).ContainsKey("intervalMs"), "legacy Designer startup timer field is accepted and omitted");
var timer = Normalize(Resource("timer"));
Check(timer["intervalMs"]!.GetValue<int>() == 1000 && timer["delayType"]!.GetValue<string>() == "fixedDelay", "legacy timer defaults retain fixed delay");
foreach (var trigger in new[] { "startup", "update", "shutdown", "timer", "tagChange", "message", "scheduled" })
{
    var resource = Resource(trigger);
    resource["threading"] = "shared";
    resource["timeoutMs"] = 300000;
    if (trigger == "tagChange") resource["tagPaths"] = new JsonArray("[default]Machines/*", "[remote]State");
    if (trigger == "scheduled") { resource["cron"] = "*/5 1-22 * * 1-5"; resource["timeZone"] = "UTC"; }
    var next = Normalize(resource);
    Check(next["event"]!.GetValue<string>() == trigger && next["timeoutMs"]!.GetValue<int>() == 300000, "supported event " + trigger);
    if (trigger == "tagChange") Check(next["changeTriggers"]!.ToJsonString() == "[\"value\"]", "tag-change defaults to value changes");
    if (trigger == "message") Check(next["requiredPermission"]!.GetValue<string>() == "operate", "message permission defaults to operate");
}
foreach (var value in new JsonNode?[] { JsonValue.Create(99), JsonValue.Create(300001), JsonValue.Create(100.5), JsonValue.Create("1000"), null })
{
    var resource = Resource(); resource["timeoutMs"] = value;
    Reject(() => Normalize(resource), "invalid timeout");
}
foreach (var (key, value) in new[] { ("threading", "pooled"), ("unknown", "setting"), ("event", "tag-change"), ("intervalMs", "1000") })
{
    var resource = Resource(); resource[key] = value;
    Reject(() => Normalize(resource), "unknown or event-inappropriate gateway option " + key);
}
var fixedRate = Resource("timer"); fixedRate["delayType"] = "fixedRate"; fixedRate["intervalMs"] = 100;
Check(Normalize(fixedRate)["delayType"]!.GetValue<string>() == "fixedRate", "fixed-rate timer accepted");
foreach (var value in new[] { "other", "", "FixedDelay" })
{
    var resource = Resource("timer"); resource["delayType"] = value;
    Reject(() => Normalize(resource), "unknown timer delay type");
}
foreach (var path in new[] { "Machines/Value", "[]Value", "[default]", "[default]*", "[default]Machines/V*", "[default]Machines/*/Value", "[default]../Value", "[default]Machines//Value", "[default]Machines\\Value", "[default]Machines/{value}", "[default]Machines/\nValue" })
    Reject(() => GatewayScriptOptions.ValidateTagPath(path), "invalid absolute tag pattern " + path);
var tag = Resource("tagChange"); tag["tagPaths"] = new JsonArray("[default]Machines/Value"); tag["changeTriggers"] = new JsonArray("value", "quality", "timestamp");
Check(Normalize(tag)["changeTriggers"]!.AsArray().Count == 3, "all tag change triggers accepted");
foreach (var triggers in new[] { new JsonArray(), new JsonArray("value", "value"), new JsonArray("alarm") })
{
    var resource = Resource("tagChange"); resource["tagPaths"] = new JsonArray("[default]Machines/Value"); resource["changeTriggers"] = triggers;
    Reject(() => Normalize(resource), "empty, duplicate or unsupported tag triggers");
}
var duplicatePaths = Resource("tagChange"); duplicatePaths["tagPaths"] = new JsonArray("[default]Value", "[default]Value");
Reject(() => Normalize(duplicatePaths), "duplicate tag paths");
Reject(() => Normalize(Resource("tagChange")), "missing tag paths");
var excessivePaths = Resource("tagChange"); excessivePaths["tagPaths"] = new JsonArray(Enumerable.Range(0, 65).Select(index => (JsonNode)JsonValue.Create($"[default]Value{index}")!).ToArray());
Reject(() => Normalize(excessivePaths), "excessive tag paths");
Reject(() => ScriptResourceStore.ValidateDraft(Draft(Resource("message", "a", "same"), Resource("message", "b", "same"))), "ambiguous message handler names");
var admin = Resource("message"); admin["requiredPermission"] = "admin";
Check(Normalize(admin)["requiredPermission"]!.GetValue<string>() == "admin", "admin message permission accepted");
var permission = Resource("message"); permission["requiredPermission"] = "design";
Reject(() => Normalize(permission), "unsupported message permission");
var client = Resource("screenOpen"); client["type"] = "client";
Check(Normalize(client)["event"]!.GetValue<string>() == "screenOpen", "existing client event normalization preserved");

foreach (var cron in new[] { "", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "* 8-3 * * *", "1,,2 * * * *", "* * * * MON", "* * ? * *", "+1 * * * *", "1/2/3 * * * *", "* * * * *\n" })
    Reject(() => ScriptCron.Validate(cron, "UTC"), "invalid cron " + cron);
Reject(() => ScriptCron.Validate("* * * * *", "not-a-time-zone"), "unknown time zone");
Next("* * * * *", "UTC", "2026-09-29T10:00:00Z", "2026-09-29T10:01:00Z", "strictly after current boundary");
Next("* * * * *", "UTC", "2026-09-29T10:00:59Z", "2026-09-29T10:01:00Z", "minute alignment");
Next("5,20-40/10 10 * * *", "UTC", "2026-09-29T10:20:00Z", "2026-09-29T10:30:00Z", "lists and stepped ranges");
Next("5/10 * * * *", "UTC", "2026-09-29T10:05:00Z", "2026-09-29T10:15:00Z", "stepped start value");
Next("0 0 29 2 *", "UTC", "2027-03-01T00:00:00Z", "2028-02-29T00:00:00Z", "leap day");
Next("0 0 1 * 1", "UTC", "2026-09-29T00:00:00Z", "2026-10-01T00:00:00Z", "restricted day fields use OR");
Next("0 0 1 * 1", "UTC", "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z", "weekday branch of day-field OR");
Next("0 0 */2 * 1", "UTC", "2026-10-05T00:00:00Z", "2026-10-19T00:00:00Z", "wildcard day steps retain both day-field restrictions");
Next("0 0 * * 7", "UTC", "2026-09-29T00:00:00Z", "2026-10-04T00:00:00Z", "Sunday seven alias");
Next("30 2 * * *", "America/Chicago", "2026-03-08T07:59:00Z", "2026-03-09T07:30:00Z", "spring-forward missing minute skipped");
Next("30 1 * * *", "America/Chicago", "2026-11-01T05:59:00Z", "2026-11-01T06:30:00Z", "fall-back first occurrence chosen");
Next("30 1 * * *", "America/Chicago", "2026-11-01T06:30:00Z", "2026-11-02T07:30:00Z", "fall-back second occurrence omitted");
Next("30 1 * * *", "Central Standard Time", "2026-11-01T06:40:00Z", "2026-11-02T07:30:00Z", "Windows and IANA zone IDs share fold policy");
var watch = Stopwatch.StartNew();
Check(ScriptCron.Next("* * 30 2 *", "UTC", Instant("2026-01-01T00:00:00Z")) is null, "impossible calendar schedule returns no occurrence within four years");
Check(watch.Elapsed < TimeSpan.FromSeconds(2), "impossible schedule skips calendar days efficiently");

var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
var directory = Path.GetFullPath(Path.Combine(temporaryRoot, "SparkStudio.ScriptOptions." + Guid.NewGuid().ToString("N")));
if (Path.GetDirectoryName(directory) != temporaryRoot) throw new InvalidOperationException("Test directory escaped its temporary root.");
try
{
    var store = new ScriptResourceStore(directory);
    Check(store.DataDirectory == directory, "store exposes its data directory");
    var notices = new List<ScriptUpdateNotice>();
    store.Updated += notice =>
    {
        Check(Task.Run(() => store.GetDraft()).Wait(TimeSpan.FromSeconds(2)), "update notification occurs outside storage lock");
        notices.Add(notice);
    };
    var draft = store.SaveDraft(Draft(Resource()), "tester");
    Check(notices.Count == 1 && notices[0].Actor == "tester" && notices[0].Reason == "scriptsSaved", "successful save notifies actor and reason");
    Check(notices[0].Resources["added"]!.AsArray().Count == 1 && !notices[0].Resources["manifestChanged"]!.GetValue<bool>(), "added resource metadata has no manifest change");
    Check(notices[0].Resources["added"]![0]!.AsObject().Select(pair => pair.Key).Order().SequenceEqual(new[] { "id", "name", "type" }), "change notices expose metadata without script code");
    draft = store.SaveDraft(draft);
    Check(notices.Count == 1, "revision-only save emits no duplicate update");
    draft["resources"]![0]!["name"] = "Renamed";
    draft = store.SaveDraft(draft);
    Check(notices.Count == 2 && notices[1].Resources["modified"]![0]!["name"]!.GetValue<string>() == "Renamed", "resource changes emit modified metadata");
    var stale = draft.DeepClone().AsObject(); stale["revision"] = 0;
    try { store.SaveDraft(stale); throw new Exception("Stale save was accepted."); } catch (InvalidOperationException) { passed++; }
    Check(notices.Count == 2, "stale save emits no update");
    var invalid = draft.DeepClone().AsObject(); invalid["resources"]![0]!["timeoutMs"] = 1;
    Reject(() => store.SaveDraft(invalid), "invalid save");
    Check(notices.Count == 2 && JsonNode.DeepEquals(store.GetDraft(), draft), "invalid save changes neither draft nor notifications");
    var publications = 0; store.Published += () => publications++;
    store.Publish(ScriptResourceStore.Revision(draft), "tester");
    store.Publish(ScriptResourceStore.Revision(draft), "tester");
    Check(publications == 1 && notices.Count == 2, "repeat publication and already-notified saves avoid duplicate events");
    draft["resources"] = new JsonArray();
    store.SaveDraft(draft);
    Check(notices.Count == 3 && notices[2].Resources["removed"]![0]!["id"]!.GetValue<string>() == "test", "removed resource metadata");
    var external = new ScriptUpdateNotice("designer", new JsonObject { ["manifestChanged"] = true }, "projectSaved");
    store.NotifyUpdate(external);
    external.Resources["manifestChanged"] = false;
    Check(notices[^1].Resources["manifestChanged"]!.GetValue<bool>(), "external update notice takes a detached snapshot");

    var journal = new ScriptRunJournal(directory);
    Check(journal.Load().Length == 0, "absent journal has empty history");
    journal.Save([new JsonObject { ["runId"] = "unfinished", ["status"] = "running", ["success"] = null },
        new JsonObject { ["runId"] = "finished", ["status"] = "succeeded", ["success"] = true, ["stdout"] = "completed" }]);
    var recovered = journal.Load();
    Check(recovered[0]["status"]!.GetValue<string>() == "interrupted" && !recovered[0]["success"]!.GetValue<bool>() &&
        recovered[0]["finishedAt"] is not null, "unfinished journal execution becomes interrupted on load");
    Check(recovered[0]["stderr"]!.GetValue<string>().Contains("side effects", StringComparison.Ordinal), "interrupted execution explains uncertain side effects");
    Check(recovered[1]["status"]!.GetValue<string>() == "succeeded" && recovered[1]["stdout"]!.GetValue<string>() == "completed", "completed journal entry survives recovery unchanged");
    var reloaded = new ScriptRunJournal(directory).Load();
    Check(JsonNode.DeepEquals(reloaded[0], recovered[0]), "interrupted recovery is persisted and stable across reload");
    recovered[0]["status"] = "modified-by-caller";
    Check(journal.Load()[0]["status"]!.GetValue<string>() == "interrupted", "returned journal entries are detached from persisted history");
    journal.Save(Enumerable.Range(0, 125).Select(index => new JsonObject { ["runId"] = index.ToString(), ["status"] = "succeeded" }));
    var retained = journal.Load();
    Check(retained.Length == 100 && retained[0]["runId"]!.GetValue<string>() == "25" && retained[^1]["runId"]!.GetValue<string>() == "124", "journal retains only the newest one hundred entries in order");
    try
    {
        journal.Save([new JsonObject { ["stdout"] = new string('x', 8 * 1024 * 1024) }]);
        throw new Exception("Oversized journal save was accepted.");
    }
    catch (IOException) { passed++; }
    Check(journal.Load().Length == 100 && journal.Load()[^1]["runId"]!.GetValue<string>() == "124", "oversized save preserves the prior journal");
    var journalPath = Path.Combine(directory, "script-event-runs.json");
    File.WriteAllText(journalPath, "{\"version\":2,\"runs\":[]}");
    try { journal.Load(); throw new Exception("Unsupported journal version was accepted."); }
    catch (InvalidOperationException) { passed++; }
    File.WriteAllText(journalPath, "{\"version\":1,\"runs\":[false]}");
    try { journal.Load(); throw new Exception("Invalid journal entries were accepted."); }
    catch (InvalidOperationException) { passed++; }
}
finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
return passed;
}
