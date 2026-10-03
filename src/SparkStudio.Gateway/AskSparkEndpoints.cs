using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.Features;

namespace SparkStudio.Gateway;

public static class AskSparkEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static IServiceCollection AddAskSpark(this IServiceCollection services, string dataDirectory)
    {
        services.AddSingleton(provider => new AskSparkSettings(dataDirectory, provider.GetRequiredService<IDataProtectionProvider>()));
        services.AddSingleton(provider => new AskSparkRawLog(dataDirectory, provider.GetRequiredService<AskSparkSettings>(), provider.GetRequiredService<ILogger<AskSparkRawLog>>()));
        services.AddSingleton(_ => new AskSparkUsage(dataDirectory));
        services.AddSingleton(provider => new AskSparkConversations(dataDirectory, provider.GetRequiredService<IDataProtectionProvider>()));
        // Explicit factory prevents DI choosing the synthetic IEnumerable constructor with an empty registration set.
        services.AddSingleton(_ => new AskSparkCatalog());
        services.AddHttpClient<AskSparkGemini>(client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
        services.AddSingleton<IAskSparkModel>(provider => provider.GetRequiredService<AskSparkGemini>());
        services.AddSingleton<AskSparkService>();
        return services;
    }

    public static void MapAskSparkEndpoints(this WebApplication app)
    {
        MapSettings(app);
        app.MapGet("/api/ask-spark/status", (AskSparkService assistant) => assistant.Status()).Access("signedIn");
        app.MapGet("/api/ask-spark/tools", (string? projectId, bool? editorAvailable, HttpContext context, AskSparkService assistant)
            => assistant.Tools(GatewayAccess.Actor(context), projectId, editorAvailable == true)).Access("signedIn");
        app.MapGet("/api/ask-spark/conversations", (HttpContext context, AskSparkConversations conversations)
            => new { conversations = conversations.List(GatewayAccess.Actor(context).Id) }).Access("signedIn");
        app.MapGet("/api/ask-spark/conversations/{id}", ReadConversation).Access("signedIn");
        app.MapDelete("/api/ask-spark/conversations/{id}", (string id, HttpContext context, AskSparkConversations conversations) =>
        { conversations.Delete(GatewayAccess.Actor(context).Id, id); return Results.NoContent(); }).Access("signedIn");
        app.MapPost("/api/ask-spark/turn", Turn).Access("signedIn");
        app.MapPost("/api/ask-spark/confirm", Confirm).Access("signedIn", audit: true);
        app.MapPost("/api/ask-spark/transcribe", Transcribe).Access("signedIn");
    }

    private static void MapSettings(WebApplication app)
    {
        app.MapGet("/api/gateway/ai", (AskSparkSettings settings) => settings.Snapshot()).Access("admin");
        app.MapGet("/api/gateway/ai/usage", (AskSparkUsage usage, AskSparkSettings settings) => usage.Snapshot(settings.Snapshot().MonthlyTokenLimit)).Access("admin");
        app.MapPut("/api/gateway/ai", async (HttpContext context, AskSparkSettings settings, CancellationToken cancellation)
            => settings.Save(await ReadAsync<AskSparkSettingsRequest>(context, 16_384, cancellation))).Access("admin", audit: true);
        app.MapPost("/api/gateway/ai/test", async (AskSparkSettings settings, IAskSparkModel model, CancellationToken cancellation) =>
        {
            await model.TestAsync(cancellation);
            return new { success = true, message = "The saved AI key and model responded successfully.", model = settings.Snapshot().Model };
        }).Access("admin", audit: true);
    }

    private static object ReadConversation(string id, HttpContext context, AskSparkConversations conversations)
    {
        var item = conversations.Read(GatewayAccess.Actor(context).Id, id);
        return new { item.Id, item.Title, item.ProjectId, item.UpdatedAt, item.Messages, item.Actions };
    }

    private static async Task<AskSparkTurnResponse> Turn(HttpContext context, AskSparkService assistant, CancellationToken cancellation)
    {
        var request = await ReadAsync<AskSparkTurnRequest>(context, 14 * 1024 * 1024, cancellation);
        return await assistant.TurnAsync(GatewayAccess.Actor(context), request, cancellation, () => GatewaySecurity.SessionStillValid(context));
    }

    private static async Task<object> Confirm(HttpContext context, AskSparkService assistant, CancellationToken cancellation)
    {
        var request = await ReadAsync<AskSparkConfirmRequest>(context, 4096, cancellation);
        return assistant.Confirm(GatewayAccess.Actor(context), request, () => GatewaySecurity.SessionStillValid(context));
    }

    private static async Task<object> Transcribe(HttpContext context, IAskSparkModel model, CancellationToken cancellation)
    {
        var request = await ReadAsync<AskSparkAudioRequest>(context, 13 * 1024 * 1024, cancellation);
        var text = await model.TranscribeAsync(request, cancellation);
        if (!GatewaySecurity.SessionStillValid(context)) throw new BadHttpRequestException("Sign in again before continuing.", 401);
        return new { text };
    }

    private static async Task<T> ReadAsync<T>(HttpContext context, int limit, CancellationToken cancellation)
    {
        var size = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (size is { IsReadOnly: false }) size.MaxRequestBodySize = limit;
        if (context.Request.ContentLength > limit) throw new BadHttpRequestException("The Ask Spark request exceeds its size limit.", 413);
        using var data = new MemoryStream();
        var buffer = new byte[16_384];
        int count;
        while ((count = await context.Request.Body.ReadAsync(buffer, cancellation)) > 0)
        {
            if (data.Length + count > limit) throw new BadHttpRequestException("The Ask Spark request exceeds its size limit.", 413);
            await data.WriteAsync(buffer.AsMemory(0, count), cancellation);
        }
        return JsonSerializer.Deserialize<T>(data.ToArray(), Json) ?? throw new ArgumentException("A JSON request is required.");
    }
}
