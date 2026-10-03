using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class GatewaySourceChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool value, string message) { if (!value) throw new InvalidOperationException("Sources: " + message); checks++; }
        void Reject(Action action, string message)
        { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException or InvalidDataException or BadHttpRequestException) { checks++; return; } throw new InvalidOperationException("Sources accepted " + message); }
        async Task RejectAsync(Func<Task> action, string message)
        { try { await action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException or InvalidDataException or BadHttpRequestException) { checks++; return; } throw new InvalidOperationException("Sources accepted " + message); }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.SourceGateway." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var protection = new EphemeralDataProtectionProvider();
            var catalog = new ProjectCatalog(Path.Combine(directory, "gateway"), protection);
            var store = catalog.GatewayStore;
            var point = new SourcePoint("native", "Native", "opaque#element/with&delimiter=1", "Int64", "/reading");
            var source = new SourceSettings("http://127.0.0.1/v1", Points: [point], Authentication: new("basic", "fixture-user", "Synthetic-source-password-123"));
            var saved = store.SaveConnection(Connection("i3x", "i3x", source));
            var id = saved["source"]!["i3x"]!["clientId"]!.GetValue<string>();
            Check(!string.IsNullOrEmpty(id) && store.GetConnection("i3x").Source!.I3x!.ClientId == id, "random i3X client identity is persisted before connecting");
            var persisted = File.ReadAllText(Path.Combine(directory, "gateway", "connections.json"));
            Check(!persisted.Contains("Synthetic-source-password-123") && persisted.Contains("protectedPassword"), "source password is protected at rest");
            Check(!saved.ToJsonString().Contains("Synthetic-source-password") && saved["source"]!["authentication"]!["hasPassword"]!.GetValue<bool>(), "source credentials are redacted with presence metadata");
            saved["name"] = "Edited source"; saved = store.SaveConnection(saved);
            Check(store.GetConnection("i3x").Source!.Authentication!.Password == "Synthetic-source-password-123"
                && store.GetConnection("i3x").Source!.I3x!.ClientId == id, "redacted edits retain protected credential and client identity");
            Reject(() => store.SaveConnection(Connection("forged", "i3x", source with { Points = [point with { Writable = true }] })), "forged source point writable import");
            Reject(() => store.SaveConnection(Connection("unknown", "future-source", source)), "unknown source driver");
            var tag = Tag("[default]ReadSources/Direct", "i3x", point.Id);
            Check(store.SaveTag(tag)["writable"]!.GetValue<bool>() == false, "source point catalog derives read-only tag access");
            Reject(() => store.SaveTag(Tag("[default]ReadSources/Forged", "i3x", point.Id).WithWritable()), "forged writable source tag");
            var removed = saved.DeepClone().AsObject(); removed["source"]!["points"] = new JsonArray();
            Reject(() => store.SaveConnection(removed), "referenced source point removal");
            var package = store.ExportTags();
            package["udtDefinitions"]!.AsArray().Add(new JsonObject { ["id"] = "SourceCnc", ["version"] = 1,
                ["members"] = new JsonArray(Tag("Reading", "i3x", point.Id)) });
            package["instances"]!.AsArray().Add(new JsonObject { ["path"] = "[default]CncUnit", ["definitionId"] = "SourceCnc", ["version"] = 1, ["overrides"] = new JsonObject() });
            var udt = store.PreviewTagImport(package); store.ApplyTagImport(new(package, udt.Revision, udt.PreviewToken));
            Check(store.GetTagDefinitions().OfType<JsonObject>().Any(item => item["path"]?.GetValue<string>() == "[default]CncUnit/Reading" && item["writable"]?.GetValue<bool>() == false),
                "common source catalog normalizes UDT members and instances");
            var forgedPackage = store.ExportTags(); forgedPackage["tags"]!.AsArray().Add(Tag("[default]ReadSources/ForgeImport", "i3x", point.Id).WithWritable());
            Reject(() => store.PreviewTagImport(forgedPackage), "forged writable source tag engineering package");

            var request = new SourceImportRequest(saved["revision"]!.GetValue<int>(), [new("another#opaque/id", "Imported", "Int64", "[default]ReadSources/Imported", "/a~1b")]);
            var preview = Node(store.PreviewSourceImport("i3x", request));
            var before = File.ReadAllBytes(Path.Combine(directory, "gateway", "connections.json"));
            Reject(() => store.ApplySourceImport("i3x", request with { PreviewToken = "unreviewed" }), "source import without reviewed token");
            Check(before.SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "gateway", "connections.json"))), "rejected source import leaves connection generation unchanged");
            store.SaveTag(new JsonObject { ["path"] = "[default]ReadSources/Unrelated", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 1 });
            Reject(() => store.ApplySourceImport("i3x", request with { PreviewToken = preview["previewToken"]!.GetValue<string>() }), "stale source import after unrelated definition change");
            preview = Node(store.PreviewSourceImport("i3x", request));
            var imported = Node(store.ApplySourceImport("i3x", request with { PreviewToken = preview["previewToken"]!.GetValue<string>() }));
            Check(imported["imported"]!.GetValue<int>() == 1 && store.GetConnection("i3x").Source!.SavedPoints.Any(item => item.Address == "another#opaque/id" && item.Selector == "/a~1b")
                && store.GetTagDefinitions().OfType<JsonObject>().Any(item => item["path"]?.GetValue<string>() == "[default]ReadSources/Imported"), "reviewed import commits stable points and tags together");
            Reject(() => store.PreviewSourceImport("i3x", request), "old connection revision after source import");
            var revision = store.GetConnections().OfType<JsonObject>().Single(item => item["id"]?.GetValue<string>() == "i3x")["revision"]!.GetValue<int>();
            Reject(() => store.PreviewSourceImport("i3x", new(revision, [new("collision", "Collision", "Int64", "[default]ReadSources/Direct")])), "source import path collision");
            using var connectors = new ConnectorService(Path.Combine(directory, "gateway"));
            await RejectAsync(() => connectors.WriteValueAsync(store.GetConnection("i3x"), point.Id, "Int64", JsonSerializer.SerializeToElement(1), default), "direct source write dispatch");
            await RejectAsync(() => connectors.WriteValueAsync(new("unknown", "Unknown", "unknown", Endpoint: "opc.tcp://127.0.0.1:1"), "native", "Int64", JsonSerializer.SerializeToElement(1), default), "unknown driver OPC fallback on write");
            await CommandGuards(catalog, Path.Combine(directory, "gateway"), connectors, Check, RejectAsync);
            await Ownership(directory, protection, Check, Reject, RejectAsync);
            EscapedOwnershipReferences(directory, protection, Check, Reject);
            await Lifecycle(directory, Check, RejectAsync);
            await MailboxTransfer(directory, Check);
            await DiscoveryHealth(directory, Check);
            await PruneConfigurationRace(directory, Check);
            await HeldLifecycleDisable(directory, Check);
            SourceSaveFailure(directory, Check);
            await OwnedUdtImport(directory, Check, Reject);
            MixedMappingRestart(directory, Check, Reject);
            await SourceDeadband(directory, Check);
            IntegerWireFidelity(Check);
            return checks;
        }
        finally { if (Path.GetDirectoryName(directory) == Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) && Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private static void EscapedOwnershipReferences(string directory, IDataProtectionProvider protection,
        Action<bool, string> check, Action<Action, string> reject)
    {
        var data = Path.Combine(directory, "escaped-ownership");
        var store = new ProjectStore(data, protection, gatewayOnly: true);
        var mapping = new SourceMqttMapping("escaped", "factory/#", "[default]Escaped", Tags: "automatic", PruneAfterSeconds: 1);
        var settings = Mqtt(mapping);
        var saved = store.SaveConnection(Connection("escaped", "mqtt", settings));
        const string topic = "factory/caf\u00e9\"\u673a";
        var path = SourceConfiguration.TopicPath(mapping, topic);
        store.ApplySourceDiscovery("escaped", [new("escaped", topic, null, topic, "Int64", path, 1L)]);
        var statePath = Path.Combine(data, "source-discovery.json");
        var state = JsonNode.Parse(File.ReadAllText(statePath))!.AsObject();
        state["leaves"]![0]!["lastSeen"] = DateTimeOffset.UtcNow.AddMinutes(-5);
        File.WriteAllText(statePath, state.ToJsonString(ProjectStore.Json));
        store = new ProjectStore(data, protection, gatewayOnly: true);
        var project = Path.Combine(data, "projects", "synthetic-references");
        Directory.CreateDirectory(project);
        foreach (var name in new[] { "project.json", "published.json", "scripts-draft.json", "scripts-published.json" })
        foreach (var reference in new[] { path, "value = system.tag.read('" + path + "')" })
        {
            var resource = Path.Combine(project, name);
            var json = new JsonObject { ["nested"] = new JsonArray(new JsonObject { ["reference"] = reference }) }.ToJsonString(ProjectStore.Json);
            check(!json.Contains(path, StringComparison.Ordinal), "reference fixture uses JSON-escaped Unicode and quote characters");
            File.WriteAllText(resource, json);
            reject(() => store.DeleteTag(path), name + " escaped source reference deletion");
            check(store.PruneSourceLeaves("escaped", true, DateTimeOffset.UtcNow.AddMinutes(-5)).Contains(path)
                && !store.SourceOwnership("escaped").Single().Pruned, name + " escaped source reference survives pruning");
            reject(() => store.PreviewSourceMigration("escaped", saved["revision"]!.GetValue<int>(),
                settings with { Mqtt = settings.Mqtt! with { Mappings = [mapping with { Root = "[default]Renamed" }] } }), name + " escaped source reference migration");
            File.Delete(resource);
        }
        check(store.DeleteTag(path) && store.SourceOwnership("escaped").Single().Suppressed,
            "removing all escaped project references permits explicit source deletion");
    }

    private static async Task CommandGuards(ProjectCatalog catalog, string directory, ConnectorService connectors, Action<bool, string> check, Func<Func<Task>, string, Task> reject)
    {
        var workspace = catalog.Create("Source command guards");
        var command = new JsonObject { ["id"] = "blocked", ["name"] = "Read source cannot command", ["tagPath"] = "[default]ReadSources/Direct",
            ["dataType"] = "Int64", ["min"] = 0d, ["max"] = 100d, ["confirmation"] = "Synthetic command", ["timeoutMs"] = 100 };
        var project = workspace.Store.GetProject(); project["commands"] = new JsonArray(command.DeepClone()); workspace.Store.SaveProject(project);
        var stamp = workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
        var security = new SecurityStore(directory);
        var admin = security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("source-admin", "Synthetic-source-guard-password-123"));
        security.UpdateSettings(new(security.Settings.Revision, null, new() { [workspace.Id] = ["[default]ReadSources/"] }));
        var context = new DefaultHttpContext(); context.Items["spark.actor"] = admin; context.Items["spark.project"] = workspace.Id; context.Items["spark.audience"] = "operator";
        using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
        var commands = new EquipmentCommands(connectors, tags, security, new RecoveryQuarantine(directory));
        await reject(() => commands.Review(context, workspace.Store, workspace.Publication, "blocked", new(stamp, JsonSerializer.SerializeToElement(1)), default), "equipment review of source value");
        command["value"] = 1;
        await reject(() => commands.ReviewNative(context, workspace.Store, "native-source-write", stamp,
            _ => Task.FromResult(command), default), "native/terminal equipment review of source value");
        await reject(() => commands.Execute(context, workspace.Store, workspace.Publication, "blocked", new("forged-ticket", true), default), "forged equipment execution");
        check(tags.Read(["[default]ReadSources/Direct"], null).All(value => !value.Writable), "runtime source tag remains read-only");
    }

    private static async Task Ownership(string directory, IDataProtectionProvider protection, Action<bool, string> check,
        Action<Action, string> reject, Func<Func<Task>, string, Task> rejectAsync)
    {
        var data = Path.Combine(directory, "ownership"); var store = new ProjectStore(data, protection, gatewayOnly: true);
        var mapping = new SourceMqttMapping("tree", "factory/#", "[default]Auto", Tags: "automatic", PruneAfterSeconds: 1);
        var settings = Mqtt(mapping); var saved = store.SaveConnection(Connection("mqtt", "mqtt", settings));
        SourceDiscoveryItem Item(string topic, string type = "Int64") => new("tree", topic, null, topic, type, SourceConfiguration.TopicPath(mapping, topic), 1L);
        check(store.ApplySourceDiscovery("mqtt", [Item("factory/value")]) == 1 && store.SourceOwnership("mqtt").Single().DataType == "Int64", "zero-tag automatic discovery creates first owned definition");
        var identity = store.SourceOwnership("mqtt").Single();
        var stableDisk = File.ReadAllBytes(Path.Combine(data, "source-discovery.json"));
        await Task.Delay(20);
        for (var iteration = 0; iteration < 100; iteration++) store.ApplySourceDiscovery("mqtt", [Item("factory/value")]);
        check(store.SourceOwnership("mqtt").Single().LastSeen > identity.LastSeen && stableDisk.SequenceEqual(File.ReadAllBytes(Path.Combine(data, "source-discovery.json"))),
            "known automatic traffic advances observation time while coalescing persistent writes");
        check(identity.PointId == SourceConfiguration.PointId("mqtt", "tree", identity.Address, null) && store.GetConnection("mqtt").Source!.SavedPoints.Single().Id == identity.PointId,
            "owned raw identity resolves through common point catalog");
        reject(() => store.ApplySourceDiscovery("mqtt", [Item("factory/value", "Double")]), "owned locked type changes");
        reject(() => store.ApplySourceDiscovery("mqtt", [Item("factory/value") with { Shape = "structure" }]), "owned locked shape changes");
        reject(() => store.ApplySourceDiscovery("mqtt", [Item("factory/value") with { SuggestedPath = "[default]Forged/Value" }]), "known automatic fast path forged identity/path");
        reject(() => store.SaveTag(new JsonObject { ["path"] = "[default]Auto/Authored", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 }), "authored tag inside owned automatic root");
        var collision = new SourceMqttMapping("tree", "factory/#", "[default]Collision", Tags: "automatic");
        store.SaveConnection(Connection("collision", "mqtt", Mqtt(collision)));
        SourceDiscoveryItem CollisionItem(string topic) => new("tree", topic, null, topic, "Int64", SourceConfiguration.TopicPath(collision, topic), 1L);
        store.ApplySourceDiscovery("collision", [CollisionItem("factory/a[b]")]);
        reject(() => store.ApplySourceDiscovery("collision", [CollisionItem("factory/a_b_")]), "sanitizer collision between distinct raw topics");
        check(store.SourceOwnership("collision").Length == 1 && store.SourceOwnership("collision")[0].Address == "factory/a[b]", "collision leaves original authored identity unchanged");
        check(store.DeleteTag(identity.Path), "owned manual deletion creates suppression");
        check(store.ApplySourceDiscovery("mqtt", [Item("factory/value")]) == 0 && store.SourceOwnership("mqtt").Single().Suppressed, "next traffic cannot recreate suppressed definition");
        var restarted = new ProjectStore(data, protection, gatewayOnly: true);
        check(restarted.SourceOwnership("mqtt").Single().Suppressed && restarted.SourceOwnership("mqtt").Single().PointId == identity.PointId, "restart preserves stable identity, locked type and suppression");
        restarted.ClearSourceSuppression("mqtt", identity.PointId);
        check(restarted.ApplySourceDiscovery("mqtt", [Item("factory/value")]) == 1 && restarted.SourceOwnership("mqtt").Single().PointId == identity.PointId, "explicit suppression clear permits stable rediscovery");
        var storedState = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json")))!.AsObject();
        storedState["leaves"]!.AsArray().OfType<JsonObject>().Single(leaf => leaf["pointId"]!.GetValue<string>() == identity.PointId)["lastSeen"] = DateTimeOffset.UtcNow.AddMinutes(-5);
        File.WriteAllText(Path.Combine(data, "source-discovery.json"), storedState.ToJsonString(ProjectStore.Json));
        restarted = new ProjectStore(data, protection, gatewayOnly: true);
        check(restarted.PruneSourceLeaves("mqtt", false, DateTimeOffset.UtcNow.AddMinutes(-5)).Length == 0 && !restarted.SourceOwnership("mqtt").Single().Pruned,
            "transport down cannot prune owned definitions");
        check(restarted.PruneSourceLeaves("mqtt", true, DateTimeOffset.UtcNow.AddMinutes(-5)).Contains(identity.Path) && restarted.SourceOwnership("mqtt").Single().Pruned,
            "healthy absence window prunes only eligible owned point");
        check(restarted.ApplySourceDiscovery("mqtt", [Item("factory/value")]) == 1 && restarted.SourceOwnership("mqtt").Single().PointId == identity.PointId, "pruned identity/type survives later rediscovery");
        restarted.SaveTag(Tag("[default]References/OwnedAlias", "mqtt", identity.PointId));
        var referencedState = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json")))!.AsObject();
        referencedState["leaves"]!.AsArray().OfType<JsonObject>().Single(leaf => leaf["pointId"]!.GetValue<string>() == identity.PointId)["lastSeen"] = DateTimeOffset.UtcNow.AddMinutes(-5);
        File.WriteAllText(Path.Combine(data, "source-discovery.json"), referencedState.ToJsonString(ProjectStore.Json));
        restarted = new ProjectStore(data, protection, gatewayOnly: true);
        check(restarted.PruneSourceLeaves("mqtt", true, DateTimeOffset.UtcNow.AddMinutes(-5)).Contains(identity.Path) && !restarted.SourceOwnership("mqtt").Single().Pruned,
            "referenced leaf survives healthy absence and reports its no-data path");
        reject(() => restarted.DeleteTag(identity.Path), "owned suppression with authored point reference");
        var archive = Path.Combine(directory, "source-configuration.sparkbackup");
        await ConfigurationBackupSnapshot.CreateAsync(data, archive, "Synthetic-source-backup-passphrase-123");
        var restoredPath = Path.Combine(directory, "restored-source"); await GatewayRecovery.RestoreAsync(archive, restoredPath, "Synthetic-source-backup-passphrase-123");
        var restored = new ProjectStore(restoredPath, protection, gatewayOnly: true);
        check(File.Exists(Path.Combine(restoredPath, "source-discovery.json")) && restored.SourceOwnership("mqtt").Single().PointId == identity.PointId
            && restored.SourceOwnership("mqtt").Single().DataType == "Int64", "configuration backup/restore includes validated ownership before new traffic");
        // Model an interruption after the recoverable manifest write, before its two files.
        var journal = new JsonObject { ["version"] = 1, ["connections"] = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "connections.json"))),
            ["discovery"] = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json"))) };
        File.WriteAllText(Path.Combine(data, "source-config-commit.json"), journal.ToJsonString(ProjectStore.Json));
        File.WriteAllText(Path.Combine(data, "connections.json"), "[]");
        var recovered = new ProjectStore(data, protection, gatewayOnly: true);
        check(!File.Exists(Path.Combine(data, "source-config-commit.json")) && recovered.SourceOwnership("mqtt").Single().PointId == identity.PointId
            && recovered.GetConnection("mqtt").Source is not null, "crash manifest restores matching connection/ownership generation atomically");
        var corrupt = Path.Combine(directory, "corrupt-source"); Directory.CreateDirectory(corrupt);
        File.Copy(Path.Combine(data, "connections.json"), Path.Combine(corrupt, "connections.json"));
        var corruptState = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json")))!.AsObject();
        corruptState["leaves"]![0]!["mappingFingerprint"] = "unknown-schema";
        File.WriteAllText(Path.Combine(corrupt, "source-discovery.json"), corruptState.ToJsonString(ProjectStore.Json));
        reject(() => new ProjectStore(corrupt, protection, gatewayOnly: true), "restored mapping/schema mismatch before acquisition");
        corruptState = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json")))!.AsObject();
        corruptState["leaves"]![0]!["path"] = "[default]ForgedRestore/Value";
        File.WriteAllText(Path.Combine(corrupt, "source-discovery.json"), corruptState.ToJsonString(ProjectStore.Json));
        reject(() => new ProjectStore(corrupt, protection, gatewayOnly: true), "restored valid-looking path inconsistent with raw mapping identity");
        var capPath = Path.Combine(directory, "capacity"); var cap = new ProjectStore(capPath, protection, gatewayOnly: true);
        cap.SaveConnection(Connection("cap", "mqtt", Mqtt(mapping)));
        var package = new JsonObject { ["format"] = "sparkstudio.tags", ["version"] = 1,
            ["tags"] = new JsonArray(Enumerable.Range(0, 9999).Select(index => (JsonNode)new JsonObject { ["path"] = "[default]Authored/P" + index,
                ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 }).ToArray()) };
        var preview = cap.PreviewTagImport(package); cap.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
        var winners = await Task.WhenAll(Enumerable.Range(0, 2).Select(index => Task.Run(() => {
            try { return cap.ApplySourceDiscovery("cap", [Item("factory/race" + index)]); } catch (SourceLimitException) { return 0; }
        })));
        check(winners.Sum() == 1 && cap.GetTagDefinitions().Count == 10000 && cap.SourceOwnership().Length == 1,
            "concurrent discovery shares expanded10000 cap with authored definitions");
        var capBefore = File.ReadAllBytes(Path.Combine(capPath, "source-discovery.json"));
        reject(() => cap.ApplySourceDiscovery("cap", [Item("factory/no1"), Item("factory/no2")]), "over-cap whole discovery batch");
        check(capBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(capPath, "source-discovery.json"))), "failed capacity batch commits no partial ownership");
        var capacityPackage = cap.ExportTags();
        capacityPackage["tags"]!.AsArray().Add(new JsonObject { ["path"] = "[default]Authored/OverCapacity", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 });
        check(!cap.PreviewTagImport(capacityPackage).CanApply, "engineering preview includes owned definitions in the expanded10000 capacity guard");

        var removalPath = Path.Combine(directory, "removed-mapping"); var removal = new ProjectStore(removalPath, protection, gatewayOnly: true);
        var removedMapping = new SourceMqttMapping("removed-tree", "factory/#", "[default]Removed", Tags: "automatic", StripLevels: 1);
        var removalSaved = removal.SaveConnection(Connection("removed", "mqtt", Mqtt(removedMapping)));
        var removedItem = new SourceDiscoveryItem("removed-tree", "factory/pressure", null, "Pressure", "Int64", "[default]Removed/pressure", 1L);
        removal.ApplySourceDiscovery("removed", [removedItem]); var removedIdentity = removal.SourceOwnership("removed").Single();
        var noMappings = removal.GetConnection("removed").Source! with { Points = [], Mqtt = removal.GetConnection("removed").Source!.Mqtt! with { Mappings = [] } };
        var migration = Node(removal.PreviewSourceMigration("removed", removalSaved["revision"]!.GetValue<int>(), noMappings));
        removalSaved["source"] = JsonSerializer.SerializeToNode(noMappings, ProjectStore.Json); removalSaved["sourceMigrationToken"] = migration["token"]!.GetValue<string>();
        removal.SaveConnection(removalSaved);
        var removedRestart = new ProjectStore(removalPath, protection, gatewayOnly: true); var historical = removedRestart.SourceOwnership("removed").Single();
        check(historical.MappingRemoved && historical.Suppressed && historical.PointId == removedIdentity.PointId && historical.HistoricalRoot == removedMapping.Root
            && historical.HistoricalStripLevels == 1 && historical.Path == removedIdentity.Path, "removed mapping retains a restart-validated historical path/schema tombstone");
        var wrongHistory = Path.Combine(directory, "wrong-historical-schema"); Directory.CreateDirectory(wrongHistory);
        File.Copy(Path.Combine(removalPath, "connections.json"), Path.Combine(wrongHistory, "connections.json"));
        var historyState = JsonNode.Parse(File.ReadAllText(Path.Combine(removalPath, "source-discovery.json")))!.AsObject();
        historyState["leaves"]![0]!["historicalRoot"] = "[default]WrongRoot";
        File.WriteAllText(Path.Combine(wrongHistory, "source-discovery.json"), historyState.ToJsonString(ProjectStore.Json));
        reject(() => new ProjectStore(wrongHistory, protection, gatewayOnly: true), "historical tombstone path outside its retained removed mapping schema");
    }

    private static async Task Lifecycle(string directory, Action<bool, string> check, Func<Func<Task>, string, Task> reject)
    {
        var sessions = new ConcurrentQueue<FakeSource>();
        using var connectors = new ConnectorService(Path.Combine(directory, "lifecycle"), sourceFactory: connection => { var session = new FakeSource(connection); sessions.Enqueue(session); return session; });
        var mapping = new SourceMqttMapping("review", "factory/#", "[default]Review");
        var connection = new ConnectionDefinition("lifecycle", "Lifecycle", "mqtt", Source: Mqtt(mapping));
        var sink = new RecordingSink();
        await connectors.SynchronizeSourcesAsync([connection], 1, _ => sink, default);
        var source = sessions.Single();
        check(source.Starts == 1 && source.Current!.Bindings.Points.Count == 0, "zero-tag/zero-point source creates exactly one acquisition owner");
        check((await connectors.TestSourceAsync(connection, default)).Success, "Test does not hold lifetime-monitor operation gate");
        var revision = source.Current!.Bindings.Revision; var generation = source.Current.Generation;
        source.Discover(new("review", "factory/first", null, "First", "Int64", "[default]Review/factory/first", 1L));
        check(sink.Discoveries.Count == 1, "first zero-tag message reaches owner discovery sink");
        var points = Enumerable.Range(0, 2500).Select(index => new SourcePoint("p" + index, "Point" + index, "factory/p" + index, "Int64", MappingId: "review")).ToArray();
        var configured = connection with { Source = connection.Source! with { Points = points } };
        await connectors.SynchronizeSourcesAsync([configured], 2, _ => sink, default);
        check(sessions.Count == 1 && source.Starts == 1 && source.Updates == 1 && source.Current.Bindings.Points.Count == 2500,
            "2500 points use one transport with hot binding update");
        source.Emit("p0", 1L, generation, revision);
        check(sink.Values.Count == 0, "retired binding callback is fenced at owner bridge");
        source.Emit("p0", 2L);
        check(sink.Values.Single().Value is 2L, "active revision accepted");
        connectors.FenceSourceBindings(connection.Id);
        source.Emit("p0", 3L);
        check(sink.Values.Count == 1, "immediate definition fence blocks queued old Good result");
        await connectors.SynchronizeSourcesAsync([configured], 3, _ => sink, default);
        source.Emit("p0", 4L);
        check(sink.Values.Last().Value is 4L && sessions.Count == 1, "compatible fence revision resumes without reconnect");
        source.FailNextUpdate = true;
        var candidatePoints = points.Select(point => point with { Name = point.Name + "Candidate" }).ToArray();
        await connectors.SynchronizeSourcesAsync([configured with { Source = configured.Source! with { Points = candidatePoints } }], 4, _ => sink, default);
        source.Emit("p0", 55L);
        check(sink.Values.Last().Value is 4L && sink.Statuses.Any(status => status.Reason == "binding-reconciliation" && status.State == "degraded"),
            "failed binding candidate is visible and compensated prior callbacks remain fenced until confirmed resume");
        var clock = Stopwatch.StartNew(); await connectors.SynchronizeSourcesAsync([], 4, _ => sink, default);
        check(source.Disposed == 1 && source.Stops == 1 && clock.Elapsed < TimeSpan.FromSeconds(2), "disable/delete releases monitor and session within2seconds");
        source.Emit("p0", 5L);
        check(sink.Values.Last().Value is 4L, "retired connection callbacks apply zero writes");

        var catalog = new ProjectCatalog(Path.Combine(directory, "tag-engine"), new EphemeralDataProtectionProvider());
        var automatic = new SourceMqttMapping("auto", "factory/#", "[default]EngineAuto", Tags: "automatic", MaximumTags: 2);
        var saved = catalog.GatewayStore.SaveConnection(Connection("engine-source", "mqtt", Mqtt(automatic)));
        var engineSessions = new ConcurrentQueue<FakeSource>();
        using var engineConnectors = new ConnectorService(Path.Combine(directory, "tag-engine"), sourceFactory: current => { var session = new FakeSource(current); engineSessions.Enqueue(session); return session; });
        using var engine = new TagEngine(catalog.GatewayStore, engineConnectors, NullLogger<TagEngine>.Instance);
        await engine.StartAsync(default);
        try
        {
            await Until(() => engineSessions.Count == 1 && engineSessions.Single().Starts == 1, "connection-owned zero-tag engine monitor");
            var fake = engineSessions.Single();
            fake.Discover(new("auto", "factory/value", null, "Value", "Int64", "[default]EngineAuto/factory/value", 11L));
            try { await Until(() => catalog.GatewayStore.SourceOwnership().Length == 1 && fake.Current!.Bindings.Points.Count == 1, "owned definition expansion/hot binding"); }
            catch (TimeoutException) { throw new InvalidOperationException("Owned fixture state: " + JsonSerializer.Serialize(new { ownership = catalog.GatewayStore.SourceOwnership(),
                sessions = engineSessions.Count, fake.Starts, fake.Updates, bindings = fake.Current, execute = engine.ExecuteTask?.Exception?.ToString(), engine = engine.SourceSnapshot("engine-source") }, ProjectStore.Json)); }
            var owned = catalog.GatewayStore.SourceOwnership().Single();
            fake.Emit(owned.PointId, 12L);
            await Until(() => engine.Read([owned.Path], null).Single().Value is 12L, "engine source point value");
            check(engine.Read([owned.Path], null).Single().Writable == false && engineSessions.Count == 1, "source-owned value flows to runtime with read-only attribution and one transport");
            check(await fake.PublishAsync([new(owned.PointId, 13L, "Int64", "Good")], []), "publication accepts current generation and binding revision");
            check(engine.Read([owned.Path], null).Single().Value is 13L && fake.PublishedCache[owned.PointId] is 13L,
                "accepted publication commits gateway value and source cache together");
            check(!await fake.PublishAsync([new(owned.PointId, 777L, "Int64", "Good")], [], () => false)
                && engine.Read([owned.Path], null).Single().Value is 13L && fake.PublishedCache[owned.PointId] is 13L,
                "retired transport commit fence is rechecked under the atomic publication lock");
            var before = File.ReadAllBytes(Path.Combine(directory, "tag-engine", "source-discovery.json"));
            var colliding = new SourceDiscoveryItem("auto", "factory/other", null, "Other", "Int64", owned.Path, 99L);
            check(!await fake.PublishAsync([new(owned.PointId, 99L, "Int64", "Good")], [colliding]), "publication rejects raw identity/path collision");
            check(engine.Read([owned.Path], null).Single().Value is 13L && fake.PublishedCache[owned.PointId] is 13L
                && before.SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "tag-engine", "source-discovery.json"))),
                "collision commits neither prior value nor source cache nor persistent discovery");
            var overCap = new[] { new SourceDiscoveryItem("auto", "factory/new1", null, "New1", "Int64", "[default]EngineAuto/factory/new1", 1L),
                new SourceDiscoveryItem("auto", "factory/new2", null, "New2", "Int64", "[default]EngineAuto/factory/new2", 2L) };
            check(!await fake.PublishAsync([new(owned.PointId, 999L, "Int64", "Good")], overCap), "publication rejects automatic mapping leaf cap atomically");
            check(engine.Read([owned.Path], null).Single().Value is 13L && fake.PublishedCache[owned.PointId] is 13L
                && catalog.GatewayStore.SourceOwnership().Length == 1 && before.SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "tag-engine", "source-discovery.json"))),
                "over-cap publication commits no values, cache, partial leaf, or persistence");
            check(Node(engine.SourceSnapshot("engine-source"))["state"]!["reason"]!.GetValue<string>() == "publication-rejected",
                "transactional publication rejection remains visible in diagnostics");
            check(await fake.PublishAsync([new(owned.PointId, 14L, "Int64", "Good")], []) && engine.Read([owned.Path], null).Single().Value is 14L,
                "a rejected publication does not poison later valid publications");
            saved["enabled"] = false; engine.SaveConnection(saved);
            await Until(() => fake.Disposed == 1, "disabled engine owner cleanup");
            check(engine.Read([owned.Path], null).Single().Quality == "Bad_Disabled", "disabled owned definition retained with bad quality");
            var disabledSnapshot = Node(engine.SourceSnapshot("engine-source"));
            check(disabledSnapshot["state"]!["state"]!.GetValue<string>() == "disabled"
                && disabledSnapshot["transport"]!["state"]!.GetValue<string>() == "disabled",
                "disabled source diagnostics remain disabled after owner cleanup rather than retaining connected status");
            fake.Emit(owned.PointId, 99L);
            check(engine.Read([owned.Path], null).Single().Value is not 99L, "late disabled Good callback cannot overwrite engine state");
        }
        finally { await engine.StopAsync(default); }
    }

    private static JsonObject Connection(string id, string type, SourceSettings source) => new() { ["id"] = id, ["name"] = id, ["type"] = type, ["source"] = JsonSerializer.SerializeToNode(source, ProjectStore.Json) };
    private static async Task MailboxTransfer(string directory, Action<bool, string> check)
    {
        var data = Path.Combine(directory, "mailbox-transfer"); var store = new ProjectStore(data, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var points = Enumerable.Range(0, 4).Select(index => new SourcePoint("p" + index, "P" + index, "opaque#" + index, "Int64")).ToArray();
        var settings = new SourceSettings("http://127.0.0.1/v1", Points: points, Limits: new(StateBytes: 1024));
        store.SaveConnection(Connection("a", "i3x", settings)); store.SaveConnection(Connection("b", "i3x", settings));
        const string path = "[default]Transfer/P"; store.SaveTag(Tag(path, "a", "p0"));
        var sessions = new ConcurrentDictionary<string, FakeSource>(StringComparer.Ordinal);
        using var connectors = new ConnectorService(data, sourceFactory: connection => { var session = new FakeSource(connection); sessions[connection.Id] = session; return session; });
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance); await engine.StartAsync(default);
        try {
            await Until(() => sessions.Count == 2 && sessions.Values.All(session => session.Current is not null), "mailbox transfer acquisition owners");
            var a = sessions["a"]; var b = sessions["b"];
            check(await a.PublishAsync([new("p0", 1L, "Int64", "Good")], []) && engine.Read([path], null).Single().Source == "a:p0", "first source charges the path's mailbox owner");
            var before = b.Current!.Bindings.Revision; engine.SaveDefinition(Tag(path, "b", "p0"));
            for (var index = 1; index < 4; index++) engine.SaveDefinition(Tag("[default]Transfer/B" + index, "b", "p" + index));
            await Until(() => b.Current!.Bindings.Revision > before, "reassignment binding revision");
            check(await b.PublishAsync([new("p0", 2L, "Int64", "Good"), new("p1", 3L, "Int64", "Good"), new("p2", 4L, "Int64", "Good")], []),
                "source reassignment accepts three values within the new owner's1024byte mailbox");
            check(engine.Read([path], null).Single() is { Source: "b:p0", Value: 2L }, "same display path acquires new source attribution atomically");
            check(!await b.PublishAsync([new("p3", 5L, "Int64", "Good")], []) && engine.Read(["[default]Transfer/B3"], null).Single().Value is not 5L,
                "transferred value counts against destination limit before a fourth value is admitted");
            before = a.Current!.Bindings.Revision;
            for (var index = 1; index < 4; index++) engine.SaveDefinition(Tag("[default]Transfer/A" + index, "a", "p" + index));
            await Until(() => a.Current!.Bindings.Revision > before, "prior owner's replacement bindings");
            check(await a.PublishAsync([new("p1", 6L, "Int64", "Good"), new("p2", 7L, "Int64", "Good"), new("p3", 8L, "Int64", "Good")], []),
                "source reassignment releases the old owner's value charge before later admission");
        } finally { await engine.StopAsync(default); }
    }
    private static async Task DiscoveryHealth(string directory, Action<bool, string> check)
    {
        var data = Path.Combine(directory, "discovery-health"); var protection = new EphemeralDataProtectionProvider();
        var original = new ProjectStore(data, protection, gatewayOnly: true);
        var mapping = new SourceMqttMapping("health", "factory/#", "[default]Health", Tags: "automatic", PruneAfterSeconds: 2);
        original.SaveConnection(Connection("health", "mqtt", Mqtt(mapping)));
        var oldItem = new SourceDiscoveryItem("health", "factory/old", null, "Old", "Int64", "[default]Health/factory/old", 1L);
        original.ApplySourceDiscovery("health", [oldItem]);
        var state = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json")))!.AsObject();
        state["leaves"]![0]!["lastSeen"] = DateTimeOffset.UtcNow.AddMinutes(-5);
        File.WriteAllText(Path.Combine(data, "source-discovery.json"), state.ToJsonString(ProjectStore.Json));
        var store = new ProjectStore(data, protection, gatewayOnly: true); FakeSource? session = null;
        using var connectors = new ConnectorService(data, sourceFactory: connection => session = new FakeSource(connection));
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance); await engine.StartAsync(default);
        try {
            await Until(() => session?.Current is not null, "pruning health source owner"); var fake = session!;
            var old = store.SourceOwnership("health").Single();
            check(!await fake.PublishAsync([], [oldItem with { DataType = "Double" }]), "automatic type-lock failure rejects an entire publication");
            fake.Status("connected"); await Task.Delay(2500);
            check(!store.SourceOwnership("health").Single().Pruned && Node(engine.SourceSnapshot("health"))["state"]!["state"]!.GetValue<string>() == "degraded",
                "periodic transport-connected status cannot restore pruning health after admission failure");
            var next = new SourceDiscoveryItem("health", "factory/new", null, "New", "Int64", "[default]Health/factory/new", 2L);
            var nextPoint = SourceConfiguration.PointId("health", "health", next.Address, null);
            check(await fake.PublishAsync([new(nextPoint, 2L, "Int64", "Good")], [next]), "valid complete publication resumes automatic observation after rejection");
            await Until(() => fake.Current!.Bindings.Points.Count == 2, "new healthy automatic hot binding"); fake.Status("connected");
            await Task.Delay(1000);
            check(!store.SourceOwnership("health").Single(leaf => leaf.PointId == old.PointId).Pruned, "healthy pruning window restarts at recovery rather than inheriting pre-failure uptime");
            await Until(() => store.SourceOwnership("health").Single(leaf => leaf.PointId == old.PointId).Pruned, "eligible leaf prunes after the new healthy observation window");
            check(store.SourceOwnership("health").Single(leaf => leaf.PointId == old.PointId).Pruned, "recovered healthy absence eventually prunes eligible owned leaf");
        } finally { await engine.StopAsync(default); }
    }
    private static async Task PruneConfigurationRace(string directory, Action<bool, string> check)
    {
        var data = Path.Combine(directory, "prune-configuration-race"); var protection = new EphemeralDataProtectionProvider();
        var catalog = new ProjectCatalog(data, protection); var store = catalog.GatewayStore;
        var mapping = new SourceMqttMapping("race", "factory/#", "[default]PruneRace", Tags: "automatic", PruneAfterSeconds: 1);
        store.SaveConnection(Connection("race", "mqtt", Mqtt(mapping)));
        store.ApplySourceDiscovery("race", [new("race", "factory/value", null, "Value", "Int64", "[default]PruneRace/factory/value", 1L)]);
        var state = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "source-discovery.json")))!.AsObject();
        state["leaves"]![0]!["lastSeen"] = DateTimeOffset.UtcNow.AddMinutes(-5);
        File.WriteAllText(Path.Combine(data, "source-discovery.json"), state.ToJsonString(ProjectStore.Json));
        // Reload so the source has an eligible expired leaf, then model a lifecycle
        // snapshot retaining healthy status after the durable configuration changes.
        catalog = new ProjectCatalog(data, protection); store = catalog.GatewayStore;
        var disabled = store.GetConnections().OfType<JsonObject>().Single().DeepClone().AsObject();
        disabled["enabled"] = false; disabled = store.SaveConnection(disabled);
        var before = File.ReadAllBytes(Path.Combine(data, "source-discovery.json"));
        check(store.PruneSourceLeaves("race", true, DateTimeOffset.UtcNow.AddMinutes(-5)).Length == 0
            && !store.SourceOwnership("race").Single().Pruned && before.SequenceEqual(File.ReadAllBytes(Path.Combine(data, "source-discovery.json"))),
            "stale healthy pruning snapshot skips a disabled source and preserves its owned definitions");
        using var connectors = new ConnectorService(data);
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        await engine.DeleteConnectionAsync("race", disabled["revision"]!.GetValue<int>(), catalog);
        check(store.PruneSourceLeaves("race", true, DateTimeOffset.UtcNow.AddMinutes(-5)).Length == 0
            && store.SourceOwnership("race").Length == 0,
            "stale healthy pruning snapshot skips a deleted source without throwing");
    }
    private static async Task HeldLifecycleDisable(string directory, Action<bool, string> check)
    {
        var data = Path.Combine(directory, "held-lifecycle-disable");
        var store = new ProjectStore(data, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var point = new SourcePoint("reading", "Reading", "opaque#reading", "Int64");
        var settings = new SourceSettings("http://127.0.0.1/v1", Points: [point]);
        var a = store.SaveConnection(Connection("a", "i3x", settings));
        store.SaveConnection(Connection("b", "i3x", settings));
        const string pathA = "[default]Race/A", pathB = "[default]Race/B";
        store.SaveTag(Tag(pathA, "a", point.Id)); store.SaveTag(Tag(pathB, "b", point.Id));
        var sessions = new ConcurrentDictionary<string, FakeSource>(StringComparer.Ordinal);
        using var connectors = new ConnectorService(data, sourceFactory: connection => {
            var source = new FakeSource(connection); sessions[connection.Id] = source; return source;
        });
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        await engine.StartAsync(default); TaskCompletionSource? release = null;
        try
        {
            await Until(() => sessions.TryGetValue("a", out var first) && first.Current is not null
                && sessions.TryGetValue("b", out var second) && second.Current is not null, "both lifecycle race source owners");
            var first = sessions["a"]; var second = sessions["b"]; var generation = second.Current!.Generation;
            check(await second.PublishAsync([new(point.Id, 1L, "Int64", "Good")], []), "unrelated owner publishes before lifecycle race");
            first.BindingUpdateEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            release = first.BindingUpdateRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
            a["source"]!["points"]![0]!["name"] = "Renamed during remote registration"; a = engine.SaveConnection(a);
            await first.BindingUpdateEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            a["enabled"] = false; engine.SaveConnection(a); release.TrySetResult();
            await Until(() => first.Disposed == 1, "disabled held source retires");
            await Task.Delay(700); // Allow another full source synchronization and pruning pass.
            check(second.Disposed == 0 && second.Current!.Generation == generation && sessions.Count == 2
                && Node(engine.SourceSnapshot("b"))["acquisitionFailure"] is null && engine.ExecuteTask?.IsFaulted != true,
                "disabling a source during awaited registration preserves the unrelated owner and healthy acquisition loop");
            check(await second.PublishAsync([new(point.Id, 2L, "Int64", "Good")], [])
                && engine.Read([pathB], null).Single().Value is 2L && engine.Read([pathA], null).Single().Quality == "Bad_Disabled",
                "unrelated source continues publishing after the stale enabled-connection snapshot is discarded");
        }
        finally { release?.TrySetResult(); await engine.StopAsync(default); }
    }
    private static void SourceSaveFailure(string directory, Action<bool, string> check)
    {
        var data = Path.Combine(directory, "source-save-failure"); var protection = new EphemeralDataProtectionProvider();
        var store = new ProjectStore(data, protection, gatewayOnly: true);
        var point = new SourcePoint("exact", "Committed point", "opaque#exact", "Int64");
        var settings = new SourceSettings("http://127.0.0.1/v1", Points: [point], Authentication: new("basic", "fixture", "Committed-source-secret-123"));
        var saved = store.SaveConnection(Connection("a", "i3x", settings));
        store.SaveConnection(Connection("b", "i3x", settings));
        store.SaveTag(Tag("[default]SaveFailure/A", "a", point.Id)); store.SaveTag(Tag("[default]SaveFailure/B", "b", point.Id));
        _ = store.GetConnection("a"); _ = store.GetConnection("b");
        var before = store.GetConnections().ToJsonString(ProjectStore.Json); var generation = store.TagConfigurationGeneration;
        var committedPath = Path.Combine(data, "connections.json"); var preservedPath = Path.Combine(data, "connections.preserved.json");
        var committed = File.ReadAllBytes(committedPath);
        saved["source"]!["points"]![0]!["name"] = "Uncommitted candidate point";
        saved["source"]!["authentication"]!["password"] = "Uncommitted-source-secret-456";
        // A directory at the replacement destination rejects the atomic rename
        // on every supported OS; retain the original bytes in this isolated fixture.
        File.Move(committedPath, preservedPath); Directory.CreateDirectory(committedPath);
        var rejected = false;
        try { store.SaveConnection(saved); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { rejected = true; }
        finally { Directory.Delete(committedPath); File.Move(preservedPath, committedPath); }
        check(rejected && store.GetConnections().ToJsonString(ProjectStore.Json) == before && store.TagConfigurationGeneration == generation,
            "failed durable source replacement commits no configuration or revision changes");
        check(store.GetConnection("a").Source!.SavedPoints.Single().Name == point.Name
            && store.GetConnection("a").Source!.Authentication!.Password == "Committed-source-secret-123"
            && store.GetConnection("b").Source!.SavedPoints.Single().Name == point.Name,
            "failed source save retains the previous point catalog, protected credentials and unrelated source");
        check(committed.SequenceEqual(File.ReadAllBytes(committedPath)) && !Directory.EnumerateFiles(data, "connections.json.*.tmp").Any(),
            "failed atomic replacement leaves no temporary file and preserves the committed bytes");
        var restarted = new ProjectStore(data, protection, gatewayOnly: true);
        check(restarted.GetConnections().ToJsonString(ProjectStore.Json) == before && restarted.GetConnection("a").Source!.Authentication!.Password == "Committed-source-secret-123"
            && restarted.GetTagDefinitions().Count == 2, "restart loads the prior source generation and bindings after a rejected save");
        var success = restarted.SaveConnection(saved);
        var again = new ProjectStore(data, protection, gatewayOnly: true);
        check(success["revision"]!.GetValue<int>() == saved["revision"]!.GetValue<int>() + 1
            && again.GetConnection("a").Source!.SavedPoints.Single().Name == "Uncommitted candidate point"
            && again.GetConnection("a").Source!.Authentication!.Password == "Uncommitted-source-secret-456"
            && again.GetConnection("b").Source!.SavedPoints.Single().Name == point.Name && again.GetTagDefinitions().Count == 2,
            "successful retry durably commits only the edited source while preserving unrelated source bindings");
    }
    private static async Task OwnedUdtImport(string directory, Action<bool, string> check, Action<Action, string> reject)
    {
        var data = Path.Combine(directory, "owned-udt-import");
        var store = new ProjectStore(data, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var mapping = new SourceMqttMapping("model", "factory/#", "[default]OwnedUdt", Tags: "automatic");
        store.SaveConnection(Connection("owned", "mqtt", Mqtt(mapping)));
        var item = new SourceDiscoveryItem("model", "factory/value", null, "Value", "Int64", "[default]OwnedUdt/factory/value", 1L);
        store.ApplySourceDiscovery("owned", [item]); var owned = store.SourceOwnership().Single();
        FakeSource? session = null;
        using var connectors = new ConnectorService(data, sourceFactory: connection => session = new FakeSource(connection));
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance); await engine.StartAsync(default);
        try
        {
            await Until(() => session?.Current?.Bindings.Points.Count == 1, "owned UDT import source owner"); var fake = session!;
            check(await fake.PublishAsync([new(owned.PointId, 9007199254740993L, "Int64", "Good")], []), "owned source has a live value before engineering import");
            var initial = engine.Read([owned.Path], null).Single();
            var changes = new ConcurrentQueue<TagValue>(); engine.ValueChanged += (_, value) => { if (value.Path == owned.Path) changes.Enqueue(value); };
            var colliding = store.ExportTags();
            colliding["tags"]!.AsArray().Add(new JsonObject { ["path"] = owned.Path, ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 });
            check(!store.PreviewTagImport(colliding).CanApply, "engineering preview rejects authored replacement of a source-owned definition below the tag cap");
            var package = store.ExportTags();
            package["udtDefinitions"]!.AsArray().Add(new JsonObject { ["id"] = "ImportedModel", ["version"] = 1,
                ["members"] = new JsonArray(new JsonObject { ["path"] = "Counter", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 }) });
            package["instances"]!.AsArray().Add(new JsonObject { ["path"] = "[default]AuthoredUdt/One", ["definitionId"] = "ImportedModel", ["version"] = 1, ["overrides"] = new JsonObject() });
            var preview = store.PreviewTagImport(package);
            check(preview.CanApply && preview.TotalTags == 2 && preview.Changes.All(change => change.Path != owned.Path),
                "UDT import preview counts the complete authored plus owned model without false source changes or removals");
            var revision = fake.Current!.Bindings.Revision; engine.ApplyImport(new(package, preview.Revision, preview.PreviewToken));
            await Until(() => fake.Current!.Bindings.Revision > revision, "UDT import source binding reconciliation");
            check(engine.Read([owned.Path], null).Single() == initial && changes.IsEmpty && fake.Disposed == 0 && store.GetTagDefinitions().Count == 2,
                "UDT definition and instance import retains the exact owned value, timestamps, quality and live owner");
            var upgrade = store.ExportTags();
            upgrade["udtDefinitions"]!.AsArray().Add(new JsonObject { ["id"] = "ImportedModel", ["version"] = 2,
                ["members"] = new JsonArray(new JsonObject { ["path"] = "Counter", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 },
                    new JsonObject { ["path"] = "Label", ["kind"] = "memory", ["dataType"] = "String", ["value"] = "Synthetic" }) });
            upgrade["instances"]![0]!["version"] = 2;
            preview = store.PreviewTagImport(upgrade);
            check(preview.CanApply && preview.TotalTags == 3 && preview.Changes.All(change => change.Path != owned.Path),
                "UDT version upgrade preserves owned definitions in complete totals and changes");
            engine.ApplyImport(new(upgrade, preview.Revision, preview.PreviewToken));
            check(engine.Read([owned.Path], null).Single() == initial && changes.IsEmpty && store.GetTagDefinitions().Count == 3,
                "UDT upgrade leaves the existing owned runtime value unchanged");
            var reviewed = store.ExportTags(); preview = store.PreviewTagImport(reviewed);
            store.ApplySourceDiscovery("owned", [item]);
            check(store.PreviewTagImport(reviewed).PreviewToken == preview.PreviewToken,
                "ordinary source observation time changes do not invalidate an engineering review");
            store.ApplySourceDiscovery("owned", [item with { Address = "factory/new", Name = "New", SuggestedPath = "[default]OwnedUdt/factory/new" }]);
            var before = File.ReadAllBytes(Path.Combine(data, "tags.json"));
            reject(() => engine.ApplyImport(new(reviewed, preview.Revision, preview.PreviewToken)), "engineering review predating a newly owned definition");
            check(before.SequenceEqual(File.ReadAllBytes(Path.Combine(data, "tags.json"))) && store.GetTagDefinitions().Count == 4
                && engine.Read([owned.Path], null).Single() == initial, "stale owned-model review applies no authored or runtime changes");
        }
        finally { await engine.StopAsync(default); }
    }
    private static void MixedMappingRestart(string directory, Action<bool, string> check, Action<Action, string> reject)
    {
        var data = Path.Combine(directory, "mixed-mapping-restart"); var protection = new EphemeralDataProtectionProvider();
        var store = new ProjectStore(data, protection, gatewayOnly: true);
        var review = new SourceMqttMapping("review", "factory/review/#", "[default]Mixed/Review");
        var automatic = new SourceMqttMapping("automatic", "factory/tree/#", "[default]Mixed/Tree", Tags: "automatic");
        var settings = Mqtt(review) with { Mqtt = new(ClientId: "synthetic-mixed", Mappings: [review, automatic]) };
        var saved = store.SaveConnection(Connection("mixed", "mqtt", settings));
        var import = new SourceImportRequest(saved["revision"]!.GetValue<int>(),
            [new("factory/review/count", "Count", "Int64", "[default]Mixed/Review/count", MappingId: review.Id)]);
        var preview = Node(store.PreviewSourceImport("mixed", import));
        store.ApplySourceImport("mixed", import with { PreviewToken = preview["previewToken"]!.GetValue<string>() });
        store.ApplySourceDiscovery("mixed", [new(automatic.Id, "factory/tree/value", null, "Value", "Int64", SourceConfiguration.TopicPath(automatic, "factory/tree/value"), 1L)]);
        var identity = store.SourceOwnership().Single();
        var restarted = new ProjectStore(data, protection, gatewayOnly: true);
        check(restarted.GetTagDefinitions().Count == 2 && restarted.SourceOwnership().Single().PointId == identity.PointId
            && restarted.GetTagDefinitions().OfType<JsonObject>().Any(tag => tag["path"]!.GetValue<string>() == "[default]Mixed/Review/count" && tag["sourceOwned"] is null),
            "restart preserves reviewed authored tags alongside automatic owned leaves on the same MQTT connection");
        var edited = restarted.GetConnections().OfType<JsonObject>().Single(); edited["name"] = "Mixed mappings after restart"; restarted.SaveConnection(edited);
        var again = new ProjectStore(data, protection, gatewayOnly: true);
        check(again.GetTagDefinitions().Count == 2 && again.GetConnection("mixed").Source!.Mqtt!.Mappings!.Length == 2,
            "ordinary source edit and second restart preserve distinct review and automatic namespaces");
        var model = JsonNode.Parse(File.ReadAllText(Path.Combine(data, "tags.json")))!.AsObject();
        model["tags"]![0]!["path"] = identity.Path;
        File.WriteAllText(Path.Combine(data, "tags.json"), model.ToJsonString(ProjectStore.Json));
        reject(() => new ProjectStore(data, protection, gatewayOnly: true), "restored authored tag collision in the automatic namespace");
    }
    private static async Task SourceDeadband(string directory, Action<bool, string> check)
    {
        var data = Path.Combine(directory, "source-deadband"); var store = new ProjectStore(data, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var point = new SourcePoint("exact", "Exact", "opaque#exact", "Int64");
        store.SaveConnection(Connection("deadband", "i3x", new("http://127.0.0.1/v1", Points: [point])));
        const string path = "[default]Deadband/Exact";
        var tag = Tag(path, "deadband", point.Id); tag["absoluteDeadband"] = 1.5d; store.SaveTag(tag);
        FakeSource? session = null;
        using var connectors = new ConnectorService(data, sourceFactory: connection => session = new FakeSource(connection));
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance); await engine.StartAsync(default);
        try {
            await Until(() => session?.Current is not null, "exact integer deadband source owner"); var fake = session!;
            const long exact = 9007199254740993;
            var sourceTime = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
            check(await fake.PublishAsync([new(point.Id, exact, "Int64", "Good", SourceTimestamp: sourceTime)], []), "initial exact integer deadband publication");
            var initial = engine.Read([path], null).Single(); await Task.Delay(5);
            var withinAccepted = await fake.PublishAsync([new(point.Id, exact + 1, "Int64", "Good", SourceTimestamp: sourceTime.AddSeconds(1))], []);
            var latest = engine.Read([path], null).Single();
            check(withinAccepted && latest is { Value: exact, SourceTimestamp: var retainedTime, ReceiptTimestamp: var receipt }
                && retainedTime == sourceTime && receipt > initial.ReceiptTimestamp,
                "within-deadband source update retains exact value and source time while advancing receipt time; "
                    + JsonSerializer.Serialize(new { accepted = withinAccepted, initial, latest, active = fake.Current }, ProjectStore.Json));
            check(await fake.PublishAsync([new(point.Id, exact + 2, "Int64", "Good", SourceTimestamp: sourceTime.AddSeconds(2))], [])
                && engine.Read([path], null).Single().Value is long outside && outside == exact + 2,
                "Int64 beyond JavaScript precision uses the exact difference rather than rounded double subtraction");
            check(await fake.PublishAsync([new(point.Id, exact + 3, "Int64", "Uncertain", SourceTimestamp: sourceTime.AddSeconds(3))], [])
                && engine.Read([path], null).Single() is { Quality: "Uncertain", Value: long uncertain } && uncertain == exact + 3,
                "quality changes bypass numerical deadband suppression");
            check(await fake.PublishAsync([new(point.Id, exact + 4, "Int64", "Good", SourceTimestamp: sourceTime.AddSeconds(4))], [])
                && engine.Read([path], null).Single() is { Quality: "Good", Value: long recovered } && recovered == exact + 4,
                "quality recovery publishes the new value even within the deadband");
        } finally { await engine.StopAsync(default); }
    }
    private static void IntegerWireFidelity(Action<bool, string> check)
    {
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        json.Converters.Add(new ExactInt64JsonConverter()); json.Converters.Add(new ExactUInt64JsonConverter());
        var value = new TagValue("[default]Exact", 9007199254740993L, "Int64", "Good", DateTimeOffset.UtcNow, "source:exact", false,
            DateTimeOffset.Parse("2026-01-01T00:00:00Z"), DateTimeOffset.UtcNow, "native", long.MaxValue, long.MaxValue, 123);
        using var api = JsonDocument.Parse(JsonSerializer.Serialize(value, json));
        check(api.RootElement.GetProperty("value").GetString() == "9007199254740993" && api.RootElement.GetProperty("acquisitionGeneration").GetString() == long.MaxValue.ToString(),
            "API converters preserve boxed Int64 values and metadata beyond JavaScript integer precision");
        var frame = "event: tags-delta\ndata: " + JsonSerializer.Serialize(new TagDelta([value], []), json) + "\n\n";
        using var delta = JsonDocument.Parse(frame.Split("data: ", 2)[1].Trim());
        check(delta.RootElement.GetProperty("upserts")[0].GetProperty("value").GetString() == "9007199254740993",
            "SSE delta payload uses the same exact integer conversion as API snapshots");
        var diagnostic = JsonSerializer.Serialize(new { sequence = ulong.MaxValue, safe = 9007199254740991L }, json);
        using var unsigned = JsonDocument.Parse(diagnostic);
        check(unsigned.RootElement.GetProperty("sequence").GetString() == "18446744073709551615" && unsigned.RootElement.GetProperty("safe").ValueKind == JsonValueKind.Number,
            "UInt64 diagnostic cursors retain their full range while safe integers remain numeric");
        check(JsonSerializer.Deserialize<ulong>("\"18446744073709551615\"", json) == ulong.MaxValue && JsonSerializer.Deserialize<long>("\"-9223372036854775808\"", json) == long.MinValue,
            "exact wire converters accept full-range signed and unsigned decimal strings");
    }
    private static SourceSettings Mqtt(SourceMqttMapping mapping) => new("mqtt://127.0.0.1:1883", "subscribe", Mqtt: new(ClientId: "synthetic-client", Mappings: [mapping]));
    private static JsonObject Tag(string path, string connection, string point) => new() { ["path"] = path, ["kind"] = "device", ["connectionId"] = connection, ["nodeId"] = point, ["dataType"] = "Int64" };
    private static JsonObject WithWritable(this JsonObject tag) { tag["writable"] = true; return tag; }
    private static JsonObject Node(object value) => JsonSerializer.SerializeToNode(value, ProjectStore.Json)!.AsObject();
    private static async Task Until(Func<bool> condition, string description)
    { using var deadline = new CancellationTokenSource(10000); while (!condition()) { try { await Task.Delay(20, deadline.Token); } catch (OperationCanceledException) { throw new TimeoutException("Source fixture: " + description); } } }
    private sealed class RecordingSink : ISourceSink
    {
        public ConcurrentQueue<SourceValue> Values { get; } = new();
        public ConcurrentQueue<SourceDiscoveryBatch> Discoveries { get; } = new();
        public ConcurrentQueue<SourceStatus> Statuses { get; } = new();
        public void OnValues(IReadOnlyList<SourceValue> values) { foreach (var value in values) Values.Enqueue(value); }
        public void OnStatus(SourceStatus status) => Statuses.Enqueue(status);
        public void OnDiscovery(SourceDiscoveryBatch discovery) => Discoveries.Enqueue(discovery);
    }
    private sealed class FakeSource(ConnectionDefinition connection) : ISourceSession
    {
        public SourceCapabilities Capabilities { get; } = new(connection.Type, ["poll", "subscribe"], "observed", CachedReads: true);
        public int Starts; public int Stops; public int Updates; public int Disposed;
        public bool FailNextUpdate;
        public TaskCompletionSource? BindingUpdateEntered;
        public TaskCompletionSource? BindingUpdateRelease;
        public ConcurrentDictionary<string, object?> PublishedCache { get; } = new(StringComparer.Ordinal);
        public SourceMonitorRequest? Current;
        private ISourceSink? sink;
        public Task<SourceTestResult> TestAsync(CancellationToken ct) => Task.FromResult(new SourceTestResult(true, "Synthetic source", Capabilities));
        public Task<SourceBrowsePage> BrowseAsync(SourceBrowseRequest request, CancellationToken ct) => Task.FromResult(new SourceBrowsePage([]));
        public Task<SourceReadBatch> ReadAsync(SourceReadRequest request, CancellationToken ct) => Task.FromResult(new SourceReadBatch(request.Points.Select(point => new SourceValue(point.Id, 1L, point.DataType, "Good", Generation: request.Generation, BindingRevision: request.BindingRevision)).ToArray()));
        public Task<ISourceMonitor> StartMonitoringAsync(SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
        { Interlocked.Increment(ref Starts); Current = request; this.sink = sink; sink.OnStatus(new("connected", Generation: request.Generation, BindingRevision: request.Bindings.Revision)); return Task.FromResult<ISourceMonitor>(new FakeMonitor(this)); }
        public void Emit(string point, object? value, long? generation = null, long? revision = null) => sink!.OnValues([new(point, value, "Int64", "Good", DateTimeOffset.Parse("2026-01-01T00:00:00Z"), DateTimeOffset.UtcNow,
            Generation: generation ?? Current!.Generation, BindingRevision: revision ?? Current!.Bindings.Revision)]);
        public void Discover(SourceDiscoveryItem item) => sink!.OnDiscovery(new([item], Current!.Generation, Current.Bindings.Revision));
        public async Task<bool> PublishAsync(SourceValue[] values, SourceDiscoveryItem[] discoveries, Func<bool>? canCommit = null)
        {
            var request = Current!;
            var current = values.Select(value => value with { Generation = request.Generation, BindingRevision = request.Bindings.Revision,
                ReceiptTimestamp = DateTimeOffset.UtcNow, MonotonicReceipt = Stopwatch.GetTimestamp() }).ToArray();
            var accepted = await sink!.OnPublicationAsync(new(current, discoveries, request.Generation, request.Bindings.Revision) { CanCommit = canCommit }, default);
            if (accepted) foreach (var value in current) PublishedCache[value.PointId] = value.Value;
            return accepted;
        }
        public void Status(string state) => sink!.OnStatus(new(state, Generation: Current!.Generation, BindingRevision: Current.Bindings.Revision));
        public ValueTask DisposeAsync() { Interlocked.Increment(ref Disposed); return ValueTask.CompletedTask; }
        private sealed class FakeMonitor(FakeSource source) : ISourceMonitor
        {
            public async Task UpdateBindingsAsync(SourceBindingRevision revision, CancellationToken ct)
            {
                Interlocked.Increment(ref source.Updates);
                if (source.FailNextUpdate) { source.FailNextUpdate = false; throw new InvalidOperationException("Synthetic candidate rejected; prior remote interests confirmed."); }
                var release = Interlocked.Exchange(ref source.BindingUpdateRelease, null);
                if (release is not null) { source.BindingUpdateEntered?.TrySetResult(); await release.Task.WaitAsync(ct); }
                source.Current = source.Current! with { Bindings = revision };
            }
            public ValueTask DisposeAsync() { Interlocked.Increment(ref source.Stops); return ValueTask.CompletedTask; }
        }
    }
}
