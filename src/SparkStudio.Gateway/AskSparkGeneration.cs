using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Only complete provider generations may propose tools or claim completion.</summary>
public static class AskSparkGeneration
{
    public const int MaximumFailures = 3;
    private static readonly HashSet<string> KnownFailures = new(StringComparer.Ordinal)
    {
        "MAX_TOKENS", "MALFORMED_FUNCTION_CALL", "MALFORMED_RESPONSE", "UNEXPECTED_TOOL_CALL",
        "TOO_MANY_TOOL_CALLS", "EMPTY_RESPONSE", "BLOCKED_PROMPT", "SAFETY", "RECITATION",
        "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT", "IMAGE_OTHER", "NO_IMAGE", "IMAGE_RECITATION",
        "MISSING_THOUGHT_SIGNATURE", "ESCALATION"
    };

    public static string? Failure(AskSparkModelReply reply)
    {
        var reason = reply.FinishReason;
        if (reason is not (null or "" or "STOP" or "FINISH_REASON_UNSPECIFIED"))
            return KnownFailures.Contains(reason) ? reason : "OTHER";
        var calls = (reply.Content["parts"] as JsonArray ?? []).OfType<JsonObject>().Any(part => part["functionCall"] is JsonObject);
        return !calls && string.IsNullOrWhiteSpace(AskSparkGemini.VisibleText(reply.Content)) ? "EMPTY_RESPONSE" : null;
    }

    public static bool CanRetry(string reason) => reason is "MAX_TOKENS" or "MALFORMED_FUNCTION_CALL"
        or "MALFORMED_RESPONSE" or "UNEXPECTED_TOOL_CALL" or "TOO_MANY_TOOL_CALLS" or "EMPTY_RESPONSE";

    public static void AddRecovery(JsonArray contents, string reason) => AddNotice(contents,
        $"Ask Spark generation recovery ({reason}): the previous provider response was invalid or incomplete and was discarded before execution. "
        + "No tools from that response were executed. Continue the user's original task from the successful receipts already in this conversation; "
        + "do not repeat earlier completed changes. Use native structured function calls with valid JSON arguments and the loaded schemas, "
        + "not textual call expressions or code. Discover unloaded tools with find_tools first. Make the next edit a small batch of at most "
        + "10 components (fewer for long scripts), then continue remaining batches after their receipts using each returned snapshotToken. "
        + "If prior state or execution is uncertain, inspect it first. Do not claim completion until the requested work is done and verified. "
        + "If only a final text answer remains, return a concise complete answer.");

    public static string Stopped(string reason, int failures, bool stepLimit, bool finalAnswer)
    {
        var why = stepLimit ? "The configured model-step limit was reached."
            : failures >= MaximumFailures ? "Automatic recovery stopped after three invalid or incomplete model responses."
            : finalAnswer ? "The final summary could not be generated."
            : "The provider stopped this response; automatic recovery is not available for this status.";
        return $"Ask Spark could not finish this request ({reason}). {why} No tools from the failed response were executed. "
            + "Earlier completed changes remain, but the task is not complete. Review the current state before continuing.";
    }

    public static void AddFinalNotice(JsonArray contents, bool stepLimit) => AddNotice(contents,
        (stepLimit ? "The configured model-step limit has been reached." : "The tool-discovery recovery limit has been reached.")
        + " No more tool calls are available in this response. Summarize only changes confirmed by successful receipts, "
        + "explicitly list unfinished work, and explain this stopping limit. Do not claim the entire task is complete unless the receipts establish that.");

    private static void AddNotice(JsonArray contents, string text)
    {
        // Append only to application-owned user content. Never rewrite signed model parts or
        // replay failed candidate content / finishMessage as a tool call or a trusted instruction.
        if (contents.LastOrDefault() is JsonObject last && last["role"]?.GetValue<string>() == "user" && last["parts"] is JsonArray parts)
            parts.Add(new JsonObject { ["text"] = text });
        else contents.Add(AskSparkGemini.TextContent("user", text));
    }
}
