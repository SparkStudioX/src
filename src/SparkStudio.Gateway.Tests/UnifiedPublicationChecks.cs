using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class UnifiedPublicationChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string description) { if (!value) throw new Exception("FAILED: " + description); passed++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.Combine(temp, "SparkStudio.UnifiedPublication." + Guid.NewGuid().ToString("N"));
        Check(Path.GetDirectoryName(directory) == temp, "isolated fixture stays under temp");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var project = JsonNode.Parse("""
            {"name":"Release fixture","parameters":{},"templates":[],"screens":[{"id":"main","name":"Release A","width":800,"height":600,"components":[
              {"id":"run","type":"button","x":10,"y":10,"width":180,"height":60,"props":{"text":"Check release","action":"script","language":"python","script":"from project import release\nresult = release.VERSION"}}
            ]}]}
            """)!.AsObject();
            var workspace = catalog.Create("Release fixture", project, Seed.Queries());
            var publications = workspace.Publication; var scripts = workspace.Scripts; var store = workspace.Store;
            int Revision() => store.GetProject()["revision"]!.GetValue<int>();
            JsonObject Script(string id, string type, string code, string? trigger = null) => new() {
                ["id"] = id, ["name"] = id, ["type"] = type, ["code"] = code, ["enabled"] = true,
                ["parameters"] = new JsonObject(), ["event"] = trigger
            };
            void SaveScripts(string version)
            {
                var draft = scripts.GetDraft();
                var library = Script("release", "library", $"VERSION = '{version}'"); library.Remove("event");
                var code = "from project import release\nrows = system.db.runNamedQuery('production-summary')\nresult = release.VERSION + ':' + rows.getValueAt(0, 'Line')";
                draft["resources"] = new JsonArray(library, Script("started", "gateway", code, "startup"),
                    Script("stopped", "gateway", "import time\ntime.sleep(0.08)\n" + code, "shutdown"),
                    Script("message", "gateway", code, "message"), Script("browser", "client", $"app.notify('Browser {version}');", "startup"));
                scripts.SaveDraft(draft);
            }
            JsonObject Publish()
            {
                var review = publications.Review(store);
                return publications.Publish(store, review["revision"]!.GetValue<int>(), review["scriptsRevision"]!.GetValue<int>(), review["reviewToken"]!.GetValue<string>());
            }
            SaveScripts("A");
            var review = publications.Review(store);
            var query = store.GetQuery("production-summary"); query["name"] = "Changed after review"; store.SaveQuery("production-summary", query);
            Reject(() => publications.Publish(store, Revision(), review["scriptsRevision"]!.GetValue<int>(), review["reviewToken"]!.GetValue<string>()), "stale query review");
            Check(!publications.Metadata()["published"]!.GetValue<bool>(), "stale review leaves initial application unpublished");
            review = publications.Review(store); SaveScripts("A");
            Reject(() => publications.Publish(store, Revision(), review["scriptsRevision"]!.GetValue<int>(), review["reviewToken"]!.GetValue<string>()), "stale script review");
            var first = Publish(); var firstStamp = first["publishedAt"]!.GetValue<string>();
            var firstId = publications.History()["entries"]![0]!["id"]!.GetValue<string>();
            var captured = publications.GetAction("main", "run", firstStamp);
            Check(captured["libraries"]!["release"]!.GetValue<string>().Contains("'A'"), "action captures matching Python library");
            Check(scripts.CapturePublished()!["queries"]!.AsArray().Count == 1, "gateway snapshot captures all named queries");
            Check(scripts.Metadata()["publishedAt"]!.GetValue<string>() == firstStamp && publications.GetClientResources(firstStamp)["applicationPublishedAt"]!.GetValue<string>() == firstStamp, "scripts and screens share one publication identity");
            Check(!File.Exists(Path.Combine(workspace.Directory, "scripts-published.json")), "unified publish writes no second active publication file");
            var notifications = 0; scripts.Published += () => notifications++;
            var repeated = publications.Publish(store, Revision(), ScriptResourceStore.Revision(scripts.GetDraft()), onlyWhenChanged: true);
            Check(repeated["publishedAt"]!.GetValue<string>() == firstStamp && notifications == 0, "compatibility retry is idempotent only for an unchanged complete application");
            var before = File.ReadAllBytes(Path.Combine(workspace.Directory, "published.json"));
            SaveScripts("B"); query["parameters"]![0]!["defaultValue"] = "Line2"; store.SaveQuery("production-summary", query);
            var nextProject = store.GetProject(); nextProject["screens"]![0]!["name"] = "Release B"; store.SaveProject(nextProject);
            var blockedPath = Path.Combine(workspace.Directory, "published.json.tmp"); Directory.CreateDirectory(blockedPath);
            Reject(() => Publish(), "failed durable replacement");
            Check(File.ReadAllBytes(Path.Combine(workspace.Directory, "published.json")).SequenceEqual(before) && notifications == 0, "failed write retains exact release bytes and does not activate events");
            Check(scripts.CaptureLibraries()["release"].Contains("'A'"), "failed write retains active libraries");
            Directory.Delete(blockedPath);
            var second = Publish(); var secondStamp = second["publishedAt"]!.GetValue<string>();
            Check(notifications == 1 && scripts.CaptureLibraries()["release"].Contains("'B'"), "successful write activates all resources once");
            Reject(() => publications.GetAction("main", "run", firstStamp), "stale screen invocation");
            Reject(() => publications.GetClientResources(firstStamp), "stale browser script read");
            Check(captured["libraries"]!["release"]!.GetValue<string>().Contains("'A'"), "in-flight action snapshot remains detached after a newer release");
            var savedProject = store.GetProject(); var savedScripts = scripts.GetDraft(); var savedQueries = store.GetQueries();
            Directory.CreateDirectory(blockedPath);
            Reject(() => publications.Rollback(firstId, secondStamp), "failed rollback replacement");
            Check(scripts.CaptureLibraries()["release"].Contains("'B'") && notifications == 1, "failed rollback leaves current scripts active without an event switch");
            Directory.Delete(blockedPath);
            Reject(() => publications.Rollback(firstId, firstStamp), "stale rollback");
            var restored = publications.Rollback(firstId, secondStamp);
            Check(scripts.CaptureLibraries()["release"].Contains("'A'") && scripts.CapturePublished()!["queries"]![0]!["parameters"]![0]!["defaultValue"]!.GetValue<string>() == "Line1", "rollback restores libraries and queries from the same old version");
            Check(JsonNode.DeepEquals(savedProject, store.GetProject()) && JsonNode.DeepEquals(savedScripts, scripts.GetDraft()) && JsonNode.DeepEquals(savedQueries, store.GetQueries()), "rollback preserves all three saved draft domains");
            var reloaded = new ProjectCatalog(directory, new EphemeralDataProtectionProvider()).Get(workspace.Id);
            Check(JsonNode.DeepEquals(reloaded.Publication.Metadata(), restored) && reloaded.Scripts.CaptureLibraries()["release"].Contains("'A'"), "restart recovers same complete restored release");

            var pythonPath = TestEnvironment.PythonExecutable();
            if (!File.Exists(pythonPath)) throw new Exception("Unified publication integration requires the bundled Python runtime.");
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var executor = new QueryExecutor(store, connectors);
            var runner = new PythonRunner(tags, executor, scripts, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = pythonPath }).Build());
            var actionResult = await runner.RunAsync(captured["code"]!.GetValue<string>(), null, null, CancellationToken.None, captured["queries"]!.AsArray(), libraries: captured["libraries"]!.AsObject().ToDictionary(pair => pair.Key, pair => pair.Value!.GetValue<string>()));
            Check(actionResult["success"]!.GetValue<bool>() && actionResult["result"]!.GetValue<string>() == "A", "CPython executes previously captured action with its matching library");
            using var events = new ScriptEventService(scripts, runner, NullLogger<ScriptEventService>.Instance, tags);
            await events.StartAsync(CancellationToken.None);
            async Task WaitReady(string stamp)
            {
                for (var attempt = 0; attempt < 300; attempt++)
                {
                    var status = events.Status();
                    if (status["acceptingEvents"]!.GetValue<bool>() && status["publishedAt"]?.GetValue<string>() == stamp) return;
                    await Task.Delay(20);
                }
                throw new Exception("Event activation did not complete: " + events.Logs().ToJsonString());
            }
            try
            {
                await WaitReady(restored["publishedAt"]!.GetValue<string>());
                Check(events.Logs().OfType<JsonObject>().Any(log => log["event"]?.GetValue<string>() == "startup" && log["result"]?.GetValue<string>() == "A:Line1"), "startup uses restored library and captured query despite newer drafts");
                var activeB = Publish(); await WaitReady(activeB["publishedAt"]!.GetValue<string>());
                var logs = events.Logs().OfType<JsonObject>().Reverse().ToArray();
                var shutdownA = logs.First(log => log["event"]?.GetValue<string>() == "shutdown");
                var startupB = logs.Last(log => log["event"]?.GetValue<string>() == "startup");
                Check(shutdownA["result"]?.GetValue<string>() == "A:Line1" && startupB["result"]?.GetValue<string>() == "B:Line2", "old shutdown and new startup each use their own complete snapshots");
                Check(DateTimeOffset.Parse(shutdownA["finishedAt"]!.GetValue<string>()) <= DateTimeOffset.Parse(startupB["startedAt"]!.GetValue<string>()), "old shutdown drains before new startup starts");
                // Same script draft revision, changed application/query identity still replaces the generation.
                query["parameters"]![0]!["defaultValue"] = "Line1"; store.SaveQuery("production-summary", query);
                var queryOnly = publications.Publish(store, Revision(), ScriptResourceStore.Revision(scripts.GetDraft()), onlyWhenChanged: true); await WaitReady(queryOnly["publishedAt"]!.GetValue<string>());
                Check(events.Logs().OfType<JsonObject>().First(log => log["event"]?.GetValue<string>() == "startup")["result"]?.GetValue<string>() == "B:Line1", "query-only publication activates a new generation despite unchanged script revision");
            }
            finally { await events.StopAsync(CancellationToken.None); }

            // Independently create the pre-unified format, with no manufactured script history.
            var legacyDirectory = Path.Combine(directory, "legacy"); Directory.CreateDirectory(legacyDirectory);
            var legacyStore = new ProjectStore(legacyDirectory, new EphemeralDataProtectionProvider());
            var legacy = store.CapturePublication(Revision()); legacy["publishedAt"] = DateTimeOffset.UtcNow.ToString("O"); legacy["schemaVersion"] = 1;
            File.WriteAllText(Path.Combine(legacyDirectory, "published.json"), legacy.ToJsonString());
            var legacyScripts = new ScriptResourceStore(legacyDirectory);
            var oldDraft = legacyScripts.GetDraft(); var oldLibrary = Script("release", "library", "VERSION = 'LEGACY'"); oldLibrary.Remove("event"); oldDraft["resources"] = new JsonArray(oldLibrary);
            var oldSaved = legacyScripts.SaveDraft(oldDraft); legacyScripts.Publish(ScriptResourceStore.Revision(oldSaved));
            var legacyPublication = new PublicationStore(legacyDirectory, new LocalAssetStore(legacyDirectory)); legacyPublication.AttachScripts(legacyScripts); legacyScripts.AttachApplication(legacyPublication);
            Check(legacyPublication.Metadata()["warnings"]!.AsArray().Any(w => w!.GetValue<string>().Contains("Legacy snapshot")), "legacy application exposes explicit compatibility warning");
            legacyPublication.Publish(legacyStore, legacyStore.GetProject()["revision"]!.GetValue<int>());
            var oldEntry = legacyPublication.History()["entries"]!.AsArray().OfType<JsonObject>().Single(entry => !entry["complete"]!.GetValue<bool>());
            var current = legacyPublication.Metadata()["publishedAt"]!.GetValue<string>();
            Reject(() => legacyPublication.Rollback(oldEntry["id"]!.GetValue<string>(), current), "legacy restore without acknowledgement");
            legacyPublication.Rollback(oldEntry["id"]!.GetValue<string>(), current, true);
            Check(legacyScripts.CaptureLibraries()["release"].Contains("LEGACY") && legacyPublication.Metadata()["warnings"]!.AsArray().Count > 0, "acknowledged legacy restore preserves active scripts durably with warning");
            return passed;
        }
        finally { if (Path.GetDirectoryName(directory) == temp && Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
}
