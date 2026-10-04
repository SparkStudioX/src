using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

public static class ModelPublishingEndpoints
{
    public static IServiceCollection AddModelPublishing(this IServiceCollection services, string dataDirectory)
    {
        services.AddSingleton(provider => new ModelPublishingStore(dataDirectory, provider.GetRequiredService<IDataProtectionProvider>()));
        services.AddSingleton(provider => new ModelPublishingService(provider.GetRequiredService<ModelPublishingStore>(),
            path => provider.GetRequiredService<TagEngine>().ReadModel(index => index.PrepareObject(path, _ => true)), dataDirectory,
            provider.GetRequiredService<RecoveryQuarantine>().EnsureOperationsAllowed));
        services.AddHostedService(provider => provider.GetRequiredService<ModelPublishingService>());
        return services;
    }
    public static void MapModelPublishingEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/model/publishing", (ModelPublishingStore store, ModelPublishingService service) => Snapshot(store, service)).Access("configuration");
        routes.MapPut("/model/publishing/{id}", (string id, ModelPublishingSave request, ModelPublishingStore store, ModelPublishingService service, RecoveryQuarantine recovery) =>
        {
            recovery.EnsureOperationsAllowed();
            if (ModelPublishingStore.Validate(request.Publisher).Id != id) throw new ArgumentException("Publisher ID must match the route.");
            _ = service.Preview(request.Publisher); // Saved equipment must exist before an enabled background job can use it.
            store.Save(request);
            return Snapshot(store, service);
        }).Access("configuration", audit: true);
        routes.MapDelete("/model/publishing/{id}", (string id, int revision, bool? discardPending, ModelPublishingStore store, ModelPublishingService service, RecoveryQuarantine recovery) =>
        {
            recovery.EnsureOperationsAllowed(); store.Delete(id, revision, discardPending == true); return Snapshot(store, service);
        }).Access("configuration", audit: true);
        routes.MapPost("/model/publishing/preview", (ModelPublishingPreview request, ModelPublishingService service) =>
        {
            var messages = service.Preview(request.Publisher);
            long previewBytes = 0;
            var selected = messages.Take(100).TakeWhile(message => (previewBytes += message.Bytes) <= 1024 * 1024).ToArray();
            return new { messages = selected.Select(message => new { message.Topic, Payload = JsonNode.Parse(message.Payload), bytes = message.Bytes }),
                total = messages.Length, truncated = messages.Length > selected.Length, delivery = "Preview only. No broker connection or publication occurred." };
        }).Access("configuration");
        routes.MapPost("/model/publishing/{id}/test", (string id, ModelPublishingService service, CancellationToken cancellation) => service.TestAsync(id, cancellation)).Access("configuration", audit: true);
        routes.MapPost("/model/publishing/{id}/discard", (string id, ModelPublishingStore store, RecoveryQuarantine recovery) =>
        {
            recovery.EnsureOperationsAllowed(); _ = store.Runtime(id); return new { discarded = store.Discard(id) };
        }).Access("configuration", audit: true);
    }
    private static object Snapshot(ModelPublishingStore store, ModelPublishingService service)
    {
        var snapshot = store.RuntimeSnapshot(); return new { snapshot.Revision, snapshot.Publishers, diagnostics = service.Diagnostics() };
    }
}
