using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Opc.Ua;

internal static class GatewaySubscriptionLifecycle
{
    public static void ValidateAddress(Uri gateway)
    {
        if (!gateway.IsAbsoluteUri || gateway.Scheme != "http" || gateway.Port != 5091 ||
            gateway.Host is not ("127.0.0.1" or "localhost" or "[::1]") || gateway.AbsolutePath != "/" ||
            gateway.UserInfo.Length != 0 || gateway.Query.Length != 0 || gateway.Fragment.Length != 0)
            throw new ArgumentException("Gateway lifecycle checks require an isolated HTTP gateway at localhost:5091.");
    }

    public static async Task RunAsync(Uri gateway, string opcEndpoint, Action<bool, string> check)
    {
        ValidateAddress(gateway);
        using var http = new HttpClient { BaseAddress = gateway, Timeout = TimeSpan.FromSeconds(10) };
        var fixtureId = "subscription-test-" + Guid.NewGuid().ToString("N");
        var prefix = "[default]Lifecycle_" + fixtureId + "/";
        var anchor = prefix + "Anchor";
        var disabled = prefix + "Disabled";
        var converted = prefix + "Converted";
        var deleted = prefix + "Deleted";
        var remapped = prefix + "Remapped";
        var paths = new[] { anchor, disabled, converted, deleted, remapped };
        var timeNode = VariableIds.Server_ServerStatus_CurrentTime.ToString();
        var stateNode = VariableIds.Server_ServerStatus_State.ToString();
        var connection = new JsonObject { ["id"] = fixtureId, ["name"] = fixtureId, ["type"] = "opcua", ["endpoint"] = opcEndpoint, ["securityMode"] = "None" };

        async Task<JsonNode?> Send(HttpMethod method, string path, JsonNode? body = null, HttpStatusCode expected = HttpStatusCode.OK)
        {
            using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
            using var response = await http.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            if (response.StatusCode != expected) throw new InvalidOperationException($"Lifecycle request {method} {path} returned {(int)response.StatusCode}: {text}");
            return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        }
        async Task<JsonObject> Read(string path)
        {
            var response = await Send(HttpMethod.Post, "/api/tags/read", new JsonObject { ["paths"] = new JsonArray(path) });
            return response!.AsArray()[0]!.AsObject();
        }
        async Task<JsonArray> Subscriptions() => (await Send(HttpMethod.Get, "/api/opcua/subscriptions"))!.AsArray();
        JsonObject OpcTag(string path, string? node = null, bool enabled = true, int interval = 100) => new()
        {
            ["path"] = path, ["kind"] = "opcua", ["connectionId"] = fixtureId,
            ["nodeId"] = node ?? timeNode, ["enabled"] = enabled, ["publishingIntervalMs"] = interval
        };
        static bool Good(JsonObject value) => value["quality"]?.GetValue<string>()?.StartsWith("Good", StringComparison.Ordinal) == true;
        async Task WaitFor(Func<Task<bool>> condition, string description)
        {
            var elapsed = Stopwatch.StartNew();
            while (!await condition())
            {
                if (elapsed.Elapsed > TimeSpan.FromSeconds(15)) throw new TimeoutException("Lifecycle check timed out: " + description);
                await Task.Delay(50);
            }
        }
        async Task Remains(Func<Task<bool>> condition, string description)
        {
            var elapsed = Stopwatch.StartNew();
            do
            {
                if (!await condition()) throw new InvalidOperationException("Lifecycle invariant failed: " + description);
                await Task.Delay(50);
            } while (elapsed.Elapsed < TimeSpan.FromSeconds(2));
            check(true, description);
            Console.WriteLine("PASS gateway lifecycle: " + description);
        }
        async Task<bool> Connected(int count) => (await Subscriptions()).OfType<JsonObject>().Any(value =>
            value["connectionId"]?.GetValue<string>() == fixtureId && value["state"]?.GetValue<string>() == "Connected" && value["tagCount"]?.GetValue<int>() == count);

        try
        {
            var health = await Send(HttpMethod.Get, "/api/health");
            check(health?["status"]?.GetValue<string>() == "ok", "isolated gateway is healthy before lifecycle checks");
            await Send(HttpMethod.Post, "/api/connections", connection);
            foreach (var path in paths) await Send(HttpMethod.Post, "/api/tags", OpcTag(path));
            await WaitFor(async () => await Connected(5) && Good(await Read(anchor)), "five mapped tags become connected");
            check(true, "gateway exposes an active five-tag monitored-item subscription");
            var first = (await Read(anchor))["value"]!.ToJsonString();
            await WaitFor(async () => (await Read(anchor))["value"]!.ToJsonString() != first, "subscription delivers changing server time");
            check(true, "mapped gateway tags change through monitored-item notifications");
            Console.WriteLine("PASS gateway lifecycle: mapped tags are Good and update through a connected subscription.");

            await Send(HttpMethod.Post, "/api/tags", OpcTag(disabled, enabled: false));
            await Remains(async () => (await Read(disabled))["quality"]?.GetValue<string>() == "Bad_Disabled", "disabled tag stays Bad_Disabled during continuing notifications");
            await WaitFor(() => Connected(4), "disabled tag removed from active watch");
            check(true, "disabled tag removed from the monitored binding set");

            await Send(HttpMethod.Post, "/api/tags", new JsonObject
            {
                ["path"] = converted, ["kind"] = "memory", ["enabled"] = true,
                ["dataType"] = "Int32", ["value"] = 471234, ["publishingIntervalMs"] = 100
            });
            await Remains(async () =>
            {
                var value = await Read(converted);
                return Good(value) && value["source"]?.GetValue<string>() == "memory" && value["value"]?.GetValue<int>() == 471234;
            }, "OPC-to-memory conversion keeps its configured value despite old notifications");
            await WaitFor(() => Connected(3), "converted tag removed from active watch");
            check(true, "memory conversion reduces the monitored binding set");

            await Send(HttpMethod.Delete, "/api/tag-definitions?path=" + Uri.EscapeDataString(deleted), expected: HttpStatusCode.NoContent);
            await Remains(async () => (await Read(deleted))["quality"]?.GetValue<string>() == "Bad_NotFound", "deleted cached tag does not reappear from late callbacks");
            await WaitFor(() => Connected(2), "deleted tag removed from active watch");
            check(true, "deleted tag removed from the monitored binding set");

            await Send(HttpMethod.Post, "/api/tags", OpcTag(remapped, stateNode));
            await WaitFor(async () => Good(await Read(remapped)) && (await Read(remapped))["value"] is JsonValue state && state.TryGetValue<int>(out var number) && number == 0, "remapped node reads ServerState.Running");
            await Remains(async () =>
            {
                var value = await Read(remapped);
                return Good(value) && value["value"] is JsonValue state && state.TryGetValue<int>(out var number) && number == 0;
            }, "node remap stays on the new integer node without old timestamp values returning");

            await Send(HttpMethod.Post, "/api/tags", OpcTag(remapped, stateNode, interval: 250));
            await WaitFor(async () =>
            {
                var active = (await Subscriptions()).OfType<JsonObject>().Where(value => value["connectionId"]?.GetValue<string>() == fixtureId).ToArray();
                return active.Length == 2 && active.All(value => value["state"]?.GetValue<string>() == "Connected") &&
                    active.Select(value => value["publishingIntervalMs"]?.GetValue<int>()).Order().SequenceEqual(new int?[] { 100, 250 });
            }, "publishing interval change rebuilds subscription plans");
            check(true, "publishing interval changes safely rebuild the subscription plans");

            connection["name"] = fixtureId + " reconfigured";
            await Send(HttpMethod.Post, "/api/connections", connection);
            await WaitFor(async () => Good(await Read(anchor)) && Good(await Read(remapped)), "connection change rebuilds watchers");
            await Remains(async () =>
            {
                var memory = await Read(converted);
                var disabledValue = await Read(disabled);
                var deletedValue = await Read(deleted);
                var remappedValue = await Read(remapped);
                return memory["source"]?.GetValue<string>() == "memory" && memory["value"]?.GetValue<int>() == 471234 &&
                    disabledValue["quality"]?.GetValue<string>() == "Bad_Disabled" && deletedValue["quality"]?.GetValue<string>() == "Bad_NotFound" &&
                    Good(remappedValue) && remappedValue["value"] is JsonValue state && state.TryGetValue<int>(out var number) && number == 0;
            }, "connection reconfiguration preserves disabled, converted, deleted and remapped tag invariants");
        }
        finally
        {
            foreach (var path in paths)
            {
                using var response = await http.DeleteAsync("/api/tag-definitions?path=" + Uri.EscapeDataString(path));
                if (response.StatusCode is not (HttpStatusCode.NoContent or HttpStatusCode.NotFound))
                    throw new InvalidOperationException("Could not clean up an isolated lifecycle test tag.");
            }
            await WaitFor(async () => !(await Subscriptions()).OfType<JsonObject>().Any(value => value["connectionId"]?.GetValue<string>() == fixtureId), "fixture subscriptions stop after cleanup");
            check(true, "all fixture tags and subscription registrations are removed after lifecycle checks");
            Console.WriteLine($"Lifecycle cleanup complete. Isolated connection fixture retained (no connection-delete API): {fixtureId}");
        }
    }
}
