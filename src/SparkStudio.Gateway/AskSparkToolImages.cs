using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Validated local pixels are Gemini multimodal parts, never large JSON strings or remote URLs.</summary>
public static class AskSparkToolImages
{
    public static void ValidateTurn(AskSparkToolResult[] results)
    {
        var images = results.SelectMany(result => result.Images ?? []).ToArray();
        if (images.Any(image => image is null || image.Data is null)) throw new ArgumentException("Tool images require image data.");
        if (images.Length > 4 || images.Sum(image => (long)image.Data.Length) > 12 * 1024 * 1024)
            throw new ArgumentException("A tool round supports at most four frames with 12 MiB of encoded image data.");
    }

    public static void Add(JsonObject response, AskSparkPending pending, AskSparkImage[]? images)
    {
        if (images is null || images.Length == 0) return;
        if (pending.Call.Name != "spark_designer_capture_canvas") throw new ArgumentException("This tool cannot return image frames.");
        if (pending.Declined || pending.Call.Kind != "read" || !pending.Call.Authorized) throw new ArgumentException("Only an authorized capture may return a frame.");
        if (images.Length != 1) throw new ArgumentException("Each capture returns exactly one frame.");
        var image = images[0];
        if (image is null) throw new ArgumentException("A tool image requires image data.");
        var info = AskSparkData.ValidateImage(image);
        var displayName = "capture-" + pending.Call.Id;
        // Gemini Generate Content supports image parts nested inside a functionResponse.
        // https://ai.google.dev/gemini-api/docs/generate-content/function-calling#multimodal_function_responses
        response["parts"] = new JsonArray(new JsonObject { ["inlineData"] = new JsonObject
        { ["mimeType"] = image.MimeType, ["data"] = image.Data, ["displayName"] = displayName } });
        response["response"]!["images"] = new JsonArray(new JsonObject
        {
            ["image"] = new JsonObject { ["$ref"] = displayName }, ["name"] = info.Name,
            ["imageId"] = info.Id, ["width"] = info.Width, ["height"] = info.Height, ["mimeType"] = info.MimeType
        });
    }
}
