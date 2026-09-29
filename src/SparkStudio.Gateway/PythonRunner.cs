using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed class PythonRunner(TagEngine tags, QueryExecutor queries, ScriptResourceStore scripts, IConfiguration configuration)
{
    private static readonly JsonSerializerOptions ProtocolJson = new(JsonSerializerDefaults.Web);
    public string? Executable { get; } = FindPython(configuration);
    public bool Available => Executable is not null;
    private static string? FindPython(IConfiguration config)
    {
        var specified = Environment.GetEnvironmentVariable("SPARKSTUDIO_PYTHON") ?? config["Python:Executable"];
        if (!string.IsNullOrEmpty(specified)) return specified;
        if (!OperatingSystem.IsWindows()) return File.Exists("/usr/bin/python3") ? "/usr/bin/python3" : null;
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "runtimes", "python", "windows-x64", "python.exe");
            if (File.Exists(path)) return path;
        }
        return null;
    }
    public Task<JsonObject> RunAsync(string code, Dictionary<string, JsonElement>? parameters, CancellationToken cancellation)
        => RunAsync(code, parameters, null, cancellation);

    public Task<JsonObject> RunAsync(string code, Dictionary<string, JsonElement>? parameters, Dictionary<string, JsonElement>? inputs, CancellationToken cancellation)
        => RunWithLibrariesAsync(code, parameters, inputs, scripts.CaptureLibraries(), cancellation);

    public Task<JsonObject> RunAsync(string code, Dictionary<string, JsonElement>? parameters, Dictionary<string, JsonElement>? inputs, CancellationToken cancellation, JsonArray queryDefinitions)
        => RunWithLibrariesAsync(code, parameters, inputs, scripts.CaptureLibraries(), cancellation, queryDefinitions);

    public async Task<JsonObject> RunWithLibrariesAsync(string code, Dictionary<string, JsonElement>? parameters, Dictionary<string, JsonElement>? inputs,
        IReadOnlyDictionary<string, string> libraries, CancellationToken cancellation, JsonArray? queryDefinitions = null)
    {
        if (code.Length > 65536) throw new ArgumentException("Scripts are limited to 64 KB.");
        if (Executable is null) throw new InvalidOperationException("Python runtime is not installed. Run tools/bootstrap.ps1.");
        var worker = Path.Combine(AppContext.BaseDirectory, "python", "worker.py");
        var info = new ProcessStartInfo(Executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(worker)! };
        info.ArgumentList.Add("-I"); info.ArgumentList.Add("-u"); info.ArgumentList.Add(worker);
        info.Environment["PYTHONIOENCODING"] = "utf-8";
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Could not start Python.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var clock = Stopwatch.StartNew();
        var stderr = DrainErrors(process.StandardError, timeout.Token);
        try
        {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { code, parameters, inputs, libraries }, ProtocolJson));
            await process.StandardInput.FlushAsync(timeout.Token);
            var calls = 0;
            while (true)
            {
                var line = await process.StandardOutput.ReadLineAsync(timeout.Token);
                if (line is null) throw new InvalidOperationException("Python worker exited without a result.");
                if (line.Length > 2_000_000) throw new InvalidOperationException("Python output exceeded its limit.");
                var message = JsonNode.Parse(line)?.AsObject() ?? throw new InvalidOperationException("Invalid Python worker response.");
                if (message["type"]?.GetValue<string>() == "result")
                {
                    message.Remove("type"); message["durationMs"] = clock.Elapsed.TotalMilliseconds;
                    await process.WaitForExitAsync(timeout.Token);
                    return message;
                }
                if (message["type"]?.GetValue<string>() != "call" || ++calls > 1000) throw new InvalidOperationException("Invalid Python call or call limit exceeded.");
                object response;
                try
                {
                    var args = message["arguments"]!.AsObject();
                    var method = message["method"]!.GetValue<string>();
                    object? value = method switch
                    {
                        "tag.read" => tags.Read(args["paths"]!.Deserialize<string[]>()!, args["parameters"]?.Deserialize<Dictionary<string, JsonElement>>() ?? parameters),
                        "tag.write" => tags.WriteMemory(args["paths"]!.Deserialize<string[]>()!, args["values"]!.Deserialize<JsonElement[]>()!),
                        "db.query" => queryDefinitions is null
                            ? await queries.ExecuteScriptAsync(args["name"]!.GetValue<string>(), args["parameters"]?.Deserialize<Dictionary<string, JsonElement>>(), timeout.Token)
                            : await queries.ExecuteScriptDefinitionAsync(queryDefinitions.OfType<JsonObject>().FirstOrDefault(query => ProjectStore.Optional(query, "id") == args["name"]!.GetValue<string>())
                                ?? throw new KeyNotFoundException("This named query is not part of the published application."), args["parameters"]?.Deserialize<Dictionary<string, JsonElement>>(), timeout.Token),
                        _ => throw new ArgumentException("Unknown scripting function.")
                    };
                    response = new { result = value };
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { response = new { error = ex.Message }; }
                await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(response, ProtocolJson));
                await process.StandardInput.FlushAsync(timeout.Token);
            }
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            return new JsonObject { ["success"] = false, ["stdout"] = "", ["stderr"] = "Script exceeded the 10 second execution limit.", ["durationMs"] = clock.Elapsed.TotalMilliseconds };
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            try { await stderr; } catch (OperationCanceledException) { }
        }
    }
    private static async Task DrainErrors(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[4096];
        while (await reader.ReadAsync(buffer, cancellation) > 0) { }
    }
}
