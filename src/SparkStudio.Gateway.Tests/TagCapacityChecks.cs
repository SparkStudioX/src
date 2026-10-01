using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class TagCapacityChecks
{
    private static string PathFor(int index) => "[default]Capacity/" + new string('x', 80) + $"/T{index:D5}";
    private static JsonObject Tag(int index) => new() { ["path"] = PathFor(index), ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 };
    private static JsonObject Package(int count) => new()
    {
        ["format"] = "sparkstudio.tags", ["version"] = 1,
        ["tags"] = new JsonArray(Enumerable.Range(0, count).Select(index => (JsonNode)Tag(index)).ToArray())
    };

    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description) { if (!condition) throw new InvalidOperationException(description); checks++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (ArgumentException) { checks++; return; }
            throw new InvalidOperationException(description);
        }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.TagCapacity." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var protection = new EphemeralDataProtectionProvider();
        try
        {
            Check(TagModel.MaximumTags == 10_000, "the supported expanded-tag ceiling is explicitly10000");
            var storePath = Path.Combine(directory, "direct");
            var store = new ProjectStore(storePath, protection);
            var package = Package(TagModel.MaximumTags);
            var preview = store.PreviewTagImport(package);
            Check(preview.CanApply && preview.TotalTags == 10_000, "legacy version1 preview accepts10000 direct tags");
            store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
            Check(store.GetTagDefinitions().Count == 10_000, "10000-tag import persists the entire model");
            Check(new ProjectStore(storePath, protection).GetTagDefinitions().Count == 10_000, "10000-tag configuration survives reload");
            var before = File.ReadAllBytes(Path.Combine(storePath, "tags.json"));
            var oversized = Package(TagModel.MaximumTags + 1);
            Reject(() => store.PreviewTagImport(oversized), "10001 direct tags were accepted by preview");
            Reject(() => store.ApplyTagImport(new(oversized, preview.Revision, preview.PreviewToken)), "10001 direct tags were accepted by apply");
            Reject(() => store.SaveTag(Tag(10_000)), "individual tag addition bypassed the expanded-tag cap");
            Check(before.SequenceEqual(File.ReadAllBytes(Path.Combine(storePath, "tags.json"))), "all over-limit attempts leave persisted configuration unchanged");
            var existing = Tag(0); existing["value"] = 7; store.SaveTag(existing);
            Check(new ProjectStore(storePath, protection).GetTagDefinitions().OfType<JsonObject>().Single(tag => ProjectStore.Required(tag, "path") == PathFor(0))["value"]!.GetValue<int>() == 7,
                "an existing tag remains editable at capacity and its value survives reload");
            var remove = TagModel.Empty();
            remove["removeTags"] = new JsonArray(Enumerable.Range(0, 10_000).Select(index => (JsonNode)JsonValue.Create(PathFor(index))!).ToArray());
            var removal = store.PreviewTagImport(remove); store.ApplyTagImport(new(remove, removal.Revision, removal.PreviewToken));
            Check(store.GetTagDefinitions().Count == 0 && new ProjectStore(storePath, protection).GetTagDefinitions().Count == 0, "one reviewed bulk operation can remove all10000 direct tags");
            remove["removeTags"]!.AsArray().Add(PathFor(10_000));
            Reject(() => store.PreviewTagImport(remove), "oversized removal list was accepted");

            var mixed = TagModel.Empty();
            mixed["tags"] = Package(9900)["tags"]!.DeepClone();
            mixed["udtDefinitions"]!.AsArray().Add(new JsonObject
            {
                ["id"] = "Hundred", ["version"] = 1,
                ["members"] = new JsonArray(Enumerable.Range(0, 100).Select(index => (JsonNode)new JsonObject
                { ["path"] = "Member" + index, ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 }).ToArray())
            });
            mixed["instances"]!.AsArray().Add(new JsonObject { ["path"] = "[default]Unit", ["definitionId"] = "Hundred", ["version"] = 1, ["overrides"] = new JsonObject() });
            var mixedPath = Path.Combine(directory, "mixed"); var mixedStore = new ProjectStore(mixedPath, protection);
            var mixedPreview = mixedStore.PreviewTagImport(mixed);
            Check(mixedPreview.CanApply && mixedPreview.TotalTags == 10_000, "9900 direct tags and100 UDT members share one10000-tag budget");
            mixedStore.ApplyTagImport(new(mixed, mixedPreview.Revision, mixedPreview.PreviewToken));
            var mixedBefore = File.ReadAllBytes(Path.Combine(mixedPath, "tags.json"));
            mixed["tags"]!.AsArray().Add(Tag(9900));
            var conflict = mixedStore.PreviewTagImport(mixed);
            Check(!conflict.CanApply && conflict.Conflicts!.Any(text => text.Contains("10000", StringComparison.Ordinal)), "version2 preview reports expanded member overflow as an unappliable conflict");
            Reject(() => mixedStore.ApplyTagImport(new(mixed, conflict.Revision, conflict.PreviewToken)), "mixed member overflow was applied");
            Reject(() => mixedStore.SaveTag(Tag(9900)), "single-save accounting ignored UDT members");
            Check(mixedBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(mixedPath, "tags.json"))) && new ProjectStore(mixedPath, protection).GetTagDefinitions().Count == 10_000,
                "failed mixed import is atomic and reload retains all prior definitions");
            var normalized = 0;
            Reject(() => TagModel.Expand(mixed, input => { normalized++; return (JsonObject)input.DeepClone(); }), "expanded overflow was not rejected");
            Check(normalized == 100, "expanded-size preflight rejects overflow after validating the100 template members and before normalizing9901 direct tags");

            var planner = typeof(TagEngine).GetMethod("BuildWatchPlans", BindingFlags.NonPublic | BindingFlags.Static)!;
            var opcDefinitions = Enumerable.Range(0, 10_000).Select(index => new JsonObject
            { ["path"] = PathFor(index), ["connectionId"] = "fixture", ["nodeId"] = $"ns=2;s=Value{index:D5}", ["publishingIntervalMs"] = 1000 }).ToArray();
            Func<string, ConnectionDefinition> connection = id => new(id, id, "opcua", Endpoint: "opc.tcp://127.0.0.1:1", SecurityMode: "None");
            JsonArray Plans(IEnumerable<JsonObject> definitions) => JsonSerializer.SerializeToNode(planner.Invoke(null, [definitions, connection]), ProjectStore.Json)!.AsArray();
            var plans = Plans(opcDefinitions);
            Check(plans.Count == 10 && plans.All(plan => plan!["bindings"]!.AsArray().Count == ConnectorService.MaximumReadNodes), "10000 distinct OPC nodes partition into ten bounded1000-node watches");
            Check(plans.SelectMany(plan => plan!["bindings"]!.AsArray()).Select(binding => binding!["path"]!.GetValue<string>()).Distinct().Count() == 10_000,
                "OPC watch partitioning retains every configured binding exactly once");
            Check(JsonNode.DeepEquals(plans, Plans(opcDefinitions.Reverse())), "equivalent OPC input order preserves deterministic watch identities and bindings");
            Check(plans.Select(plan => plan!["key"]!.GetValue<string>()).Distinct().Count() == plans.Count, "partition watch identities do not collide");
            foreach (var definition in opcDefinitions) definition["nodeId"] = "ns=2;s=Shared";
            var aliases = Plans(opcDefinitions);
            Check(aliases.Count == 1 && aliases[0]!["bindings"]!.AsArray().Count == 10_000, "aliases of one OPC node remain in one watch and do not spend10000 node slots");
            for (var index = 0; index < opcDefinitions.Length; index++)
            { opcDefinitions[index]["nodeId"] = $"ns=2;s=Value{index:D5}"; opcDefinitions[index]["publishingIntervalMs"] = index < 5000 ? 1000 : 2000; }
            var intervals = Plans(opcDefinitions);
            Check(intervals.Count == 10 && intervals.GroupBy(plan => plan!["interval"]!.GetValue<int>()).All(group => group.Count() == 5),
                "partitioning preserves separate publishing-interval groups without raising the overall32-watch limit");

            // Real Kestrel verifies that only the import handlers raise its default
            // body ceiling, including the request wrapper on the apply endpoint.
            var httpStore = new ProjectStore(Path.Combine(directory, "http"), protection);
            using var connectors = new ConnectorService(Path.Combine(directory, "http"));
            using var tags = new TagEngine(httpStore, connectors, NullLogger<TagEngine>.Instance);
            var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(options => { options.Limits.MaxRequestBodySize = 1_048_576; options.Listen(IPAddress.Loopback, 0); });
            builder.Services.AddSingleton(httpStore); builder.Services.AddSingleton(tags);
            await using var app = builder.Build();
            app.Use(async (context, next) =>
            {
                try { await next(); }
                catch (BadHttpRequestException error) { context.Response.StatusCode = error.StatusCode; }
            });
            app.MapGroup("/api").MapTagEngineeringEndpoints();
            app.MapPost("/ordinary", (JsonObject value) => value);
            await app.StartAsync();
            try
            {
                var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
                using var client = new HttpClient { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(30) };
                var bytes = JsonSerializer.SerializeToUtf8Bytes(package, ProjectStore.Json);
                Check(bytes.Length > 1_048_576 && bytes.Length < TagEngineering.MaximumImportBytes, "real10000-tag payload exercises the old1MiB ceiling while remaining bounded");
                using var httpPreview = await client.PostAsJsonAsync("/api/tag-engineering/preview", package, ProjectStore.Json);
                Check(httpPreview.IsSuccessStatusCode, "tag preview accepts an authorized-style JSON request above1MiB");
                var reviewed = await httpPreview.Content.ReadFromJsonAsync<TagImportPreview>(ProjectStore.Json) ?? throw new InvalidOperationException("Preview was empty.");
                using var httpApply = await client.PostAsJsonAsync("/api/tag-engineering/apply", new TagImportRequest(package, reviewed.Revision, reviewed.PreviewToken), ProjectStore.Json);
                Check(httpApply.IsSuccessStatusCode && tags.Snapshot().Length == 10_000, "tag apply accepts its large wrapped request and populates10000 live memory tags");
                // Advertise the known length and wait for the server's admission
                // response. A streamed upload can race the deliberate 413 close
                // and report a transport reset while still sending its body.
                using var oversizedRequest = new HttpRequestMessage(HttpMethod.Post, "/ordinary") { Content = new ByteArrayContent(bytes) };
                oversizedRequest.Content.Headers.ContentType = new("application/json");
                oversizedRequest.Headers.ExpectContinue = true;
                using var ordinary = await client.SendAsync(oversizedRequest);
                Check((int)ordinary.StatusCode == 413, "ordinary routes retain the global1MiB request-body limit");
            }
            finally { await app.StopAsync(); }

            var reader = typeof(TagEngineering).GetMethod("ReadImportAsync", BindingFlags.NonPublic | BindingFlags.Static)!.MakeGenericMethod(typeof(JsonObject));
            async Task RejectBody(DefaultHttpContext context, string description)
            {
                try { await (Task<JsonObject>)reader.Invoke(null, [context])!; }
                catch (BadHttpRequestException error) when (error.StatusCode == 413) { checks++; return; }
                throw new InvalidOperationException(description);
            }
            var known = new DefaultHttpContext(); known.Request.ContentType = "application/json"; known.Request.ContentLength = TagEngineering.MaximumImportBytes + 1;
            await RejectBody(known, "known oversized bodies were not rejected before parsing");
            var chunked = new DefaultHttpContext(); chunked.Request.ContentType = "application/json";
            using var generated = new WhitespaceStream(TagEngineering.MaximumImportBytes + 1); chunked.Request.Body = generated;
            await RejectBody(chunked, "unknown-length oversized bodies were not bounded while streaming");
        }
        finally
        {
            var temporary = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != temporary) throw new InvalidOperationException("Fixture escaped its temporary root.");
            Directory.Delete(directory, recursive: true);
        }
        return checks;
    }

    private sealed class WhitespaceStream(long remaining) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        { var read = (int)Math.Min(remaining, count); Array.Fill(buffer, (byte)' ', offset, read); remaining -= read; return read; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { cancellationToken.ThrowIfCancellationRequested(); var read = (int)Math.Min(remaining, buffer.Length); buffer.Span[..read].Fill((byte)' '); remaining -= read; return ValueTask.FromResult(read); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
