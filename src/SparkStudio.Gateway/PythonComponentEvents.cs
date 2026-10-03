using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ComponentEventSelector(string Family, string? Type = null, string? HandlerId = null);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record PythonComponentEventRequest(ComponentEventSelector EventHandler, JsonObject Event,
    Dictionary<string, JsonElement>? Parameters = null, Dictionary<string, JsonElement>? Inputs = null,
    string? PublishedAt = null, string? InstanceId = null, string? RowId = null, PopupOrigin? PopupOrigin = null,
    IReadOnlyList<InstancePathStep>? InstancePath = null, IReadOnlyList<Dictionary<string, JsonElement>>? BindingInputs = null,
    IReadOnlyList<ParameterBindingState>? BindingState = null, JsonObject? Ui = null);

/// <summary>Automatic Python events resolve trusted definitions; all event values remain untrusted presentation inputs.</summary>
public static class PythonComponentEvents
{
    public static void MapPythonComponentEventEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/runtime/screens/{screenId}/components/{componentId}/events", async (string screenId, string componentId,
            PythonComponentEventRequest request, RuntimeActions actions, HttpContext context, CancellationToken cancellation) =>
        {
            var result = await actions.ExecuteComponentEventAsync(screenId, componentId, request, GatewayAccess.Actor(context).Username, cancellation);
            context.Items["spark.actionOutcome"] = result["success"]?.GetValue<bool>() == true ? "Completed" : "Event failed";
            return result;
        }).Access("operate", "operator", audit: true);
        routes.MapPost("/preview/screens/{screenId}/components/{componentId}/events", async (string screenId, string componentId,
            PythonComponentEventRequest request, RuntimeActions actions, ProjectStore store, PreviewSessions sessions, HttpContext context, CancellationToken cancellation) =>
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, sessions.Require(context, liveActions: true));
            return await actions.ExecutePreviewComponentEventAsync(store, screenId, componentId, false, request, GatewayAccess.Actor(context).Username, linked.Token);
        }).WithMetadata(new PreviewEndpoint("script")).Access("admin", audit: true);
        routes.MapPost("/preview/templates/{templateId}/components/{componentId}/events", async (string templateId, string componentId,
            PythonComponentEventRequest request, RuntimeActions actions, ProjectStore store, PreviewSessions sessions, HttpContext context, CancellationToken cancellation) =>
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, sessions.Require(context, liveActions: true));
            return await actions.ExecutePreviewComponentEventAsync(store, templateId, componentId, true, request, GatewayAccess.Actor(context).Username, linked.Token);
        }).WithMetadata(new PreviewEndpoint("script")).Access("admin", audit: true);
    }

    internal static void HideSources(JsonObject props)
    {
        foreach (var name in new[] { "events", "componentEvents" })
            if (props[name] is JsonObject events)
                foreach (var definition in events.Select(pair => pair.Value).OfType<JsonObject>())
                    if (ProjectStore.Optional(definition, "language") == "python") definition.Remove("code");
        if (props["messageHandlers"] is JsonArray handlers)
            foreach (var handler in handlers.OfType<JsonObject>())
                if (ProjectStore.Optional(handler, "language") == "python") handler.Remove("code");
    }

    public static JsonObject Capture(JsonObject project, JsonArray queries, string documentId, string componentId,
        PythonComponentEventRequest request, bool standalone = false)
    {
        ValidateRequest(request);
        var screen = (standalone ? ProjectTemplates.Templates(project) : project["screens"]!.AsArray().OfType<JsonObject>())
            .FirstOrDefault(item => ProjectStore.Optional(item, "id") == documentId)
            ?? throw new KeyNotFoundException("Saved event screen or template not found.");
        JsonObject? opener = null;
        if (!standalone && ProjectTemplates.ScreenKind(screen) == "popup")
        {
            var origin = request.PopupOrigin ?? throw new ArgumentException("Popup events require their saved opener identity.");
            var originScreen = project["screens"]!.AsArray().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == origin.ScreenId)
                ?? throw new KeyNotFoundException("Popup opener screen not found.");
            if (ProjectTemplates.ScreenKind(originScreen) != "screen") throw new ArgumentException("A popup opener must belong to a regular screen.");
            var resolved = ProjectInteractions.ResolveLeaf(project, originScreen, origin.ComponentId, origin.InstanceId, origin.RowId, origin.InstancePath);
            if (ProjectStore.Optional(resolved.Component, "type") is not ("button" or "equipmentSymbol") || resolved.Component["props"] is not JsonObject originProps ||
                ProjectStore.Optional(originProps, "action") != "openPopup" || ProjectStore.Optional(originProps, "targetScreenId") != documentId)
                throw new ArgumentException("The saved opener does not open this popup.");
            opener = new JsonObject { ["screenParameters"] = ProjectTemplates.ScreenParameters(originScreen).DeepClone(),
                ["templateScopes"] = resolved.TemplateScopes, ["parameters"] = originProps["parameters"]?.DeepClone() ?? new JsonObject() };
        }
        else if (request.PopupOrigin is not null) throw new ArgumentException("Regular screen and standalone template events must not include a popup opener.");
        var (component, scope, templateScopes) = ProjectInteractions.ResolveLeaf(project, screen, componentId, request.InstanceId, request.RowId, request.InstancePath);
        if (ProjectStore.Optional(component, "type") == "passwordInput" && request.EventHandler.Family == "input")
            throw new ArgumentException("Password inputs do not send automatic Python change/commit events.");
        var definition = Handler(component, request.EventHandler);
        var inputs = scope["components"]!.AsArray().OfType<JsonObject>()
            .Where(item => InputDefinitionValidator.IsInput(ProjectStore.Required(item, "type")) && ProjectStore.Optional(item, "type") != "passwordInput")
            .Select(item => (JsonNode)new JsonObject { ["type"] = item["type"]!.DeepClone(), ["fieldKey"] = item["props"]!["fieldKey"]!.DeepClone() }).ToArray();
        var result = new JsonObject {
            ["code"] = definition["code"]!.DeepClone(), ["eventDefinition"] = definition.DeepClone(), ["eventComponent"] = component.DeepClone(),
            ["projectParameters"] = project["parameters"]!.DeepClone(), ["screenParameters"] = standalone ? new JsonObject() : ProjectTemplates.ScreenParameters(screen).DeepClone(),
            ["templateScopes"] = templateScopes, ["popupOrigin"] = opener, ["inputs"] = new JsonArray(inputs), ["queries"] = queries.DeepClone(),
            ["uiContext"] = PythonUiContext.Describe(project, screen, scope, componentId, standalone || templateScopes.Count > 0)
        };
        if (standalone) { result["standaloneParameters"] = screen["parameters"]?.DeepClone() ?? new JsonObject(); result["standaloneParameterTypes"] = screen["parameterTypes"]?.DeepClone(); }
        return result;
    }

    private static void ValidateRequest(PythonComponentEventRequest request)
    {
        if (request.EventHandler is not { } selector || selector.Family is not ("input" or "propertyChange" or "message" or "lifecycle" or "interaction") ||
            (selector.Family == "input" ? selector.Type is not ("change" or "commit") || selector.HandlerId is not null :
             selector.Family == "lifecycle" ? selector.Type is not ("mount" or "unmount") :
             selector.Family == "interaction" ? selector.Type is null || !ComponentEventValidator.InteractionNames.Contains(selector.Type) : selector.Type is not null) ||
            (selector.Family == "message" ? string.IsNullOrWhiteSpace(selector.HandlerId) || selector.HandlerId.Length > 80 : selector.HandlerId is not null))
            throw new ArgumentException("Choose a saved input, lifecycle, interaction, property-change or message handler.");
        if (request.Event is null || System.Text.Encoding.UTF8.GetByteCount(request.Event.ToJsonString()) > 100_000)
            throw new ArgumentException("An event payload must be an object up to 100,000 UTF-8 bytes.");
        if (request.Inputs?.Count > 1000 || System.Text.Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(request.Inputs)) > 262_144)
            throw new ArgumentException("Event input snapshots are limited to 1,000 fields and 256 KiB.");
    }

    private static JsonObject Handler(JsonObject component, ComponentEventSelector selector)
    {
        var props = component["props"]!.AsObject();
        var definition = selector.Family switch {
            "input" when InputDefinitionValidator.IsInput(ProjectStore.Required(component, "type")) => props["events"]?[selector.Type!] as JsonObject,
            "propertyChange" => props["componentEvents"]?["propertyChange"] as JsonObject,
            "lifecycle" => props["componentEvents"]?[selector.Type!] as JsonObject,
            "interaction" => props["componentEvents"]?[selector.Type!] as JsonObject,
            "message" => (props["messageHandlers"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == selector.HandlerId),
            _ => null
        };
        if (definition is null || ProjectStore.Optional(definition, "language") != "python")
            throw new KeyNotFoundException("This saved component has no matching Python event handler.");
        return definition;
    }

    public static Dictionary<string, JsonElement> Inputs(JsonObject action, Dictionary<string, JsonElement>? supplied)
    {
        var definitions = action["inputs"]!.AsArray().OfType<JsonObject>().ToDictionary(item => ProjectStore.Required(item, "fieldKey"), StringComparer.Ordinal);
        var inputs = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, value) in supplied ?? [])
        {
            if (!definitions.TryGetValue(key, out var definition)) throw new ArgumentException("Automatic event inputs cannot include undeclared or password fields.");
            // Unavailable tag/binding samples remain null in the local form.
            // Only an input event's own current value is required below.
            InputScalar(ProjectStore.Required(definition, "type"), JsonNode.Parse(value.GetRawText()), true);
            inputs[key] = value.Clone();
        }
        return inputs;
    }

    public static JsonObject Event(JsonObject action, PythonComponentEventRequest request, Dictionary<string, JsonElement> inputs, string actor)
    {
        var selector = request.EventHandler;
        var component = action["eventComponent"]!.AsObject();
        var definition = action["eventDefinition"]!.AsObject();
        var input = request.Event;
        var allowed = selector.Family switch {
            "input" => new[] { "type", "componentId", "fieldKey", "value", "previousValue", "origin" },
            "propertyChange" => ["type", "componentId", "property", "value", "previousValue", "available", "previousAvailable", "error", "previousError", "origin"],
            "lifecycle" => ["type", "componentId"],
            "interaction" => InteractionFields(selector.Type!),
            _ => ["type", "componentId", "messageType", "payload", "scope", "messageId"]
        };
        if (input.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal))) throw new ArgumentException("The event contains unsupported fields.");
        var result = new JsonObject { ["actor"] = actor };
        void Identity(string key, string value)
        {
            if (input.ContainsKey(key) && (input[key] is not JsonValue scalar || !scalar.TryGetValue<string>(out var submitted) || submitted != value))
                throw new ArgumentException($"Event {key} does not match its saved handler.");
            result[key] = value;
        }
        Identity("componentId", ProjectStore.Required(component, "id"));
        Identity("type", selector.Family is "input" or "lifecycle" or "interaction" ? selector.Type! : selector.Family);
        if (selector.Family == "lifecycle") return result;
        if (selector.Family == "interaction")
        {
            Identity("origin", "user");
            if (selector.Type is "focus" or "blur") return result;
            foreach (var key in new[] { "altKey", "ctrlKey", "metaKey", "shiftKey" }) result[key] = EventBoolean(input[key], key);
            if (selector.Type is "keyDown" or "keyUp")
            {
                var redacted = EventBoolean(input["redacted"], "redacted");
                var key = Text(input["key"], "key", 128); var code = Text(input["code"], "code", 64);
                if (ProjectStore.Optional(component, "type") == "passwordInput" && (!redacted || key.Length > 0 || code.Length > 0) || redacted && (key.Length > 0 || code.Length > 0))
                    throw new ArgumentException("Password keyboard events must redact key and code.");
                result["key"] = key; result["code"] = code; result["redacted"] = redacted;
                result["repeat"] = EventBoolean(input["repeat"], "repeat"); result["isComposing"] = EventBoolean(input["isComposing"], "isComposing");
            }
            else
            {
                result["button"] = EventNumber(input["button"], "button", -1, 5, integer: true);
                result["buttons"] = EventNumber(input["buttons"], "buttons", 0, 63, integer: true);
                result["clientX"] = EventNumber(input["clientX"], "clientX", -10_000_000, 10_000_000);
                result["clientY"] = EventNumber(input["clientY"], "clientY", -10_000_000, 10_000_000);
                if (selector.Type != "doubleClick")
                {
                    var pointerType = Text(input["pointerType"], "pointerType", 8);
                    if (pointerType is not ("mouse" or "pen" or "touch" or "")) throw new ArgumentException("Unsupported pointer type.");
                    result["pointerType"] = pointerType;
                    result["pointerId"] = EventNumber(input["pointerId"], "pointerId", -1, int.MaxValue, integer: true);
                }
            }
            return result;
        }
        if (selector.Family == "message")
        {
            Identity("messageType", ProjectStore.Required(definition, "messageType"));
            Identity("scope", ProjectStore.Required(definition, "scope"));
            ComponentEventValidator.ValidateMessageAction(new JsonObject { ["messageType"] = result["messageType"]!.DeepClone(), ["scope"] = result["scope"]!.DeepClone(), ["payload"] = input["payload"]?.DeepClone() });
            result["payload"] = input["payload"]!.DeepClone();
            if (input.ContainsKey("messageId")) result["messageId"] = Text(input["messageId"], "messageId", 128);
            return result;
        }
        if (!input.ContainsKey("value") || !input.ContainsKey("previousValue")) throw new ArgumentException("Events require value and previousValue fields.");
        if (selector.Family == "input")
        {
            var key = ProjectStore.Required(component["props"]!.AsObject(), "fieldKey");
            Identity("fieldKey", key);
            InputScalar(ProjectStore.Required(component, "type"), input["value"], false);
            InputScalar(ProjectStore.Required(component, "type"), input["previousValue"], true);
            if (!inputs.TryGetValue(key, out var current) || !JsonNode.DeepEquals(input["value"], JsonNode.Parse(current.GetRawText())))
                throw new ArgumentException("The input event value must match its current input snapshot.");
        }
        else
        {
            var property = Text(input["property"], "property", 80);
            if (!definition["properties"]!.AsArray().Any(item => item?.GetValue<string>() == property)) throw new ArgumentException("This property is not watched by the saved handler.");
            result["property"] = property;
            foreach (var key in new[] { "available", "previousAvailable" })
            {
                if (input[key] is not JsonValue scalar || !scalar.TryGetValue<bool>(out var value)) throw new ArgumentException("Property events require Boolean availability fields.");
                result[key] = value;
            }
            foreach (var (valueKey, availableKey) in new[] { ("value", "available"), ("previousValue", "previousAvailable") })
            {
                if (!result[availableKey]!.GetValue<bool>()) { if (input[valueKey] is not null) throw new ArgumentException("Unavailable properties must have null values."); continue; }
                if (property == "value" && InputDefinitionValidator.IsInput(ProjectStore.Required(component, "type")))
                    InputScalar(ProjectStore.Required(component, "type"), input[valueKey], false);
                else { var scalar = Scalar(input[valueKey], false); ComponentBindingValidator.ValidateScalarTarget(property, scalar!); }
            }
            foreach (var key in new[] { "error", "previousError" }) if (input.ContainsKey(key)) result[key] = Text(input[key], key, 4096);
        }
        result["value"] = input["value"]?.DeepClone(); result["previousValue"] = input["previousValue"]?.DeepClone();
        var origin = input.ContainsKey("origin") ? Text(input["origin"], "origin", 32) : selector.Family == "input" ? "user" : "configuration";
        if (origin is not ("user" or "binding" or "script" or "input" or "configuration")) throw new ArgumentException("Unknown event origin.");
        result["origin"] = origin;
        return result;
    }

    private static string Text(JsonNode? node, string label, int maximum) => node is JsonValue scalar && scalar.TryGetValue<string>(out var text) && text.Length <= maximum
        ? text : throw new ArgumentException($"Event {label} must be text up to {maximum} characters.");

    private static string[] InteractionFields(string type) => type is "focus" or "blur" ? ["type", "componentId", "origin"]
        : type is "keyDown" or "keyUp" ? ["type", "componentId", "origin", "key", "code", "repeat", "isComposing", "redacted", "altKey", "ctrlKey", "metaKey", "shiftKey"]
        : type == "doubleClick" ? ["type", "componentId", "origin", "button", "buttons", "clientX", "clientY", "altKey", "ctrlKey", "metaKey", "shiftKey"]
        : ["type", "componentId", "origin", "button", "buttons", "clientX", "clientY", "pointerId", "pointerType", "altKey", "ctrlKey", "metaKey", "shiftKey"];
    private static bool EventBoolean(JsonNode? node, string label) => node is JsonValue value && value.TryGetValue<bool>(out var result)
        ? result : throw new ArgumentException($"Event {label} must be Boolean.");
    private static double EventNumber(JsonNode? node, string label, double minimum, double maximum, bool integer = false)
    {
        if (node is JsonValue value && double.TryParse(value.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var result) &&
            double.IsFinite(result) && result >= minimum && result <= maximum && (!integer || result == Math.Truncate(result))) return result;
        throw new ArgumentException($"Event {label} must be a finite {(integer ? "integer" : "number")} from {minimum} to {maximum}.");
    }

    private static object? Scalar(JsonNode? node, bool nullable)
    {
        if (node is null && nullable) return null;
        if (node is JsonValue value)
        {
            if (value.TryGetValue<string>(out var text) && text.Length <= 4096) return text;
            if (value.TryGetValue<bool>(out var flag)) return flag;
            if (double.TryParse(value.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number) &&
                double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991)) return number;
        }
        throw new ArgumentException("Event values must be bounded text, Boolean or finite numbers with safe integers.");
    }

    private static void InputScalar(string type, JsonNode? node, bool nullable)
    {
        var value = Scalar(node, nullable);
        if (value is null && nullable) return;
        // Numeric controls retain incomplete/invalid edits as bounded text. This
        // snapshot is for authored validation, never a validated form submission.
        var valid = type is "numberInput" or "spinner" or "slider" ? value is double or string
            : type is "checkbox" or "toggle" ? value is bool : type != "passwordInput" && value is string;
        if (!valid) throw new ArgumentException("The event input value does not match its saved input type.");
    }
}

public sealed partial class PublicationStore
{
    public JsonObject GetComponentEvent(string screenId, string componentId, PythonComponentEventRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.PublishedAt)) throw new ArgumentException("Reload the published screen before executing an event.");
        lock (gate)
        {
            var current = RequirePublication(request.PublishedAt);
            var action = PythonComponentEvents.Capture(current["project"]!.AsObject(), (current["scriptQueries"] ?? current["queries"])!.AsArray(), screenId, componentId, request);
            action["libraries"] = CaptureLibraries(current);
            return action;
        }
    }
}

public sealed partial class RuntimeActions
{
    private static readonly SemaphoreSlim GatewayEventSlots = new(16, 16);
    private static readonly object EventAdmissionGate = new();
    private static int gatewayEventWaiters;
    private readonly SemaphoreSlim componentEventSlots = new(4, 4);
    private bool componentEventsClosed;
    private int componentEventUsers;
    private int componentEventWaiters;
    private readonly object componentEventGate = new();
    private readonly Queue<(string Actor, long Time)> recentComponentEvents = new();

    private ComponentEventLease AcquireComponentEventLease()
    {
        lock (componentEventGate) {
            if (componentEventsClosed) throw new InvalidOperationException("This project's component event runtime has stopped.");
            componentEventUsers++;
            return new(this);
        }
    }
    private void ReleaseComponentEventLease()
    {
        lock (componentEventGate) {
            componentEventUsers--;
            if (componentEventsClosed && componentEventUsers == 0) componentEventSlots.Dispose();
        }
    }
    private sealed class ComponentEventLease(RuntimeActions owner) : IDisposable
    {
        private int disposed;
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) owner.ReleaseComponentEventLease(); }
    }

    public Task<JsonObject> ExecuteComponentEventAsync(string screenId, string componentId, PythonComponentEventRequest request, string actor, CancellationToken cancellation)
        => ExecuteCapturedEventAsync(() => publications.GetComponentEvent(screenId, componentId, request), request, actor, cancellation);

    public Task<JsonObject> ExecutePreviewComponentEventAsync(ProjectStore store, string documentId, string componentId, bool standalone,
        PythonComponentEventRequest request, string actor, CancellationToken cancellation)
        => ExecuteCapturedEventAsync(() => {
            if (request.PublishedAt is not null) throw new ArgumentException("Preview events use the saved draft, not a publication stamp.");
            lock (GatewayConfigurationLock.SyncRoot) return PythonComponentEvents.Capture(store.GetProject(), store.GetQueries(), documentId, componentId, request, standalone);
        }, request, actor, cancellation);

    private async Task<JsonObject> ExecuteCapturedEventAsync(Func<JsonObject> capture, PythonComponentEventRequest request, string actor, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        using var admission = AcquireComponentEventLease();
        lock (componentEventGate)
        {
            var now = Environment.TickCount64;
            while (recentComponentEvents.TryPeek(out var first) && now - first.Time >= 1000) recentComponentEvents.Dequeue();
            if (recentComponentEvents.Count >= 128 || recentComponentEvents.Count(item => item.Actor == actor) >= 32)
                throw new BadHttpRequestException("Python component event rate limit reached. Reduce automatic event frequency.", 429);
            recentComponentEvents.Enqueue((actor, now));
        }
        var gatewaySlot = false; var componentSlot = false; var waiting = false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(2000);
        void LeaveQueue()
        {
            lock (EventAdmissionGate)
            {
                if (!waiting) return;
                waiting = false; componentEventWaiters--; gatewayEventWaiters--;
            }
        }
        try
        {
            // Bounds count actual waiting requests, independently of running
            // workers. Async semaphore waits are removed by cancellation, so an
            // abandoned or expired request never starts a delayed script.
            lock (EventAdmissionGate)
            {
                if (componentEventWaiters >= 32) throw new BadHttpRequestException("This project's Python component event queue is full (32 waiting events).", 429);
                if (gatewayEventWaiters >= 128) throw new BadHttpRequestException("The gateway's Python component event queue is full (128 waiting events).", 429);
                waiting = true; componentEventWaiters++; gatewayEventWaiters++;
            }
            await componentEventSlots.WaitAsync(deadline.Token); componentSlot = true;
            await GatewayEventSlots.WaitAsync(deadline.Token); gatewaySlot = true;
            LeaveQueue();
            deadline.Token.ThrowIfCancellationRequested();
            var action = capture();
            var ui = new PythonUiContext(action["uiContext"]!.AsObject(), request.Ui,
                readOnly: request.EventHandler is { Family: "lifecycle", Type: "unmount" });
            var inputs = PythonComponentEvents.Inputs(action, request.Inputs);
            var eventContext = PythonComponentEvents.Event(action, request, inputs, actor);
            var parameters = await ResolveContextAsync(action, request.Parameters, request.BindingInputs, request.PopupOrigin?.BindingInputs,
                request.BindingState, request.PopupOrigin?.BindingState, deadline.Token);
            var result = await python.RunComponentEventAsync(action["code"]!.GetValue<string>(), parameters, inputs, eventContext, action["queries"]!.AsArray(), ui, deadline.Token, CapturedLibraries(action));
            deadline.Token.ThrowIfCancellationRequested();
            return result;
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            return new JsonObject { ["success"] = false, ["stdout"] = "", ["stderr"] = "Python component event exceeded the 2 second queue and execution limit.", ["result"] = null, ["uiEffects"] = new JsonArray() };
        }
        finally { LeaveQueue(); if (gatewaySlot) GatewayEventSlots.Release(); if (componentSlot) componentEventSlots.Release(); }
    }
}
