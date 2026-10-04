using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class ModelReadApiChecks
{
    public static async Task<int> RunAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.ModelReadApi." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try { return await Exercise(directory); }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())))
                throw new InvalidOperationException("Invalid fixture directory.");
            Directory.Delete(directory, true);
        }
    }

    private static async Task<int> Exercise(string directory)
    {
        var protection = new EphemeralDataProtectionProvider();
        var catalog = new ProjectCatalog(directory, protection);
        using var connectors = new ConnectorService(directory);
        var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => { GatewayReadiness.ConfigureTransport(options); options.Listen(IPAddress.Loopback, 0); });
        builder.Services.AddSingleton<IDataProtectionProvider>(protection);
        builder.Services.AddGatewaySecurity(directory);
        builder.Services.AddSingleton(catalog); builder.Services.AddSingleton(catalog.GatewayStore);
        builder.Services.AddSingleton(connectors); builder.Services.AddSingleton<TagEngine>();
        await using var app = builder.Build();
        app.Use(async (context, next) =>
        {
            try { await next(); }
            catch (Exception error)
            {
                context.Response.StatusCode = error switch { BadHttpRequestException bad => bad.StatusCode, ArgumentException => 400, KeyNotFoundException => 404, _ => 500 };
                await context.Response.WriteAsJsonAsync(new { error = error.Message });
            }
        });
        app.UseRouting(); app.UseAuthentication(); app.UseApplicationAccess(); app.MapGatewaySecurityEndpoints();
        app.MapGroup("/api").MapModelReadEndpoints(); app.MapGroup("/api/projects/{projectId}").MapModelReadEndpoints();
        await app.StartAsync();
        try
        {
            var security = app.Services.GetRequiredService<SecurityStore>();
            const string password = "Synthetic-ModelRead-Only-123!";
            var admin = security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("model-admin", password));
            var id = catalog.DefaultId;
            var viewer = security.CreateUser(new("model-viewer", password, ProjectGrants: new() { [id] = new(View: true) }));
            var designer = security.CreateUser(new("model-designer", password, ProjectGrants: new() { [id] = new(Design: true) }));
            var configurator = security.CreateUser(new("model-configurator", password, ProjectGrants: new() { [id] = new(Design: true) }, GatewayCapabilities: new(Configuration: true)));
            var configurationOnly = security.CreateUser(new("model-config-only", password, GatewayCapabilities: new(Configuration: true)));
            var configurationViewer = security.CreateUser(new("model-config-viewer", password, ProjectGrants: new() { [id] = new(View: true) }, GatewayCapabilities: new(Configuration: true)));
            var diagnosticOnly = security.CreateUser(new("model-diagnostic-only", password, GatewayCapabilities: new(Diagnostics: true)));
            security.UpdateSettings(new(security.SettingsRevision, null, new() { [id] = ["[default]Plant/CNC01/Speed"] }));
            catalog.GatewayStore.SaveConnection(new JsonObject { ["id"] = "private-opc", ["name"] = "Synthetic disabled source", ["type"] = "opcua", ["endpoint"] = "opc.tcp://127.0.0.1:1", ["enabled"] = false });
            var package = JsonNode.Parse("""
                {"format":"sparkstudio.tags","version":3,"tags":[],"scanGroups":[{"name":"PrivateScan","publishingIntervalMs":500}],"hierarchy":[],
                 "udtDefinitions":[{"id":"CNC","version":1,"description":"Logical CNC","semanticType":"isa95:WorkUnit",
                   "parameters":[{"name":"Source","type":"String","default":"private-default"},{"name":"Counter","type":"Int64","default":9223372036854775807}],"members":[
                   {"path":"Speed","kind":"memory","dataType":"Double","value":7200,"unit":"rev/min","description":"Actual speed"},
                   {"path":"Count","kind":"memory","dataType":"Int64","value":12},
                   {"path":"Alias","kind":"reference","dataType":"Double","target":"./Speed"},
                   {"path":"Derived","kind":"expression","dataType":"Double","expression":"speed * 2","inputs":{"speed":"./Speed"}},
                   {"path":"Opc","kind":"opcua","dataType":"Double","connectionId":"private-opc","nodeId":"ns=2;s=Private.Speed","scanGroup":"PrivateScan","publishingIntervalMs":500,"absoluteDeadband":1,"queueSize":4,"enabled":false},
                   {"path":"Nested","kind":"type","definitionId":"Module","version":1,"parameters":{"Source":"{Source}"}}]},
                   {"id":"Module","version":1,"parameters":[{"name":"Source","type":"String","default":"private-nested-default"}],"members":[{"path":"Flag","kind":"memory","dataType":"Boolean","value":true}]}],
                 "instances":[{"path":"[default]Plant/CNC01","definitionId":"CNC","version":1,"parameters":{"Source":"private-instance"},"overrides":{}},
                   {"path":"[default]Plant/CNC02","definitionId":"CNC","version":1,"overrides":{}}]}
                """)!.AsObject();
            var preview = catalog.GatewayStore.PreviewTagImport(package);
            app.Services.GetRequiredService<TagEngine>().ApplyImport(new(package, preview.Revision, preview.PreviewToken));
            var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            var count = await Requests(address, id, new(admin.Username, viewer.Username, designer.Username, configurator.Username), password, security);
            return count + await ConfigurationOnlyAccess(address, id, configurationOnly.Username, configurationViewer.Username, diagnosticOnly.Username, password, security);
        }
        finally { await app.StopAsync(); }
    }

    private sealed record Users(string Admin, string Viewer, string Designer, string Configurator);

    private static async Task<int> Requests(string address, string projectId, Users users, string password, SecurityStore security)
    {
        var count = 0;
        using var guest = new Client(address, "operator");
        var root = "/api/projects/" + projectId + "/model";
        await guest.Get(root + "/types", 401); count++;
        using var read = new Client(address, "operator"); await read.Login(users.Viewer, password, projectId);
        var instances = await read.Get(root + "/instances");
        if (instances["total"]!.GetValue<int>() != 1) throw new InvalidOperationException("API leaked a denied instance."); count++;
        var obj = await read.Get(root + "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC01"));
        if (obj["restrictedMembers"]!.GetValue<int>() != 5 || obj["members"]!["Count"] is not null || obj["members"]!["Speed"]!["value"]!.GetValue<double>() != 7200)
            throw new InvalidOperationException("Object API did not retain live values and omit denied members."); count++;
        await read.Get(root + "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC02"), 404); count++;
        var types = await read.Get(root + "/types");
        if (types["items"]![0]!["members"]!.AsArray().Count != 1) throw new InvalidOperationException("Type API leaked a denied member."); count++;
        var tree = await read.Get(root + "/tree?depth=8");
        if (tree.ToJsonString().Contains("CNC02", StringComparison.Ordinal) || tree.ToJsonString().Contains("Count", StringComparison.Ordinal))
            throw new InvalidOperationException("Tree API leaked a denied member or instance."); count++;
        await read.Get("/api/projects/ungranted/model/types", 403); count++;
        await read.Get(root + "/tree?depth=9", 400); count++;
        using var engineer = new Client(address, "engineering"); await engineer.Login(users.Admin, password, projectId);
        var all = await engineer.Get(root + "/instances");
        if (all["total"]!.GetValue<int>() != 2) throw new InvalidOperationException("Engineering model read unexpectedly filtered instances."); count++;
        await engineer.Get("/api/model/types"); count++;
        count += await ConfigurationAccess(address, projectId, users, password, security);
        return count;
    }

    private static async Task<int> ConfigurationAccess(string address, string projectId, Users users, string password, SecurityStore security)
    {
        // Full tag scope is deliberately independent from permission to inspect saved sources.
        security.UpdateSettings(new(security.SettingsRevision, null, new() { [projectId] = ["*"] }));
        var root = "/api/projects/" + projectId + "/model";
        var count = 0;
        foreach (var identity in new[] { (users.Viewer, "operator"), (users.Designer, "engineering"), (users.Admin, "operator") })
        {
            using var client = new Client(address, identity.Item2); await client.Login(identity.Item1, password, projectId);
            AssertLogicalTypes(await client.Get(root + "/types")); count++;
            AssertLogicalTypes(await client.Get("/api/model/types")); count++;
            var obj = await client.Get(root + "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC01"));
            AssertRestrictedParameters(obj);
            if (obj["restrictedMembers"]!.GetValue<int>() != 0 || obj["members"]!["Speed"]!["value"]!.GetValue<double>() != 7200)
                throw new InvalidOperationException("Configuration redaction must retain all authorized live members and their values."); count++;
            foreach (var item in (await client.Get(root + "/instances"))["items"]!.AsArray().OfType<JsonObject>()) AssertRestrictedParameters(item); count++;
            foreach (var item in (await client.Get(root + "/tree?depth=8"))["items"]!.AsArray().OfType<JsonObject>().Where(item => item["kind"]!.GetValue<string>() == "instance")) AssertRestrictedParameters(item); count++;
        }
        using var configure = new Client(address, "engineering"); await configure.Login(users.Configurator, password, projectId);
        var types = await configure.Get(root + "/types");
        var cnc = types["items"]!.AsArray().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "CNC");
        var opc = cnc["members"]!.AsArray().OfType<JsonObject>().Single(item => item["path"]!.GetValue<string>() == "Opc");
        if (opc["connectionId"]!.GetValue<string>() != "private-opc" || opc["nodeId"]!.GetValue<string>() != "ns=2;s=Private.Speed" || cnc["parameters"]![1]!["default"]!.GetValue<string>() != "9223372036854775807")
            throw new InvalidOperationException("Explicit Configuration permission must retain source settings and exact defaults."); count++;
        var configured = await configure.Get(root + "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC01"));
        if (configured["parameters"]!["Source"]!.GetValue<string>() != "private-instance" || configured["parameterValuesRestricted"]!.GetValue<bool>())
            throw new InvalidOperationException("Explicit Configuration permission must retain instance parameter values."); count++;
        return count;
    }

    private static async Task<int> ConfigurationOnlyAccess(string address, string projectId, string configurator, string viewer, string diagnostic, string password, SecurityStore security)
    {
        var count = 0;
        using var configure = new Client(address, "engineering"); await configure.Login(configurator, password, null);
        var suffixes = new[] { "/units", "/types", "/instances", "/tree?depth=8", "/issues", "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC01") };
        foreach (var suffix in suffixes)
        {
            await configure.Get("/api/model" + suffix); count++;
            await configure.Get("/api/projects/" + projectId + "/model" + suffix, 403); count++;
        }
        var model = await configure.Get("/api/model/object?path=" + Uri.EscapeDataString("[default]Plant/CNC01"));
        if (model["parameters"]!["Source"]!.GetValue<string>() != "private-instance" || model["parameterValuesRestricted"]!.GetValue<bool>())
            throw new InvalidOperationException("Configuration-only model workspace must retain authorized instance settings."); count++;
        using var diagnostics = new Client(address, "engineering"); await diagnostics.Login(diagnostic, password, null);
        foreach (var suffix in suffixes) { await diagnostics.Get("/api/model" + suffix, 403); count++; }
        security.UpdateSettings(new(security.SettingsRevision, null, new() { [projectId] = ["[default]Plant/CNC01/Speed"] }));
        using var operation = new Client(address, "operator"); await operation.Login(viewer, password, projectId);
        foreach (var root in new[] { "/api/model", "/api/projects/" + projectId + "/model" })
        {
            var obj = await operation.Get(root + "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC01"));
            if (obj["restrictedMembers"]!.GetValue<int>() != 5 || obj["members"]!["Count"] is not null)
                throw new InvalidOperationException("Gateway Configuration must not bypass operator tag scopes.");
            AssertRestrictedParameters(obj); count++;
            await operation.Get(root + "/object?path=" + Uri.EscapeDataString("[default]Plant/CNC02"), 404); count++;
        }
        await operation.Get("/api/projects/ungranted/model/types", 403); count++;
        return count;
    }

    private static void AssertLogicalTypes(JsonObject response)
    {
        var definitions = response["items"]!.AsArray().OfType<JsonObject>().ToArray();
        var allowed = new HashSet<string>(["path", "kind", "dataType", "definitionId", "version", "unit", "description", "range", "semanticType", "attributes"], StringComparer.Ordinal);
        foreach (var definition in definitions)
        {
            foreach (var member in definition["members"]!.AsArray().OfType<JsonObject>())
                if (member.Any(field => !allowed.Contains(field.Key))) throw new InvalidOperationException("A non-configuring model reader received member acquisition settings.");
            foreach (var parameter in (definition["parameters"] as JsonArray ?? []).OfType<JsonObject>())
                if (parameter.ContainsKey("default")) throw new InvalidOperationException("A non-configuring model reader received a parameter default.");
        }
        var cnc = definitions.Single(item => item["id"]!.GetValue<string>() == "CNC");
        var members = cnc["members"]!.AsArray().OfType<JsonObject>().ToDictionary(item => item["path"]!.GetValue<string>(), StringComparer.Ordinal);
        if (cnc["description"]!.GetValue<string>() != "Logical CNC" || members.Count != 6 || members["Speed"]["unit"]!.GetValue<string>() != "rev/min" || members["Nested"]["definitionId"]!.GetValue<string>() != "Module")
            throw new InvalidOperationException("Configuration redaction lost logical metadata or nested type identity.");
    }

    private static void AssertRestrictedParameters(JsonObject instance)
    {
        if (instance["parameters"]!.AsObject().Count != 0 || !instance["parameterValuesRestricted"]!.GetValue<bool>())
            throw new InvalidOperationException("Full tag scope exposed saved instance parameter values without Configuration permission.");
    }

    private sealed class Client(string address, string audience) : IDisposable
    {
        private readonly HttpClient http = new(new HttpClientHandler { CookieContainer = new(), AllowAutoRedirect = false, UseProxy = false }) { BaseAddress = new(address), Timeout = TimeSpan.FromSeconds(20) };
        public async Task Login(string username, string password, string? projectId)
        {
            using var response = await http.PostAsJsonAsync("/api/auth/login", new { audience, username, password, projectId });
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Fixture login failed: " + await response.Content.ReadAsStringAsync());
        }
        public async Task<JsonObject> Get(string path, int status = 200)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path); request.Headers.Add("X-SPARK-AUDIENCE", audience);
            using var response = await http.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            if ((int)response.StatusCode != status) throw new InvalidOperationException($"{path}: expected {status}, received {(int)response.StatusCode}: {text}");
            return JsonNode.Parse(text)?.AsObject() ?? new();
        }
        public void Dispose() => http.Dispose();
    }
}
