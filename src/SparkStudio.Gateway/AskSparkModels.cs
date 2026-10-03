using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AskSparkSettingsRequest(string Revision, bool Enabled, string Model, int ParallelLimit = 4, string? ApiKey = null, bool ClearApiKey = false, long MonthlyTokenLimit = 0, int ModelStepLimit = 100)
{
    public override string ToString() => "AskSparkSettingsRequest { credential redacted }";
}
public sealed record AskSparkSettingsSnapshot(string Revision, bool Enabled, string Model, bool HasApiKey, int ParallelLimit, long MonthlyTokenLimit = 0, int ModelStepLimit = 100);
public sealed record AskSparkTool(string Name, string Description, JsonObject Parameters, string Category, string Kind, string Target, string Permission, bool Confirmation, bool ParallelSafe);
public sealed record AskSparkToolCall(string Id, string Name, JsonObject Arguments, string Kind, string Target, bool Confirmation, bool ParallelSafe, string? ApprovalToken, bool Authorized);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AskSparkToolResult(string Id, string Name, JsonNode? Result, AskSparkImage[]? Images = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AskSparkTurnRequest(string? ConversationId = null, string? Message = null, JsonObject? Context = null, AskSparkToolResult[]? ToolResults = null, string? ContinuationToken = null, AskSparkImage[]? Images = null);
public sealed record AskSparkImage(string Data, string MimeType, string? Name = null, string? Id = null)
{
    public override string ToString() => "AskSparkImage { image omitted }";
}
public sealed record AskSparkImageInfo(string Name, string MimeType, int Width, int Height, string? Id = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AskSparkConfirmRequest(string ConversationId, string Token, bool Approved);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AskSparkAudioRequest(string Audio, string MimeType)
{
    public override string ToString() => "AskSparkAudioRequest { audio omitted }";
}
public sealed record AskSparkMessage(string Role, string Text, DateTimeOffset CreatedAt, AskSparkImageInfo[]? Images = null);
public sealed record AskSparkConversationSummary(string Id, string Title, DateTimeOffset UpdatedAt, string? ProjectId, bool Unreadable = false);
public sealed record AskSparkAction(string Id, string Tool, string Kind, string Status, DateTimeOffset CreatedAt);
public sealed record AskSparkTurnResponse(string ConversationId, string? Reply, AskSparkToolCall[] ToolCalls, string? ContinuationToken, AskSparkAction[] Actions, int ParallelLimit);
public sealed record AskSparkModelContext(string ToolDirectory, string CacheScope);
public sealed record AskSparkTokenUsage(int PromptTokens, int CachedTokens, int OutputTokens, int ThoughtTokens, int TotalTokens);
public sealed record AskSparkModelReply(JsonObject Content, int Tokens, AskSparkTokenUsage? Usage = null);
public interface IAskSparkModel
{
    Task<AskSparkModelReply> GenerateAsync(JsonArray contents, IReadOnlyList<AskSparkTool> tools, bool finalAnswer, CancellationToken cancellation);
    Task<AskSparkModelReply> GenerateAsync(JsonArray contents, IReadOnlyList<AskSparkTool> tools, bool finalAnswer, AskSparkModelContext? context, CancellationToken cancellation)
        => GenerateAsync(contents, tools, finalAnswer, cancellation);
    Task<string> TranscribeAsync(AskSparkAudioRequest audio, CancellationToken cancellation);
    Task TestAsync(CancellationToken cancellation);
}
