using System.Diagnostics;
using System.Net;
using Microsoft.AspNetCore.Server.Kestrel.Core;

namespace SparkStudio.Gateway;

/// <summary>One bounded, fixed startup probe; polling cannot execute project scripts or spawn processes.</summary>
public sealed class GatewayReadiness : IHostedService, IDisposable
{
    private const string SuccessMarker = "SPARKSTUDIO_PYTHON_READY";
    private const string ProbeCode = """
import contextlib, io, json, runpy, sys
sys.stdin = io.StringIO(json.dumps({"code": "", "parameters": {}, "inputs": {}, "libraries": {}}) + "\n")
output = io.StringIO()
with contextlib.redirect_stdout(output):
    runpy.run_path(sys.argv[1], run_name="__main__")
result = json.loads(output.getvalue())
assert result.get("type") == "result" and result.get("success") is True and result.get("result") is None
print("SPARKSTUDIO_PYTHON_READY")
""";
    private readonly object sync = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly Func<CancellationToken, Task<bool>> probe;
    private readonly TimeSpan timeout;
    private Task? startup;
    private int available;
    private int disposed;

    public GatewayReadiness(IConfiguration configuration) : this(
        cancellation => ProbePythonAsync(FindPython(configuration),
            Path.Combine(AppContext.BaseDirectory, "python", "worker.py"), cancellation)) { }

    internal GatewayReadiness(Func<CancellationToken, Task<bool>> probe, TimeSpan? timeout = null)
    { this.probe = probe; this.timeout = timeout ?? TimeSpan.FromSeconds(5); }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        lock (sync) return startup ??= StartProbeAsync(cancellationToken);
    }

    private async Task StartProbeAsync(CancellationToken cancellation)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation, stopping.Token);
        deadline.CancelAfter(timeout);
        try
        {
            // ProbePythonAsync also observes this deadline and terminates only its own child.
            var result = await probe(deadline.Token);
            if (result && !deadline.IsCancellationRequested) Volatile.Write(ref available, 1);
        }
        catch (Exception) { /* Startup readiness is deliberately sanitized and fails closed. */ }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        stopping.Cancel();
        Volatile.Write(ref available, 0);
        Task? running;
        lock (sync) running = startup;
        if (running is not null)
            try { await running.WaitAsync(cancellationToken); }
            catch (OperationCanceledException) { }
    }

    public GatewayReadinessSnapshot Snapshot()
    {
        var ready = Volatile.Read(ref available) == 1;
        return new("SparkStudio", ready ? "ready" : "not-ready", ready, Environment.ProcessId);
    }

    public static void ConfigureTransport(KestrelServerOptions options) => options.ConfigureEndpointDefaults(listener =>
        listener.Use(next => connection =>
        {
            // Capture the TCP peer before HTTP/forwarded-header middleware can alter request connection features.
            connection.Features.Set(new GatewayReadinessPeer((connection.RemoteEndPoint as IPEndPoint)?.Address));
            return next(connection);
        }));

    internal static bool IsLocalPeer(HttpContext context)
    {
        // Missing transport metadata (including unsupported hosts/transports) is never treated as local.
        var check = new DefaultHttpContext();
        check.Connection.RemoteIpAddress = context.Features.Get<GatewayReadinessPeer>()?.Address;
        return GatewaySecurity.IsLoopback(check);
    }

    public static IResult Respond(HttpContext context, GatewayReadiness readiness)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!IsLocalPeer(context)) return Results.StatusCode(StatusCodes.Status403Forbidden);
        var snapshot = readiness.Snapshot();
        return Results.Json(snapshot, statusCode: snapshot.PythonAvailable ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
    }

    // Keep the existing PythonRunner selection order; do not initialize a project runtime to check readiness.
    internal static string? FindPython(IConfiguration configuration)
    {
        var specified = Environment.GetEnvironmentVariable("SPARKSTUDIO_PYTHON") ?? configuration["Python:Executable"];
        if (!string.IsNullOrEmpty(specified)) return specified;
        if (!OperatingSystem.IsWindows()) return File.Exists("/usr/bin/python3") ? "/usr/bin/python3" : null;
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "runtimes", "python", "windows-x64", "python.exe");
            if (File.Exists(path)) return path;
        }
        return null;
    }

    internal static async Task<bool> ProbePythonAsync(string? executable, string worker, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (string.IsNullOrEmpty(executable) || !File.Exists(worker)) return false;
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(worker)!
        };
        info.ArgumentList.Add("-I"); info.ArgumentList.Add("-S"); info.ArgumentList.Add("-c");
        info.ArgumentList.Add(ProbeCode); info.ArgumentList.Add(worker);
        using var process = Process.Start(info);
        if (process is null) return false;
        process.StandardInput.Close();
        var stdout = ReadBoundedAsync(process.StandardOutput, cancellation);
        var stderr = ReadBoundedAsync(process.StandardError, cancellation);
        try
        {
            await process.WaitForExitAsync(cancellation);
            var output = await stdout;
            await stderr;
            return process.ExitCode == 0 && output.Trim() == SuccessMarker;
        }
        finally
        {
            // No PID search, service control or unrelated process termination.
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(1)); }
            catch (Exception) { }
            try { await Task.WhenAll(stdout, stderr); }
            catch (Exception) { }
        }
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[1024];
        var output = new System.Text.StringBuilder(128);
        int count;
        while ((count = await reader.ReadAsync(buffer, cancellation)) > 0)
            if (output.Length < 128) output.Append(buffer, 0, Math.Min(count, 128 - output.Length));
        return output.ToString();
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        stopping.Cancel(); stopping.Dispose();
    }
}

public sealed record GatewayReadinessSnapshot(string Product, string Status, bool PythonAvailable, int ProcessId);
internal sealed record GatewayReadinessPeer(IPAddress? Address);
