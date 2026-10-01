using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class DeviceGatewayChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); passed++; }
        async Task Reject(Func<Task> operation, string message)
        {
            try { await operation(); }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or BadHttpRequestException) { passed++; return; }
            throw new InvalidOperationException("Expected rejection: " + message);
        }
        Task Action(Action operation) { operation(); return Task.CompletedTask; }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.DeviceGateway." + Guid.NewGuid().ToString("N"));
        await using var device = new RegisterFixture();
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var sourceDirectory = new DirectoryInfo(AppContext.BaseDirectory);
            while (sourceDirectory is not null && !File.Exists(Path.Combine(sourceDirectory.FullName, "examples", "industrial-devices-workshop.json"))) sourceDirectory = sourceDirectory.Parent;
            if (sourceDirectory is null) throw new InvalidOperationException("The authored industrial workshop is missing from the source checkout.");
            var authoredWorkshop = JsonNode.Parse(File.ReadAllText(Path.Combine(sourceDirectory.FullName, "examples", "industrial-devices-workshop.json")))!.AsObject();
            var workshop = catalog.Create("Authored industrial workshop validation"); var workshopDraft = workshop.Store.GetProject();
            foreach (var field in new[] { "screens", "commands", "navigation" }) workshopDraft[field] = authoredWorkshop[field]!.DeepClone();
            var savedWorkshop = workshop.Store.SaveProject(workshopDraft);
            var workshopStamp = workshop.Publication.Publish(workshop.Store, savedWorkshop["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            Check(workshop.Publication.GetProject()["commands"]!.AsArray().Count == 4 && !string.IsNullOrEmpty(workshopStamp), "independently authored four-profile workshop validates and explicitly publishes without creating gateway connections");
            Check(catalog.GatewayStore.GetConnections().Count == 0 && catalog.GatewayStore.GetTagDefinitions().Count == 0, "workshop project save/publication does not configure a device or tag");
            var workspace = catalog.Create("Synthetic device command fixture"); var store = catalog.GatewayStore;
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
            passed += await CheckAllenBradleyFamiliesAsync(catalog, tags, connectors);
            var settings = new DeviceSettings { Host = "127.0.0.1", Port = device.Port, TimeoutMs = 500, Points = new DevicePoint[] {
                new() { Id = "Speed", Name = "Synthetic speed", Address = "holdingRegister:0", DataType = "UInt16", Writable = true },
                new() { Id = "Feedback", Name = "Synthetic feedback", Address = "holdingRegister:1", DataType = "UInt16" }
            } };
            JsonObject Connection(string id, DeviceSettings profile) => new() { ["id"] = id, ["name"] = id, ["type"] = "modbus-tcp", ["device"] = JsonSerializer.SerializeToNode(profile, ProjectStore.Json) };
            var connection = tags.SaveConnection(Connection("Device", settings));
            Check(store.GetConnection("Device").Device!.Points.Count == 2, "saved device settings and map round-trip to server-owned configuration");
            await Reject(() => Action(() => tags.SaveConnection(Connection("Broken", settings with { Host = "http://127.0.0.1" }))), "URL host rejected");
            await Reject(() => Action(() => tags.SaveConnection(Connection("Broken", settings with { Points = new[] { settings.Points[0], settings.Points[0] } }))), "duplicate map IDs rejected");
            await Reject(() => Action(() => tags.SaveConnection(Connection("Device", settings))), "existing connection requires current revision");
            JsonObject Tag(string path, string point, string type = "UInt16") => new() { ["path"] = path, ["kind"] = "device", ["connectionId"] = "Device", ["nodeId"] = point, ["dataType"] = type, ["publishingIntervalMs"] = 100 };
            var workshopConnection = tags.SaveConnection(Connection("WorkshopDevice", settings with { Points = new DevicePoint[] {
                new() { Id = "Setpoint", Name = "Synthetic lab setpoint", Address = "holdingRegister:0", DataType = "Int16", Writable = true }
            } }));
            const string workshopPath = "[default]IndustrialWorkshop/Modbus/Setpoint";
            var workshopTag = Tag(workshopPath, "Setpoint", "Int16"); workshopTag["connectionId"] = "WorkshopDevice";
            tags.SaveDefinition(workshopTag);
            savedWorkshop = workshop.Store.SaveProject(workshop.Store.GetProject());
            workshop.Publication.Publish(workshop.Store, savedWorkshop["revision"]!.GetValue<int>());
            Check(workshop.Publication.GetProject()["commands"]!.AsArray().Count == 4 && store.GetTagDefinitions().OfType<JsonObject>().Single(item => item["path"]?.GetValue<string>() == workshopPath)["dataType"]!.GetValue<string>() == "Int16", "authored workshop validates with one matching loopback Modbus map/tag bound");
            Check(device.Writes == 0 && !store.GetTagDefinitions().OfType<JsonObject>().Any(item => item["path"]?.GetValue<string>() is "[default]IndustrialWorkshop/EtherNetIP/Setpoint" or "[default]IndustrialWorkshop/SiemensS7/Setpoint" or "[default]IndustrialWorkshop/BeckhoffADS/Setpoint"), "workshop publication sends no writes and leaves the other three lab profiles unconfigured");
            tags.DeleteDefinition(workshopPath);
            await tags.DeleteConnectionAsync("WorkshopDevice", workshopConnection["revision"]!.GetValue<int>(), catalog);
            const string speedPath = "[default]Fixture/Speed", feedbackPath = "[default]Fixture/Feedback", aliasPath = "[default]Fixture/Alias";
            tags.SaveDefinition(Tag(speedPath, "Speed"));
            var readOnly = Tag(feedbackPath, "Feedback"); readOnly["writable"] = true;
            Check(!tags.SaveDefinition(readOnly)["writable"]!.GetValue<bool>(), "submitted tag metadata cannot elevate map write permission");
            await Reject(() => Action(() => tags.SaveDefinition(Tag("[default]Fixture/Missing", "Missing"))), "point must exist in saved map");
            await Reject(() => Action(() => tags.SaveDefinition(Tag("[default]Fixture/WrongType", "Speed", "Int32"))), "tag type must match point type");
            var invalidKind = Tag("[default]Fixture/WrongSource", "Speed"); invalidKind["kind"] = "opcua";
            await Reject(() => Action(() => tags.SaveDefinition(invalidKind)), "OPC source cannot bind industrial point ID");
            var changedMap = connection.DeepClone().AsObject(); changedMap["device"] = JsonSerializer.SerializeToNode(settings with { Points = new[] { settings.Points[1] } }, ProjectStore.Json);
            await Reject(() => Action(() => tags.SaveConnection(changedMap)), "referenced point cannot be removed by connection edit");
            await Reject(() => tags.DeleteConnectionAsync("Device", connection["revision"]!.GetValue<int>(), catalog), "saved device tags prevent connection deletion");
            var templateConnection = tags.SaveConnection(Connection("TemplateOnly", settings));
            var package = store.ExportTags();
            var member = Tag("Speed", "Speed"); member["connectionId"] = "TemplateOnly";
            package["udtDefinitions"]!.AsArray().Add(new JsonObject { ["id"] = "DeviceTemplate", ["version"] = 1, ["members"] = new JsonArray(member) });
            var preview = store.PreviewTagImport(package); store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
            await Reject(() => tags.DeleteConnectionAsync("TemplateOnly", templateConnection["revision"]!.GetValue<int>(), catalog), "unused UDT device member prevents connection deletion");
            var templateMap = templateConnection.DeepClone().AsObject(); templateMap["device"] = JsonSerializer.SerializeToNode(settings with { Points = new[] { settings.Points[1] } }, ProjectStore.Json);
            await Reject(() => Action(() => tags.SaveConnection(templateMap)), "unused UDT device member preserves its point mapping");
            var aliasConnection = tags.SaveConnection(Connection("AliasDevice", settings));
            var alias = Tag(aliasPath, "Speed"); alias["connectionId"] = "AliasDevice"; tags.SaveDefinition(alias);
            var project = workspace.Store.GetProject();
            JsonObject Command(string id, string path, string? readback = null) => new() { ["id"] = id, ["name"] = id, ["tagPath"] = path, ["dataType"] = "UInt16", ["min"] = 0d, ["max"] = 100d, ["confirmation"] = "Synthetic loopback register only", ["timeoutMs"] = 150, ["readbackPath"] = readback ?? path };
            project["commands"] = new JsonArray(Command("speed", speedPath), Command("readOnly", feedbackPath), Command("alias", aliasPath), Command("slow", speedPath, feedbackPath));
            workspace.Store.SaveProject(project);
            var stamp = workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            var security = new SecurityStore(directory); var setupCode = File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim();
            security.Setup(setupCode, new("device-admin", "Synthetic-fixture-password-123"));
            var operatorUser = security.CreateUser(new("device-operator", "Synthetic-fixture-password-456", ProjectGrants: new() { [workspace.Id] = new(Commands: true) }));
            var viewer = security.CreateUser(new("device-viewer", "Synthetic-fixture-password-789", ProjectGrants: new() { [workspace.Id] = new(Operate: true, View: true) }));
            DefaultHttpContext Context(SecurityUser user) { var result = new DefaultHttpContext(); result.Items["spark.actor"] = user; result.Items["spark.project"] = workspace.Id; result.Items["spark.audience"] = "operator"; return result; }
            var context = Context(operatorUser); var commands = new EquipmentCommands(connectors, tags, security, new RecoveryQuarantine(directory));
            JsonObject Node(object result) => JsonSerializer.SerializeToNode(result, ProjectStore.Json)!.AsObject();
            async Task<JsonObject> Review(string id, int value, HttpContext? actor = null) => Node(await commands.Review(actor ?? context, workspace.Store, workspace.Publication, id, new(stamp, JsonSerializer.SerializeToElement(value)), CancellationToken.None));
            async Task<JsonObject> Execute(string id, JsonObject review) => Node(await commands.Execute(context, workspace.Store, workspace.Publication, id, new(review["token"]!.GetValue<string>(), true), CancellationToken.None));
            await Reject(() => Review("speed", 20), "device command must have tag read scope");
            security.UpdateSettings(new(security.Settings.Revision, null, new() { [workspace.Id] = ["[default]Fixture/"] }));
            await Reject(() => Review("speed", 20, Context(viewer)), "Operate alone cannot write device");
            await Reject(() => Review("readOnly", 20), "read-only map point cannot be commanded");
            await Reject(() => Review("speed", 101), "device command enforces published numeric bounds");
            Check(device.Writes == 0, "invalid device command reviews never transmit writes");
            var review = await Review("speed", 20);
            var firstResult = await Execute("speed", review);
            Check(firstResult["status"]!.GetValue<string>() == "confirmed" && device.Value == 20 && device.Writes == 1, "reviewed device write dispatches once and confirms fresh register readback: " + firstResult.ToJsonString() + " value=" + device.Value + " writes=" + device.Writes);
            await Reject(() => Execute("speed", review), "consumed device ticket cannot replay");
            var slow = await Review("slow", 30); var aliasReview = await Review("alias", 40);
            var pending = Execute("slow", slow);
            await Reject(() => Execute("alias", aliasReview), "different connection IDs for the same physical endpoint cannot command concurrently");
            Check((await pending)["status"]!.GetValue<string>() == "notConfirmed" && device.Writes == 2, "mismatched fresh feedback yields accepted but not confirmed");
            review = await Review("speed", 50);
            connection["enabled"] = false; connection = tags.SaveConnection(connection);
            Check((await Execute("speed", review))["status"]!.GetValue<string>() == "rejected" && device.Writes == 2, "disable invalidates pending device command without dispatch");
            await Reject(() => Action(() => store.GetConnection("Device")), "disabled connection blocks new operations");
            connection["enabled"] = true; connection = tags.SaveConnection(connection);
            review = await Review("speed", 60); device.DropNextWriteResponse = true;
            Check((await Execute("speed", review))["status"]!.GetValue<string>() == "uncertain" && device.Writes == 3, "lost write response reports uncertain with no automatic resend");
            await Reject(() => Execute("speed", review), "uncertain device ticket cannot replay");
            await tags.StartAsync(CancellationToken.None);
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (tags.Read([speedPath], null)[0].Quality != "Good" && DateTime.UtcNow < deadline) await Task.Delay(25);
            var observed = tags.Read([speedPath], null)[0];
            Check(observed.Source == "device" && observed.Writable && Convert.ToUInt16(observed.Value) == 60, "device polling flows into runtime tags with mapped write metadata");
            await tags.StopAsync(CancellationToken.None);
            tags.DeleteDefinition(speedPath); tags.DeleteDefinition(feedbackPath); tags.DeleteDefinition(aliasPath);
            await tags.DeleteConnectionAsync("Device", connection["revision"]!.GetValue<int>(), catalog);
            Check(!store.GetConnections().OfType<JsonObject>().Any(item => item["id"]!.GetValue<string>() == "Device"), "unreferenced idle device connection deletes through shared lifecycle");
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())))
                throw new InvalidOperationException("Device fixture cleanup escaped its temporary root.");
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return passed;
    }

    private static async Task<int> CheckAllenBradleyFamiliesAsync(ProjectCatalog catalog, TagEngine tags, ConnectorService connectors)
    {
        var passed = 0;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); passed++; }
        foreach (var family in new[] { "Micro800", "MicroLogix", "Slc500", "Plc5" })
        {
            var id = "Family" + family;
            var path = "[default]FamilyFixture/" + family;
            var point = new DevicePoint { Id = "Setpoint", Name = "Synthetic setpoint", Address = family == "Micro800" ? "SyntheticSetpoint" : "N7:0", DataType = "Int16", Writable = true };
            var profile = new DeviceSettings { Host = "127.0.0.1", Port = 1, ControllerFamily = family, Route = "", Points = [point] };
            var saved = tags.SaveConnection(new JsonObject { ["id"] = id, ["name"] = id, ["type"] = "ab-eip", ["device"] = JsonSerializer.SerializeToNode(profile, ProjectStore.Json) });
            var definition = catalog.GatewayStore.GetConnection(id);
            Check(definition.Device!.ControllerFamily == family && definition.Device.Route == "" && definition.Device.Points.Single().Address == point.Address,
                family + " persists its controller profile and native address through gateway configuration");
            var browse = await connectors.BrowseAsync(definition, "@configured", CancellationToken.None);
            Check(browse.Single().NodeId == point.Id && browse.Single().Address == point.Address && browse.Single().BrowseMode == "configured",
                family + " browses the saved map without contacting an endpoint that has no controller");
            var tag = tags.SaveDefinition(new JsonObject { ["path"] = path, ["kind"] = "device", ["connectionId"] = id, ["nodeId"] = point.Id, ["dataType"] = "Int16", ["publishingIntervalMs"] = 100 });
            Check(tag["writable"]!.GetValue<bool>() && tag["nodeId"]!.GetValue<string>() == "Setpoint",
                family + " maps a writable tag to the saved point identity");
            var incompatible = saved.DeepClone().AsObject();
            incompatible["device"] = JsonSerializer.SerializeToNode(profile with { Points = [point with { DataType = "Float", Address = family == "Micro800" ? point.Address : "F8:0" }] }, ProjectStore.Json);
            try { tags.SaveConnection(incompatible); throw new InvalidOperationException(family + " accepted a type change to a referenced point"); }
            catch (ArgumentException) { passed++; }
            Check(catalog.GatewayStore.GetConnection(id).Device!.Points.Single().DataType == "Int16",
                family + " retains the original map after rejecting an incompatible edit");
            tags.DeleteDefinition(path);
            await tags.DeleteConnectionAsync(id, saved["revision"]!.GetValue<int>(), catalog);
        }
        Check(catalog.GatewayStore.GetConnections().Count == 0 && catalog.GatewayStore.GetTagDefinitions().Count == 0,
            "Allen-Bradley family configuration fixtures leave no active mappings or device connections");
        return passed;
    }

    private sealed class RegisterFixture : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stopping = new();
        private readonly List<Task> clients = [];
        private readonly Task loop;
        private int value = 10, writes;
        public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
        public int Value => Volatile.Read(ref value);
        public int Writes => Volatile.Read(ref writes);
        public bool DropNextWriteResponse;
        public RegisterFixture() { listener.Start(); loop = Accept(); }
        private async Task Accept()
        {
            try { while (!stopping.IsCancellationRequested) { var client = await listener.AcceptTcpClientAsync(stopping.Token); clients.Add(Serve(client)); } }
            catch (OperationCanceledException) { }
        }
        private async Task Serve(TcpClient client)
        {
            using (client)
            try
            {
                var stream = client.GetStream(); var header = new byte[7];
                while (!stopping.IsCancellationRequested)
                {
                    await stream.ReadExactlyAsync(header, stopping.Token);
                    var length = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(4, 2)); var request = new byte[length - 1];
                    await stream.ReadExactlyAsync(request, stopping.Token); byte[] response;
                    var address = BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(1, 2));
                    if (request[0] is 3 or 4)
                    {
                        var count = BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(3, 2)); response = new byte[2 + count * 2]; response[0] = request[0]; response[1] = (byte)(count * 2);
                        for (var index = 0; index < count; index++) BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(2 + index * 2, 2), address + index == 0 ? (ushort)Value : (ushort)0);
                    }
                    else if (request[0] is 6 or 16)
                    {
                        Volatile.Write(ref value, BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(request[0] == 6 ? 3 : 6, 2))); Interlocked.Increment(ref writes);
                        if (DropNextWriteResponse) { DropNextWriteResponse = false; return; }
                        response = request[..5];
                    }
                    else response = [(byte)(request[0] | 0x80), 1];
                    BinaryPrimitives.WriteUInt16BigEndian(header.AsSpan(4, 2), (ushort)(response.Length + 1));
                    await stream.WriteAsync(header, stopping.Token); await stream.WriteAsync(response, stopping.Token);
                }
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or SocketException) { }
        }
        public async ValueTask DisposeAsync() { stopping.Cancel(); listener.Stop(); await loop; await Task.WhenAll(clients); stopping.Dispose(); }
    }
}
