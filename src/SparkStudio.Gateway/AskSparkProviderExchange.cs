using System.Text;

namespace SparkStudio.Gateway;

/// <summary>Captures the actual provider bodies without recording authentication headers.</summary>
internal static class AskSparkProviderExchange
{
    public static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpRequestMessage request, string operation,
        AskSparkRawLog? rawLog, int responseLimit, CancellationToken cancellation)
    {
        if (rawLog is null) return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        operation = $"{operation} {request.Method} {request.RequestUri?.AbsolutePath}";
        var exchangeId = Guid.NewGuid().ToString("N");
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
        // Diagnostics must retain the request/reply pair even if the operation is canceled.
        await rawLog.WriteAsync(operation, exchangeId, "request", body, cancellation: CancellationToken.None);
        HttpResponseMessage response;
        try { response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation); }
        catch
        {
            await rawLog.WriteAsync(operation, exchangeId, "transport-error", "No HTTP response was received; the provider outcome is unknown.", cancellation: CancellationToken.None);
            throw;
        }
        try
        {
            await BufferResponseAsync(response, rawLog, operation, exchangeId, responseLimit, cancellation);
            return response;
        }
        catch { response.Dispose(); throw; }
    }

    private static async Task BufferResponseAsync(HttpResponseMessage response, AskSparkRawLog rawLog, string operation,
        string exchangeId, int limit, CancellationToken cancellation)
    {
        using var bytes = new MemoryStream();
        var complete = false;
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
            var buffer = new byte[16_384];
            int count;
            while ((count = await stream.ReadAsync(buffer, cancellation)) > 0)
            {
                if (bytes.Length + count > limit)
                {
                    bytes.Write(buffer, 0, limit - checked((int)bytes.Length));
                    throw new InvalidDataException("The AI response exceeded its size limit.");
                }
                bytes.Write(buffer, 0, count);
            }
            complete = true;
        }
        catch (Exception error) when (!response.IsSuccessStatusCode && (error is IOException or InvalidDataException or HttpRequestException or OperationCanceledException))
        {
            // The HTTP rejection is authoritative even if its diagnostic body is
            // incomplete. Preserve it for cache fallback and usage reconciliation.
        }
        finally
        {
            await rawLog.WriteAsync(operation, exchangeId, complete ? "response" : "response-incomplete",
                Encoding.UTF8.GetString(bytes.GetBuffer(), 0, checked((int)bytes.Length)), (int)response.StatusCode, CancellationToken.None);
        }
        var original = response.Content;
        var buffered = new ByteArrayContent(bytes.ToArray());
        foreach (var header in original.Headers) buffered.Headers.TryAddWithoutValidation(header.Key, header.Value);
        response.Content = buffered;
        original.Dispose();
    }
}
