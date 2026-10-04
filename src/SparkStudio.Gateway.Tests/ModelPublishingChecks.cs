using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class ModelPublishingChecks
{
    private static int checks;
    private const string Equipment = "[default]Acme/Press01";
    public static async Task<int> RunAsync()
    {
        checks = 0;
        var directory = Path.Combine(Path.GetTempPath(), "spark-model-publishing-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var protector = new EphemeralDataProtectionProvider();
            ConfigurationChecks(directory, protector);
            DeliveryLeaseChecks(Path.Combine(directory, "delivery-lease"), protector);
            DeleteFailureChecks(Path.Combine(directory, "delete-failure"), protector);
            PayloadChecks();
            WorkshopChecks(Path.Combine(directory, "workshop"), protector);
            await WireChecks(directory);
            await RecoveryChecks(Path.Combine(directory, "restart"), protector);
            await CaptureChecks(Path.Combine(directory, "capture"), protector);
            await FullBackupChecks(Path.Combine(directory, "backup"), protector);
            return checks;
        }
        finally { Directory.Delete(directory, true); }
    }
    private static ModelPublisher Publisher(string endpoint = "mqtt://127.0.0.1:1883") => new("press", "Press production", endpoint, [Equipment]);
    private static void ConfigurationChecks(string directory, IDataProtectionProvider protector)
    {
        var store = new ModelPublishingStore(directory, protector);
        var input = Publisher() with { Password = "synthetic-fixture-password", Username = "synthetic-user", Enabled = true, QueueLimit = 1 };
        store.Save(new(0, input));
        Check(store.RuntimeSnapshot().Revision == 1 && store.RuntimeSnapshot().Publishers[0].HasPassword, "secret presence is returned without the secret");
        Check(!JsonSerializer.Serialize(store.Snapshot()).Contains(input.Password, StringComparison.Ordinal), "API snapshot never includes plaintext credentials");
        Check(!File.ReadAllText(Path.Combine(directory, "model-publishing.json")).Contains(input.Password, StringComparison.Ordinal), "password protected on disk");
        var restored = new ModelPublishingStore(directory, protector);
        Check(restored.Runtime("press").Password == input.Password, "protected password restored for transport only");
        var copy = store.RuntimeSnapshot().Publishers[0]; copy.InstancePaths[0] = "[default]Wrong";
        Check(store.Runtime("press").InstancePaths[0] == Equipment, "snapshot arrays cannot mutate stored settings");
        var message = new ModelPublishingMessage("one", "spark/models/default/Acme/Press01", "{}", DateTimeOffset.UtcNow);
        Check(store.Enqueue("press", 1, [message]), "first message durably queued");
        Check(!store.Enqueue("press", 1, [message with { Id = "two" }]) && store.QueueStatus("press").Count == 1, "full queue rejects newest without evicting pending messages");
        Reject<InvalidOperationException>(() => store.Save(new(1, input with { TopicPrefix = "changed" })), "destination changes cannot reroute pending data");
        Reject<InvalidOperationException>(() => store.Delete("press", 1, false), "deletion requires explicit pending-message discard");
        Reject<InvalidOperationException>(() => store.Save(new(0, input)), "stale configuration revisions rejected");
        Check(new ModelPublishingStore(directory, protector).Peek("press")?.Id == "one", "queue survives store recreation");
        store.Acknowledge("press", "wrong"); Check(store.QueueStatus("press").Count == 1, "unrelated ACK cannot remove queue head");
        store.Acknowledge("press", "one"); Check(new ModelPublishingStore(directory, protector).QueueStatus("press").Count == 0, "acknowledgment durably removes queue head");
        store.Save(new(1, input with { Password = null, Enabled = false }));
        Check(store.Runtime("press").Password == input.Password && !store.Enqueue("press", 2, [message]), "omitted credentials preserved and disabled publisher cannot enqueue");
        store.Save(new(2, input with { Password = null, ClearPassword = true, Enabled = false }));
        Check(!store.RuntimeSnapshot().Publishers[0].HasPassword, "explicit credential removal supported");
        foreach (var invalid in new[] { Publisher("mqtt://user:pass@localhost"), Publisher("http://localhost"), Publisher() with { Id = "Press" }, Publisher() with { Qos = 2 }, Publisher() with { TopicPrefix = "plant/#" }, Publisher() with { IntervalMs = 1 }, Publisher() with { InstancePaths = [Equipment, Equipment] } })
            Reject<ArgumentException>(() => ModelPublishingStore.Validate(invalid), "invalid publication options rejected");
    }
    private static void DeleteFailureChecks(string directory, IDataProtectionProvider protector)
    {
        var store = new ModelPublishingStore(directory, protector);
        store.Save(new(0, Publisher() with { Enabled = true }));
        store.Enqueue("press", 1, [new("pending", "original/destination", "{}", DateTimeOffset.UtcNow)]);
        var queueFile = Path.Combine(directory, "model-publishing-queue", "press.json");
        var preserved = queueFile + ".preserved";
        File.Move(queueFile, preserved);
        Directory.CreateDirectory(queueFile); // Force the atomic queue replacement to fail on every platform.
        try
        {
            try { store.Delete("press", 1, true); throw new Exception("FAILED: durable discard failure must reject publisher deletion"); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { checks++; }
            Check(store.RuntimeSnapshot().Revision == 1 && store.RuntimeSnapshot().Publishers.Length == 1,
                "failed discard keeps the ID and original destination reserved in memory");
            Check(new ModelPublishingStore(directory, protector).Runtime("press").Endpoint == Publisher().Endpoint,
                "failed discard keeps the original publisher configuration on disk");
        }
        finally { Directory.Delete(queueFile); File.Move(preserved, queueFile); }
        store.Delete("press", 1, true);
        var restarted = new ModelPublishingStore(directory, protector);
        Check(restarted.RuntimeSnapshot().Publishers.Length == 0 && restarted.QueueStatus("press").Count == 0,
            "successful delete leaves no old messages for a reused publisher ID");
    }
    private static void DeliveryLeaseChecks(string directory, IDataProtectionProvider protector)
    {
        var store = new ModelPublishingStore(directory, protector);
        var original = Publisher() with { Enabled = true, Username = "original-user", Password = "original-fixture-password" };
        store.Save(new(0, original));
        store.Enqueue("press", 1, [new("old-message", "original/topic", "{\"value\":28}", DateTimeOffset.UtcNow)]);
        using (var delivery = store.BeginDelivery("press") ?? throw new Exception("Expected pending delivery."))
        {
            Check(delivery.Revision == 1 && delivery.Message.Id == "old-message" && delivery.Settings.Endpoint == original.Endpoint,
                "delivery atomically pins queue head and destination generation");
            store.Save(new(1, original with { Enabled = false, Password = "replacement-fixture-password" }));
            Check(delivery.Settings.Password == "original-fixture-password" && !store.Runtime("press").Enabled,
                "disabling is immediate while in-flight transport retains its own credential snapshot");
            Reject<InvalidOperationException>(() => store.Discard("press"), "discard cannot free an in-flight message for rerouting");
            Reject<InvalidOperationException>(() => store.Delete("press", 2, true), "deletion cannot reuse an in-flight publisher identity");
            store.Acknowledge("press", delivery.Message.Id);
            Reject<InvalidOperationException>(() => store.Save(new(2, original with { Endpoint = "mqtt://127.0.0.1:1884" })),
                "routing remains reserved until delivery releases even after queue acknowledgment");
        }
        Check(store.Discard("press") == 0, "completed delivery releases discard guard");
        var replacement = original with { Endpoint = "mqtt://127.0.0.1:1884", TopicPrefix = "replacement/models" };
        store.Save(new(2, replacement));
        Check(store.BeginDelivery("press") is null, "rerouted empty publisher cannot replay the old message");
        store.Enqueue("press", 3, [new("new-message", "replacement/topic", "{}", DateTimeOffset.UtcNow)]);
        using (var delivery = store.BeginDelivery("press") ?? throw new Exception("Expected replacement delivery."))
            Check(delivery.Revision == 3 && delivery.Message.Id == "new-message" && delivery.Settings.Endpoint == replacement.Endpoint,
                "new generation leases only its own pending message and destination");
        Check(store.Discard("press") == 1, "failed or unacknowledged delivery releases guard while preserving the queue");
        store.Delete("press", 3, false);
        Check(store.RuntimeSnapshot().Publishers.Length == 0, "publisher can be deleted after the in-flight operation ends");
    }
    private static JsonObject Object(double load = 28, string quality = "Good") => new()
    {
        ["path"] = Equipment, ["definitionId"] = "Press", ["version"] = 1, ["generation"] = 4,
        ["members"] = new JsonObject { ["Load"] = new JsonObject { ["path"] = Equipment + "/Load", ["kind"] = "reference", ["targetPath"] = "[default]Private/Source",
            ["value"] = load, ["dataType"] = "Double", ["quality"] = quality, ["sourceQuality"] = "Good", ["timestamp"] = DateTimeOffset.UtcNow,
            ["sourceTimestamp"] = DateTimeOffset.UtcNow.AddSeconds(-1), ["receiptTimestamp"] = DateTimeOffset.UtcNow,
            ["metadata"] = new JsonObject { ["unit"] = "%" }, ["modelIssues"] = new JsonArray() } }
    };
    private static void PayloadChecks()
    {
        var first = ModelPublishingPayload.Capture(Publisher(), _ => Object());
        Check(first.Length == 1 && first[0].Topic == "spark/models/default/Acme/Press01", "object topic contains provider and equipment path");
        var payload = JsonNode.Parse(first[0].Payload)!;
        Check(payload["members"]!["Load"]!["sourceQuality"]!.GetValue<string>() == "Good" && payload["members"]!["Load"]!["receiptTimestamp"] is not null, "quality, original quality and timestamps retained");
        Check(!first[0].Payload.Contains("Private/Source", StringComparison.Ordinal) && !first[0].Payload.Contains("targetPath", StringComparison.Ordinal), "payload omits internal source bindings");
        var next = ModelPublishingPayload.Capture(Publisher(), _ => Object());
        Check(ModelPublishingPayload.Fingerprint(first) == ModelPublishingPayload.Fingerprint(next), "timestamp-only refresh does not trigger on-change publishing");
        var changed = ModelPublishingPayload.Capture(Publisher(), _ => Object(91));
        Check(ModelPublishingPayload.Fingerprint(first) != ModelPublishingPayload.Fingerprint(changed), "value changes publish");
        changed = ModelPublishingPayload.Capture(Publisher(), _ => Object(28, "Uncertain_Stale"));
        Check(ModelPublishingPayload.Fingerprint(first) != ModelPublishingPayload.Fingerprint(changed), "quality changes publish even with unchanged value");
        var issueObject = Object(); issueObject["members"]!["Load"]!["modelIssues"]!.AsArray().Add(new JsonObject { ["code"] = "stale", ["message"] = "Example", ["expected"] = "New sample" });
        var withIssue = ModelPublishingPayload.Capture(Publisher(), _ => issueObject);
        Check(withIssue[0].Payload.Contains("modelIssues", StringComparison.Ordinal) && ModelPublishingPayload.Fingerprint(first) != ModelPublishingPayload.Fingerprint(withIssue), "model issues survive publication and trigger on-change capture");
        var timestampField = Object(); timestampField["members"]!["timestamp"] = timestampField["members"]!["Load"]!.DeepClone();
        var namedTimestamp = ModelPublishingPayload.Capture(Publisher(), _ => timestampField);
        timestampField["members"]!["timestamp"]!["value"] = 42;
        Check(ModelPublishingPayload.Fingerprint(namedTimestamp) != ModelPublishingPayload.Fingerprint(ModelPublishingPayload.Capture(Publisher(), _ => timestampField)), "a model field named timestamp is not mistaken for envelope metadata");
        var leaves = ModelPublishingPayload.Capture(Publisher() with { Shape = "leaves" }, _ => Object());
        Check(leaves.Length == 1 && leaves[0].Topic.EndsWith("/Load", StringComparison.Ordinal) && JsonNode.Parse(leaves[0].Payload)!["value"]!.GetValue<double>() == 28, "leaf payload exposes value envelope on leaf topic");
        Check(ModelPublishingPayload.TopicPath("[default]Line 1/Press#1") == "default/Line%201/Press%231", "MQTT path levels escape reserved characters without collisions");
        FolderNamedFieldsChecks();
    }
    private static void FolderNamedFieldsChecks()
    {
        var source = Object();
        var folder = new JsonObject();
        foreach (var name in new[] { "value", "quality", "timestamp", "Other" }) folder[name] = source["members"]!["Load"]!.DeepClone();
        source["members"] = new JsonObject { ["Status"] = folder };
        var objects = ModelPublishingPayload.Capture(Publisher(), _ => source);
        Check(JsonNode.Parse(objects[0].Payload)!["members"]!["Status"]!["Other"]!["value"]!.GetValue<double>() == 28,
            "fields named value and quality do not turn a folder into a leaf envelope");
        var leaves = ModelPublishingPayload.Capture(Publisher() with { Shape = "leaves" }, _ => source);
        Check(leaves.Length == 4 && leaves.Any(item => item.Topic.EndsWith("/Status/quality", StringComparison.Ordinal)),
            "leaf topics retain every field when a folder uses envelope field names");
        folder["timestamp"]!["value"] = 64;
        Check(ModelPublishingPayload.Fingerprint(objects) != ModelPublishingPayload.Fingerprint(ModelPublishingPayload.Capture(Publisher(), _ => source)),
            "on-change fingerprints retain a timestamp field inside folders containing value and quality fields");
    }
    private static void WorkshopChecks(string directory, IDataProtectionProvider protector)
    {
        var cursor = new DirectoryInfo(AppContext.BaseDirectory);
        while (cursor is not null && !File.Exists(Path.Combine(cursor.FullName, "examples", "model-operations.json"))) cursor = cursor.Parent;
        if (cursor is null) throw new InvalidOperationException("Authored model operations workshop was not found.");
        var recipe = JsonNode.Parse(File.ReadAllText(Path.Combine(cursor.FullName, "examples", "model-operations.json")))!.AsObject();
        var store = new ProjectStore(directory, protector);
        var package = recipe["modelRecipe"]!.AsObject(); var preview = store.PreviewTagImport(package);
        Check(preview.CanApply && preview.TotalTags == 18, "authored workshop previews nine sources and nine modeled leaves");
        store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
        var upgrade = recipe["upgradeRecipe"]!.AsObject(); preview = store.PreviewTagImport(upgrade);
        Check(preview.CanApply && preview.TotalTags == 19, "authored upgrade adds one field only on selected press");
        store.ApplyTagImport(new(upgrade, preview.Revision, preview.PreviewToken));
        var export = ModelSelectiveExport.Export(store.ExportTags(), store.GetTagDefinitions(), new(InstancePaths: ["[default]ModelOperations/Plant/Line1/Press01"]));
        Check(export.Summary.Instances == 1 && export.Summary.Tags == 3 && export.Summary.Mappings == 1, "workshop selective export contains the chosen press and its actual mapping/source closure");
    }
    private static async Task WireChecks(string directory)
    {
        await using var broker = new ModelPublishingBroker();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var publisher = await ModelMqttPublisher.ConnectAsync(broker.Endpoint, "fixture", "fixture-user", "fixture-password", directory, timeout.Token);
        await publisher.PublishAsync("models/press", Encoding.UTF8.GetBytes("{\"value\":28}"), 1, true, timeout.Token);
        Check(broker.Messages.TryDequeue(out var message) && message.Qos == 1 && message.Retain && message.Payload.Contains("28", StringComparison.Ordinal), "real MQTT PUBLISH QoS1 retain waits for broker PUBACK");
        Check(broker.Username == "fixture-user" && broker.Password == "fixture-password", "transport sends explicitly configured credentials");
        await publisher.PublishAsync("models/press", Encoding.UTF8.GetBytes("{}"), 0, false, timeout.Token);
        await Until(() => broker.Messages.Count > 0);
        Check(broker.Messages.TryDequeue(out message) && message.Qos == 0 && !message.Retain, "QoS0 publish without ACK is supported");
        broker.Acknowledge = false;
        using var missingAck = new CancellationTokenSource(300);
        try { await publisher.PublishAsync("models/press", Encoding.UTF8.GetBytes("{}"), 1, false, missingAck.Token); throw new Exception("Missing ACK incorrectly succeeded."); }
        catch (OperationCanceledException) { checks++; }
    }
    private static async Task RecoveryChecks(string directory, IDataProtectionProvider protector)
    {
        await using var broker = new ModelPublishingBroker { Acknowledge = false };
        var settings = Publisher(broker.Endpoint) with { Enabled = true, IntervalMs = 86400000 };
        var store = new ModelPublishingStore(directory, protector); store.Save(new(0, settings));
        store.Enqueue("press", 1, [new("recover-me", "fixture/recovery", "{\"value\":42}", DateTimeOffset.UtcNow)]);
        using (var first = new ModelPublishingService(store, _ => Object(), directory, () => { }))
        {
            await first.StartAsync(CancellationToken.None); await Until(() => broker.Messages.Count > 0);
            Check(store.Peek("press")?.Id == "recover-me", "unacknowledged wire message remains durably queued");
            Reject<InvalidOperationException>(() => store.Discard("press"), "service holds its delivery lease while waiting for broker PUBACK");
            Reject<InvalidOperationException>(() => store.Delete("press", 1, true), "in-flight MQTT publication prevents delete and ID reuse");
            await first.StopAsync(CancellationToken.None);
        }
        broker.Acknowledge = true;
        var restarted = new ModelPublishingStore(directory, protector);
        using (var second = new ModelPublishingService(restarted, _ => Object(), directory, () => { }))
        {
            await second.StartAsync(CancellationToken.None); await Until(() => restarted.QueueStatus("press").Count == 0);
            Check(broker.Messages.Count(item => item.Topic == "fixture/recovery") >= 2, "restart retries unacknowledged publication and broker ACK drains queue");
            await second.StopAsync(CancellationToken.None);
        }
    }
    private static async Task CaptureChecks(string directory, IDataProtectionProvider protector)
    {
        await using var broker = new ModelPublishingBroker();
        var value = 28d; var quality = "Good";
        var store = new ModelPublishingStore(directory, protector); store.Save(new(0, Publisher(broker.Endpoint) with { Enabled = true, IntervalMs = 250 }));
        using var service = new ModelPublishingService(store, _ => Object(value, quality), directory, () => { });
        await service.StartAsync(CancellationToken.None); await Until(() => broker.Messages.Count >= 1);
        await service.TestAsync("press", CancellationToken.None);
        Check(broker.ClientIds.Distinct(StringComparer.Ordinal).Count() == 2, "broker test uses a unique client identity without displacing the active publisher");
        await Task.Delay(600); Check(broker.Messages.Count == 1, "on-change service suppresses unchanged value snapshots");
        value = 64; await Until(() => broker.Messages.Count >= 2);
        quality = "Uncertain_Stale"; await Until(() => broker.Messages.Count >= 3);
        Check(broker.Messages.Count == 3, "on-change captures both value and quality transitions");
        await service.StopAsync(CancellationToken.None);
        using var quarantined = new ModelPublishingService(store, _ => Object(), directory, () => throw new InvalidOperationException("Quarantined"));
        var connections = broker.Connections; await quarantined.StartAsync(CancellationToken.None); await Task.Delay(350); await quarantined.StopAsync(CancellationToken.None);
        Check(broker.Connections == connections, "recovery quarantine prevents network operations");
    }
    private static async Task FullBackupChecks(string directory, IDataProtectionProvider protector)
    {
        var source = Path.Combine(directory, "source");
        var store = new ModelPublishingStore(source, protector);
        store.Save(new(0, Publisher() with { Enabled = true }));
        store.Enqueue("press", 1, [new("preserved", "fixture/backup", "{}", DateTimeOffset.UtcNow)]);
        var archive = Path.Combine(directory, "fixture.sparkbak");
        await GatewayRecovery.BackupAsync(source, archive, "synthetic-model-publishing-backup-passphrase");
        var restored = Path.Combine(directory, "restored");
        await GatewayRecovery.RestoreAsync(archive, restored, "synthetic-model-publishing-backup-passphrase");
        var restoredStore = new ModelPublishingStore(restored, protector);
        Check(restoredStore.Peek("press")?.Id == "preserved", "offline full backup restores pending outgoing publications");
        Check(new RecoveryQuarantine(restored).Active, "restored publisher waits in recovery quarantine before replay");
    }
    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition()) await Task.Delay(25, timeout.Token);
    }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception("FAILED: " + message); checks++; }
    private static void Reject<T>(Action action, string message) where T : Exception
    { try { action(); } catch (T) { checks++; return; } throw new Exception("FAILED to reject: " + message); }
}
