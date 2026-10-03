using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed class PythonRunner(TagEngine tags, QueryExecutor queries, ScriptResourceStore scripts, IConfiguration configuration, RecoveryQuarantine? recovery = null)
{
    private static readonly JsonSerializerOptions ProtocolJson = new(JsonSerializerDefaults.Web);
    public string? Executable { get; } = FindPython(configuration);
    public bool Available => Executable is not null;
    public Func<string?, string, JsonElement, bool, string, CancellationToken, string[]?, Task<JsonObject>>? MessageDispatch { get; set; }
    public Func<string, JsonObject, string?, JsonObject>? UiMessageDispatch { get; set; }
    public Func<JsonArray>? UiSessionInfo { get; set; }
    private static readonly SemaphoreSlim SyntaxSlots = new(4, 4);
    private const string SyntaxCompiler = """
import json, sys
request = json.load(sys.stdin)
try:
    compile(request['code'], '<project-script>', 'exec', dont_inherit=True)
    response = {'valid': True}
except SyntaxError as error:
    response = {'valid': False, 'message': str(error.msg)[:2048], 'line': error.lineno,
                'column': error.offset, 'endLine': error.end_lineno, 'endColumn': error.end_offset}
except (ValueError, RecursionError, MemoryError) as error:
    response = {'valid': False, 'message': 'Source could not be compiled: ' + str(error)[:1024]}
json.dump(response, sys.stdout, allow_nan=False)
sys.stdout.write('\n')
sys.stdout.flush()
""";

    /// <summary>Compile source only. No project imports, worker protocol calls or execution authority.</summary>
    public async Task<JsonObject> ValidateSyntaxAsync(string code, CancellationToken cancellation)
    {
        ArgumentNullException.ThrowIfNull(code);
        if (code.Length > 65_536) throw new ArgumentException("Python source is limited to 65,536 characters.");
        if (Executable is null) throw new InvalidOperationException("Python syntax validation is unavailable because the Python runtime is not installed.");
        cancellation.ThrowIfCancellationRequested();
        using var processSlot = PythonProcessAdmission.Acquire(cancellation);
        if (!await SyntaxSlots.WaitAsync(0, cancellation)) throw new BadHttpRequestException("Python syntax validation is busy. Try again shortly.", 429);
        Process? process = null;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(2000);
        Task? errors = null;
        try
        {
            var info = new ProcessStartInfo(Executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            info.ArgumentList.Add("-I"); info.ArgumentList.Add("-S"); info.ArgumentList.Add("-u"); info.ArgumentList.Add("-c"); info.ArgumentList.Add(SyntaxCompiler);
            info.Environment["PYTHONIOENCODING"] = "utf-8";
            process = Process.Start(info) ?? throw new InvalidOperationException("Python syntax validation could not start.");
            errors = DrainErrors(process.StandardError, deadline.Token);
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { code }, ProtocolJson).AsMemory(), deadline.Token);
            process.StandardInput.Close();
            var line = await process.StandardOutput.ReadLineAsync(deadline.Token);
            if (line is null || line.Length > 8192 || JsonNode.Parse(line) is not JsonObject result || result["valid"] is not JsonValue valid || !valid.TryGetValue<bool>(out _))
                throw new InvalidOperationException("Python syntax validation returned an invalid response.");
            await process.WaitForExitAsync(deadline.Token);
            deadline.Token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw new InvalidOperationException("Python syntax validation could not finish.");
            return result;
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        { throw new BadHttpRequestException("Python syntax validation exceeded its two-second limit. Source was not executed.", 503); }
        catch (System.ComponentModel.Win32Exception error)
        { throw new InvalidOperationException("Python syntax validation is unavailable because the Python runtime could not start.", error); }
        finally
        {
            try
            {
                if (process is not null && !process.HasExited)
                {
                    try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) when (process.HasExited) { }
                    await process.WaitForExitAsync(CancellationToken.None);
                }
                if (errors is not null) try { await errors; } catch (OperationCanceledException) { }
            }
            finally { process?.Dispose(); SyntaxSlots.Release(); }
        }
    }
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

    public Task<JsonObject> RunAsync(string code, Dictionary<string, JsonElement>? parameters, Dictionary<string, JsonElement>? inputs, JsonArray queryDefinitions, CancellationToken cancellation, PythonUiContext? uiContext = null, IReadOnlyDictionary<string, string>? libraries = null)
        => RunWithLibrariesAsync(code, parameters, inputs, libraries ?? scripts.CaptureLibraries(), cancellation, queryDefinitions, uiContext: uiContext);

    public Task<JsonObject> RunComponentEventAsync(string code, Dictionary<string, JsonElement> parameters, Dictionary<string, JsonElement> inputs,
        JsonObject eventContext, JsonArray queryDefinitions, PythonUiContext uiContext, CancellationToken cancellation, IReadOnlyDictionary<string, string>? libraries = null)
        => RunWithLibrariesAsync(code, parameters, inputs, libraries ?? scripts.CaptureLibraries(), cancellation, queryDefinitions, eventContext, timeoutMs: 2000, uiContext: uiContext);

    public async Task<JsonObject> RunWithLibrariesAsync(string code, Dictionary<string, JsonElement>? parameters, Dictionary<string, JsonElement>? inputs,
        IReadOnlyDictionary<string, string> libraries, CancellationToken cancellation, JsonArray? queryDefinitions = null,
        JsonObject? eventContext = null, int timeoutMs = 10000, string[]? messageChain = null, PythonUiContext? uiContext = null)
    {
        recovery?.EnsureOperationsAllowed();
        if (timeoutMs is < 100 or > 300000) throw new ArgumentException("Script timeout must be between 100 and 300000 milliseconds.");
        if (code.Length > 65536) throw new ArgumentException("Scripts are limited to 64 KB.");
        if (Executable is null) throw new InvalidOperationException("Python runtime is not installed. Run tools/bootstrap.ps1.");
        using var processSlot = PythonProcessAdmission.Acquire(cancellation);
        var authority = PythonExecutionAccess.Current;
        uiContext?.CaptureInputs(inputs);
        var worker = Path.Combine(AppContext.BaseDirectory, "python", "worker.py");
        var info = new ProcessStartInfo(Executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(worker)! };
        info.ArgumentList.Add("-I"); info.ArgumentList.Add("-u"); info.ArgumentList.Add(worker);
        info.Environment["PYTHONIOENCODING"] = "utf-8";
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Could not start Python.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(timeoutMs));
        var clock = Stopwatch.StartNew();
        var stderr = DrainErrors(process.StandardError, timeout.Token);
        try
        {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { code, parameters, inputs, libraries, eventContext, uiContext = uiContext?.WorkerContext() }, ProtocolJson).AsMemory(), timeout.Token);
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
                    return PythonUiContext.CompleteResponse(message, uiContext);
                }
                if (message["type"]?.GetValue<string>() != "call" || ++calls > 1000) throw new InvalidOperationException("Invalid Python call or call limit exceeded.");
                object response;
                try
                {
                    var args = message["arguments"]!.AsObject();
                    var method = message["method"]!.GetValue<string>();
                    timeout.Token.ThrowIfCancellationRequested();
                    object? value = method switch
                    {
                        "tag.read" => ReadTags(args, parameters, authority),
                        "tag.write" => WriteTags(args, authority),
                        "db.query" => queryDefinitions is null
                            ? await queries.ExecuteScriptAsync(args["name"]!.GetValue<string>(), args["parameters"]?.Deserialize<Dictionary<string, JsonElement>>(), timeout.Token)
                            : await queries.ExecuteScriptDefinitionAsync(queryDefinitions.OfType<JsonObject>().FirstOrDefault(query => ProjectStore.Optional(query, "id") == args["name"]!.GetValue<string>())
                                ?? throw new KeyNotFoundException("This named query is not part of the published application."), args["parameters"]?.Deserialize<Dictionary<string, JsonElement>>(), timeout.Token),
                        "message.request" => await DispatchMessage(args, false, eventContext, messageChain, timeout.Token),
                        "message.send" => await DispatchMessage(args, true, eventContext, messageChain, timeout.Token),
                        "ui.sendMessage" => (UiMessageDispatch ?? throw new InvalidOperationException("Operator session messaging is unavailable in this execution context."))(
                            ProjectStore.Required(args, "messageType"), args["payload"] as JsonObject ?? throw new ArgumentException("A message payload must be a JSON object."), args["sessionId"]?.GetValue<string>()),
                        "ui.getSessionInfo" => (UiSessionInfo ?? throw new InvalidOperationException("Operator session messaging is unavailable in this execution context."))(),
                        "ui.getState" or "ui.setState" or "ui.getProperty" or "ui.setProperty" =>
                            (uiContext ?? throw new InvalidOperationException("UI helpers are available only in a runtime Python UI action or saved UI Preview context.")).Dispatch(method, args),
                        _ => throw new ArgumentException("Unknown scripting function.")
                    };
                    response = new { result = value };
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { response = new { error = ex.Message }; }
                await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(response, ProtocolJson).AsMemory(), timeout.Token);
                await process.StandardInput.FlushAsync(timeout.Token);
            }
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            return PythonUiContext.CompleteResponse(new JsonObject { ["success"] = false, ["stdout"] = "", ["stderr"] = $"Script exceeded the {timeoutMs / 1000d:g} second execution limit.", ["durationMs"] = clock.Elapsed.TotalMilliseconds }, uiContext);
        }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) when (process.HasExited) { }
                // A resource lease must not be released while its previous worker is alive.
                await process.WaitForExitAsync(CancellationToken.None);
            }
            try { await stderr; } catch (OperationCanceledException) { }
        }
    }
    private TagValue[] ReadTags(JsonObject args, Dictionary<string, JsonElement>? parameters, PythonExecutionAccess? authority)
    {
        var paths = args["paths"]!.Deserialize<string[]>()!;
        var substitutions = args["parameters"]?.Deserialize<Dictionary<string, JsonElement>>() ?? parameters;
        var resolved = paths.Select(path => TagEngine.Resolve(path, substitutions)).ToArray();
        authority?.RequireTags(resolved, false);
        return tags.Read(resolved, null);
    }

    private string[] WriteTags(JsonObject args, PythonExecutionAccess? authority)
    {
        var paths = args["paths"]!.Deserialize<string[]>()!;
        authority?.RequireTags(paths, true);
        return tags.WriteMemory(paths, args["values"]!.Deserialize<JsonElement[]>()!);
    }

    private async Task<JsonObject> DispatchMessage(JsonObject args, bool oneWay, JsonObject? context, string[]? chain, CancellationToken cancellation)
    {
        if (MessageDispatch is null) throw new InvalidOperationException("Gateway messaging is unavailable in this execution context.");
        var seconds = args["timeoutSec"]?.GetValue<double>() ?? 10;
        if (!double.IsFinite(seconds) || seconds < 0.1 || seconds > 300) throw new ArgumentException("Message timeoutSec must be between 0.1 and 300.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(seconds));
        try
        {
            return await MessageDispatch(args["project"]?.GetValue<string>(), ProjectStore.Required(args, "messageHandler"),
                JsonSerializer.SerializeToElement(args["payload"] ?? new JsonObject()), oneWay,
                context?["actor"]?.GetValue<string>() ?? "gateway-script", deadline.Token, chain);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw new InvalidOperationException("Message request timed out."); }
    }
    private static async Task DrainErrors(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[4096];
        while (await reader.ReadAsync(buffer, cancellation) > 0) { }
    }
}
