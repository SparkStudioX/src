using System.Diagnostics;
using System.Reflection;
using Microsoft.Extensions.Configuration;
using SparkStudio.Gateway;

internal static class ReadinessChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description) { if (!condition) throw new InvalidOperationException(description); checks++; }
        var executable = TestEnvironment.PythonExecutable();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = executable }).Build();
        using (var readiness = new GatewayReadiness(configuration))
        {
            Check(!readiness.Snapshot().PythonAvailable, "readiness stays unavailable before the real worker probe");
            await readiness.StartAsync(CancellationToken.None);
            Check(readiness.Snapshot() is { PythonAvailable: true, Status: "ready" }, "packaged worker starts with genuine pipe descriptors and completes its empty request");
            await readiness.StartAsync(CancellationToken.None);
            Check(Enumerable.Range(0, 100).All(_ => readiness.Snapshot().PythonAvailable), "repeat start and polling retain the completed probe result");
            await readiness.StopAsync(CancellationToken.None);
            Check(!readiness.Snapshot().PythonAvailable, "stop clears readiness");
        }

        // Fixed fixture workers exercise protocol failure and child ownership without
        // exposing a production endpoint that accepts arbitrary readiness code.
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.Readiness." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var method = typeof(GatewayReadiness).GetMethod("ProbePythonAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        Task<bool> Probe(string worker, CancellationToken cancellation) => (Task<bool>)method.Invoke(null, [executable, worker, cancellation])!;
        async Task<bool> Fixture(string name, string source)
        {
            var path = Path.Combine(directory, name + ".py"); await File.WriteAllTextAsync(path, source);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            return await Probe(path, timeout.Token);
        }
        try
        {
            const string success = "{\"type\":\"result\",\"success\":true,\"stdout\":\"\",\"stderr\":\"\",\"result\":null}";
            Check(await Fixture("success", "print('" + success + "')\n"), "one exact terminal success frame is accepted");
            Check(!await Fixture("extra", "print('" + success + "')\nprint('unexpected second frame')\n"), "extra protocol output cannot masquerade as successful startup");
            Check(!await Fixture("oversized", "print('" + success + "' + ' ' * 10000)\n"), "oversized stdout fails closed even when it begins with valid success JSON");
            Check(!await Fixture("oversized-error", "import sys\nprint('x' * 10000, file=sys.stderr)\nprint('" + success + "')\n"), "oversized stderr is drained and fails closed");
            Check(!await Fixture("failed", "print('" + success.Replace("true", "false") + "')\n"), "worker result failures do not mark startup ready");
            Check(!await Fixture("nonzero", "import sys\nprint('" + success + "')\nsys.exit(3)\n"), "nonzero worker exit cannot mark startup ready");
            Check(!await Probe(Path.Combine(directory, "missing.py"), CancellationToken.None), "missing worker returns unavailable without launching a process");
            var slow = Path.Combine(directory, "slow.py");
            await File.WriteAllTextAsync(slow, "import os, pathlib, time\npathlib.Path(__file__).with_suffix('.pid').write_text(str(os.getpid()))\ntime.sleep(30)\n");
            using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(750));
            var timer = Stopwatch.StartNew(); var cancelled = false;
            try { await Probe(slow, deadline.Token); } catch (OperationCanceledException) { cancelled = true; }
            Check(cancelled && timer.Elapsed < TimeSpan.FromSeconds(5), "cancelled probe terminates promptly within its owned-child cleanup bound");
            var pidPath = Path.ChangeExtension(slow, ".pid");
            Check(File.Exists(pidPath), "timeout fixture actually started before cancellation");
            var pid = int.Parse(await File.ReadAllTextAsync(pidPath), System.Globalization.CultureInfo.InvariantCulture);
            var exited = false;
            try { using var child = Process.GetProcessById(pid); exited = child.HasExited; } catch (ArgumentException) { exited = true; }
            Check(exited, "cancelled probe leaves no owned Python child running");
        }
        finally
        {
            var parent = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != parent) throw new InvalidOperationException("Fixture escaped its temporary root.");
            Directory.Delete(directory, recursive: true);
        }
        return checks;
    }
}
