using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace SparkStudio.Connectors;

// A process limit, rather than GC allocation counters, contains host helpers and script
// intermediates. Admission reserves the full cap; four 256 MiB workers fit the 1 GiB pool.
public sealed class SourceScriptHost : IAsyncDisposable
{
    private static readonly SemaphoreSlim Slots = new(4, 4);
    private readonly SemaphoreSlim serial = new(1, 1);
    private readonly SourceMemoryBudget budget = new();
    private Process? process;
    private Stream? input;
    private Stream? output;
    private SafeFileHandle? job;
    private string? cgroup;
    private bool admitted;
    private bool disposed;
    private string? fixtureArgument;
    private long replacementAllowedAt, workerStarts;
    private readonly object replacementGate = new();
    private readonly CancellationTokenSource replacementStopping = new();
    private Task? replacement;
    private PlatformNotSupportedException? containmentFailure;
    private bool workerReady, recovering;
    private int disposalRequested;
    public sealed class WorkerCooldownException(int milliseconds) : IOException("Extraction worker replacement cooldown is active; retry after " + milliseconds + " ms.");
    public sealed class WorkerPreparingException() : IOException("Extraction worker replacement is preparing; this input was rejected without waiting.");
    public long WorkerStarts => Interlocked.Read(ref workerStarts);
    public bool WorkerReady => Volatile.Read(ref workerReady);
    public int WorkerCooldownRemainingMs => (int)Math.Clamp(Math.Ceiling((Volatile.Read(ref replacementAllowedAt) - Stopwatch.GetTimestamp()) * 1000d / Stopwatch.Frequency), 0, 1000);
    private readonly object memoryGate = new();
    private CancellationTokenSource? memorySampling;
    private Task? memorySamplingTask;
    private long peakWorkingSet, peakPrivateBytes, peakJobProcessCommit, peakJobCommit, peakCgroupBytes, memorySamples;
    public sealed record MemoryPeaks(long WorkingSetBytes, long PrivateBytes, long JobProcessCommitBytes, long JobCommitBytes, long CgroupBytes, long Samples);
    public MemoryPeaks PeakMemory { get { lock (memoryGate) return new(peakWorkingSet, peakPrivateBytes, peakJobProcessCommit, peakJobCommit, peakCgroupBytes, memorySamples); } }
    internal const long ProcessBytes = 256L * 1024 * 1024;
    internal static SourceScriptHost ForFixture(string argument) => argument is "--fixture-hang" or "--fixture-memory" or "--fixture-oom" or "--fixture-startup-hang" ? new() { fixtureArgument = argument } : throw new ArgumentException("Unknown independently authored worker fixture.");
    internal void EndFixtureMode() => fixtureArgument = null;
    internal void BlockFixtureReplacementStartup() => fixtureArgument = "--fixture-startup-hang";
    internal void RenewFixtureReplacementCooldown() => BlockReplacement();
    internal long EnforcedProcessLimitBytes
    {
        get
        {
            if (job is not null && QueryInformationJobObject(job, 9, out var info, (uint)Marshal.SizeOf<ExtendedLimit>(), IntPtr.Zero)) return (long)info.ProcessMemoryLimit.ToUInt64();
            if (cgroup is not null) return long.Parse(File.ReadAllText(Path.Combine(cgroup, "memory.max")), System.Globalization.CultureInfo.InvariantCulture);
            throw new InvalidOperationException("No enforced worker memory limit is active.");
        }
    }

    public async Task WarmAsync(CancellationToken ct)
    {
        await serial.WaitAsync(ct);
        try { ObjectDisposedException.ThrowIf(disposed, this); await StartAsync(ct); }
        finally { serial.Release(); }
    }
    public async Task<SourceScriptResponse> EvaluateAsync(SourceScriptRequest request, int timeoutMs, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (containmentFailure is { } unsupported) throw unsupported;
        if (Volatile.Read(ref recovering) && !WorkerReady) {
            ScheduleReplacement();
            var remaining = WorkerCooldownRemainingMs;
            if (remaining > 0) throw new WorkerCooldownException(remaining);
            throw new WorkerPreparingException();
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(Math.Clamp(timeoutMs, 1, 100));
        if (!await serial.WaitAsync(0, deadline.Token)) throw new WorkerPreparingException();
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            await StartAsync(deadline.Token);
            return await ExchangeAsync(request, deadline.Token).WaitAsync(deadline.Token);
        }
        catch (WorkerCooldownException) { throw; } // Rejected messages never extend the cooldown or wait for it.
        catch (WorkerPreparingException) { throw; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { await RetireAsync(); BlockReplacement(); Volatile.Write(ref recovering, true); ScheduleReplacement(); throw new TimeoutException("Extraction exceeded its whole-evaluation deadline; isolated worker was killed."); }
        catch (PlatformNotSupportedException) { await RetireAsync(); BlockReplacement(); throw; }
        catch { await RetireAsync(); BlockReplacement(); Volatile.Write(ref recovering, true); ScheduleReplacement(); throw; }
        finally { serial.Release(); }
    }
    private async Task StartAsync(CancellationToken ct)
    {
        if (process is { HasExited: false }) return;
        if (containmentFailure is { } unsupported) throw unsupported;
        if (process is not null) {
            await RetireAsync(); BlockReplacement(); Volatile.Write(ref recovering, true); ScheduleReplacement();
            throw new WorkerCooldownException(WorkerCooldownRemainingMs);
        }
        var remaining = WorkerCooldownRemainingMs;
        if (remaining > 0) throw new WorkerCooldownException(remaining);
        try
        {
            await RetireAsync();
            if (!OperatingSystem.IsWindows() && !OperatingSystem.IsLinux()) throw new PlatformNotSupportedException("Scripting is disabled: this platform has no qualified process memory boundary.");
            if (!await Slots.WaitAsync(0, ct)) throw new SourceLimitException("Scripting worker memory pool is full (four 256 MiB processes / 1 GiB). Reduce active scripted connections or retry after one is stopped.");
            admitted = true;
            budget.SetBytes("workers", ProcessBytes);
            var executable = LocateWorker();
            if (OperatingSystem.IsWindows()) StartWindows(executable);
            else StartLinux(executable);
            Interlocked.Increment(ref workerStarts);
            memorySampling = new(); memorySamplingTask = SampleMemoryAsync(memorySampling.Token);
            var ready = await SourceScriptProtocol.ReadAsync<string>(output!, ct).WaitAsync(ct);
            if (ready != "ready") throw new InvalidDataException("Invalid extraction worker handshake.");
            if (OperatingSystem.IsLinux() && (cgroup is null || !File.ReadLines(Path.Combine(cgroup, "cgroup.procs")).Contains(process!.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))))
                throw new PlatformNotSupportedException("Scripting is disabled: the worker did not enter its delegated cgroup memory boundary.");
            Volatile.Write(ref workerReady, true);
        }
        catch (PlatformNotSupportedException error) { containmentFailure = error; await RetireAsync(); BlockReplacement(); throw; }
        catch { await RetireAsync(); BlockReplacement(); throw; }
    }
    private void BlockReplacement() => Volatile.Write(ref replacementAllowedAt, Stopwatch.GetTimestamp() + Stopwatch.Frequency);
    private void ScheduleReplacement()
    {
        lock (replacementGate) {
            if (disposed || replacementStopping.IsCancellationRequested || WorkerReady || replacement is { IsCompleted: false }) return;
            replacement = PrepareReplacementAsync(replacementStopping.Token);
        }
    }
    private async Task PrepareReplacementAsync(CancellationToken lifetime)
    {
        try {
            while (true) {
                await Task.Delay(WorkerCooldownRemainingMs, lifetime);
                using var startup = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
                startup.CancelAfter(5000);
                await serial.WaitAsync(startup.Token);
                try {
                    if (disposed) return;
                    // Timers may wake before the monotonic deadline, and another
                    // failed start may renew it while this task waits for admission.
                    // Re-wait without consuming this scheduled replacement attempt.
                    if (WorkerCooldownRemainingMs > 0) continue;
                    await StartAsync(startup.Token);
                    return;
                }
                finally { serial.Release(); }
            }
        }
        catch (PlatformNotSupportedException) { Volatile.Write(ref recovering, false); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch { /* StartAsync records the cooldown. A later input may request one bounded retry. */ }
    }
    private async Task<SourceScriptResponse> ExchangeAsync(SourceScriptRequest request, CancellationToken ct)
    {
        await SourceScriptProtocol.WriteAsync(input!, request, ct);
        return await SourceScriptProtocol.ReadAsync<SourceScriptResponse>(output!, ct);
    }
    internal static string LocateWorker()
    {
        var configured = Environment.GetEnvironmentVariable("SPARKSTUDIO_SOURCE_WORKER");
        if (!string.IsNullOrWhiteSpace(configured)) return Existing(configured);
        var packaged = Path.Combine(AppContext.BaseDirectory, "source-worker", "SparkStudio.SourceWorker" + (OperatingSystem.IsWindows() ? ".exe" : ""));
        if (File.Exists(packaged)) return packaged;
        var dll = Path.Combine(AppContext.BaseDirectory, "source-worker", "SparkStudio.SourceWorker.dll");
        if (File.Exists(dll)) return dll;
        // Development/test layout; no current-directory search in deployed gateways.
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (directory.Name == "src")
            {
                foreach (var configuration in new[] { "Debug", "Release" })
                {
                    var candidate = Path.Combine(directory.FullName, "SparkStudio.SourceWorker", "bin", configuration, "net10.0", "SparkStudio.SourceWorker" + (OperatingSystem.IsWindows() ? ".exe" : ""));
                    if (File.Exists(candidate)) return candidate;
                }
                break;
            }
            directory = directory.Parent;
        }
        throw new FileNotFoundException("Scripting worker is missing. Publish SparkStudio.SourceWorker into source-worker beside the gateway.");
        static string Existing(string path) { var absolute = Path.GetFullPath(path); if (!File.Exists(absolute)) throw new FileNotFoundException("Configured extraction worker was not found."); return absolute; }
    }
    private static string DotnetHost()
    {
        var configured = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? Environment.GetEnvironmentVariable("SPARKSTUDIO_DOTNET");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        var own = Environment.ProcessPath; if (own is not null && Path.GetFileNameWithoutExtension(own).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) return own;
        return "dotnet";
    }
    private void StartLinux(string executable)
    {
        // Delegated cgroup v2 is a deployment prerequisite. RLIMIT_AS/RSS polling are not
        // substituted: neither establishes the required bound on committed process memory.
        var configured = Environment.GetEnvironmentVariable("SPARKSTUDIO_SOURCE_CGROUP_ROOT");
        string root;
        if (!string.IsNullOrWhiteSpace(configured)) root = Path.GetFullPath(configured);
        else
        {
            var membership = File.ReadLines("/proc/self/cgroup").SingleOrDefault(line => line.StartsWith("0::", StringComparison.Ordinal));
            if (membership is null) throw new PlatformNotSupportedException("Scripting requires delegated cgroup v2 memory control.");
            root = Path.GetFullPath(Path.Combine("/sys/fs/cgroup", membership[3..].TrimStart('/')));
        }
        if (!root.StartsWith("/sys/fs/cgroup/", StringComparison.Ordinal) && root != "/sys/fs/cgroup") throw new PlatformNotSupportedException("Scripting cgroup root must reside in the cgroup v2 filesystem.");
        VerifyCgroupFileSystem(root);
        cgroup = Path.Combine(root, "spark-source-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(cgroup);
            if (!File.Exists(Path.Combine(cgroup, "memory.max"))) throw new IOException("The delegated memory controller is unavailable.");
            File.WriteAllText(Path.Combine(cgroup, "memory.max"), ProcessBytes.ToString(System.Globalization.CultureInfo.InvariantCulture));
            File.WriteAllText(Path.Combine(cgroup, "memory.swap.max"), "0");
            File.WriteAllText(Path.Combine(cgroup, "memory.oom.group"), "1");
            if (File.ReadAllText(Path.Combine(cgroup, "memory.max")).Trim() != ProcessBytes.ToString(System.Globalization.CultureInfo.InvariantCulture)) throw new IOException("cgroup memory limit was not applied.");
            var start = new ProcessStartInfo("/bin/sh") { RedirectStandardInput = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add("printf '%s' \"$$\" > \"$1/cgroup.procs\" || exit 125; shift; exec \"$@\"");
            start.ArgumentList.Add("source-worker"); start.ArgumentList.Add(cgroup);
            if (executable.EndsWith(".dll", StringComparison.Ordinal)) start.ArgumentList.Add(DotnetHost());
            start.ArgumentList.Add(executable);
            if (fixtureArgument is not null) start.ArgumentList.Add(fixtureArgument);
            // .NET reserves a large address range; this GC hint does not replace the cgroup cap.
            start.Environment["DOTNET_GCHeapHardLimit"] = "6000000";
            process = Process.Start(start) ?? throw new IOException("Unable to start extraction worker.");
            input = process.StandardInput.BaseStream; output = process.StandardOutput.BaseStream;
        }
        catch (Exception error) { throw new PlatformNotSupportedException("Scripting is disabled: delegate a cgroup-v2 memory controller and set SPARKSTUDIO_SOURCE_CGROUP_ROOT to that directory. " + error.Message, error); }
    }
    private static void VerifyCgroupFileSystem(string path)
    {
        if (!Environment.Is64BitProcess) throw new PlatformNotSupportedException("Scripting cgroup enforcement is qualified only for Linux x64/ARM64.");
        var info = Marshal.AllocHGlobal(256);
        try { if (StatFs(System.Text.Encoding.UTF8.GetBytes(path + '\0'), info) != 0 || Marshal.ReadInt64(info) != 0x63677270) throw new PlatformNotSupportedException("Scripting requires an actual delegated cgroup-v2 filesystem; ordinary files cannot establish the memory cap."); }
        finally { Marshal.FreeHGlobal(info); }
    }
    private void StartWindows(string executable)
    {
        job = CreateJobObjectW(IntPtr.Zero, null); if (job.IsInvalid) throw new Win32Exception();
        var limits = new ExtendedLimit { Basic = new BasicLimit { Flags = 0x2000 | 0x100 | 0x200 | 0x8, ActiveProcesses = 1 }, ProcessMemoryLimit = (UIntPtr)ProcessBytes, JobMemoryLimit = (UIntPtr)ProcessBytes };
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimit>())) throw new Win32Exception();
        var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Inherit = true };
        SafeFileHandle? childInput = null, parentInput = null, parentOutput = null, childOutput = null;
        try
        {
            if (!CreatePipe(out childInput, out parentInput, ref attributes, 4096) || !CreatePipe(out parentOutput, out childOutput, ref attributes, 4096)) throw new Win32Exception();
            if (!SetHandleInformation(parentInput, 1, 0) || !SetHandleInformation(parentOutput, 1, 0)) throw new Win32Exception();
            var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Flags = 0x100, Input = childInput.DangerousGetHandle(), Output = childOutput.DangerousGetHandle(), Error = childOutput.DangerousGetHandle() };
            var host = executable.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? DotnetHost() : executable;
            var command = (Quote(host) + (host == executable ? "" : " " + Quote(executable)) + (fixtureArgument is null ? "" : " " + fixtureArgument) + '\0').ToCharArray();
            if (!CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out var info)) throw new Win32Exception();
            using var processHandle = new SafeFileHandle(info.Process, true); using var thread = new SafeFileHandle(info.Thread, true);
            if (!AssignProcessToJobObject(job, processHandle)) { TerminateProcess(processHandle, 125); throw new Win32Exception(); }
            process = Process.GetProcessById((int)info.Id);
            input = new FileStream(parentInput, FileAccess.Write, 4096, false); parentInput = null;
            output = new FileStream(parentOutput, FileAccess.Read, 4096, false); parentOutput = null;
            if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception();
        }
        finally { childInput?.Dispose(); childOutput?.Dispose(); parentInput?.Dispose(); parentOutput?.Dispose(); }
        static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
    }
    private async Task RetireAsync()
    {
        Volatile.Write(ref workerReady, false);
        if (memorySampling is { } sampling) {
            sampling.Cancel();
            if (memorySamplingTask is { } task) try { await task.WaitAsync(TimeSpan.FromMilliseconds(200)); } catch { }
            sampling.Dispose(); memorySampling = null; memorySamplingTask = null;
        }
        CaptureMemory();
        if (process is not null)
        {
            try { if (!process.HasExited) process.Kill(true); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            CaptureMemory();
            process.Dispose(); process = null;
        }
        input?.Dispose(); output?.Dispose(); input = output = null;
        job?.Dispose(); job = null;
        if (cgroup is not null) { try { if (File.Exists(Path.Combine(cgroup, "cgroup.kill"))) File.WriteAllText(Path.Combine(cgroup, "cgroup.kill"), "1"); Directory.Delete(cgroup); } catch { } cgroup = null; }
        if (admitted) { budget.SetBytes("workers", 0); admitted = false; Slots.Release(); }
    }
    private async Task SampleMemoryAsync(CancellationToken ct)
    {
        // Observation only; the Job/cgroup boundary enforces memory independently.
        try { while (!ct.IsCancellationRequested) { CaptureMemory(); await Task.Delay(20, ct); } }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }
    private void CaptureMemory()
    {
        try {
            long rss = 0, committed = 0, jobProcess = 0, jobTotal = 0, group = 0;
            if (OperatingSystem.IsWindows()) {
                if (process is { } current && GetProcessMemoryInfo(current.SafeHandle, out var counters, (uint)Marshal.SizeOf<ProcessMemoryCounters>())) {
                    rss = (long)counters.PeakWorkingSet.ToUInt64(); committed = (long)counters.PeakPageFile.ToUInt64();
                }
                if (job is { IsClosed: false } currentJob && QueryInformationJobObject(currentJob, 9, out var info, (uint)Marshal.SizeOf<ExtendedLimit>(), IntPtr.Zero)) {
                    jobProcess = (long)info.PeakProcessMemory.ToUInt64(); jobTotal = (long)info.PeakJobMemory.ToUInt64();
                }
            }
            else {
                if (process is { HasExited: false } current) { current.Refresh(); rss = current.PeakWorkingSet64; committed = current.PrivateMemorySize64; }
                if (cgroup is { } directory) {
                    var peak = Path.Combine(directory, "memory.peak"); var live = Path.Combine(directory, "memory.current");
                    if (File.Exists(peak)) group = long.Parse(File.ReadAllText(peak).Trim(), System.Globalization.CultureInfo.InvariantCulture);
                    else if (File.Exists(live)) group = long.Parse(File.ReadAllText(live).Trim(), System.Globalization.CultureInfo.InvariantCulture);
                }
            }
            lock (memoryGate) {
                peakWorkingSet = Math.Max(peakWorkingSet, rss); peakPrivateBytes = Math.Max(peakPrivateBytes, committed);
                peakJobProcessCommit = Math.Max(peakJobProcessCommit, jobProcess); peakJobCommit = Math.Max(peakJobCommit, jobTotal);
                peakCgroupBytes = Math.Max(peakCgroupBytes, group); memorySamples++;
            }
        }
        catch (Exception error) when (error is InvalidOperationException or Win32Exception or IOException or ObjectDisposedException or UnauthorizedAccessException) { }
    }
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposalRequested, 1) != 0) return;
        disposed = true; replacementStopping.Cancel();
        await serial.WaitAsync();
        try { await RetireAsync(); budget.Dispose(); }
        finally { serial.Release(); }
        Task? preparing; lock (replacementGate) preparing = replacement;
        if (preparing is not null) try { await preparing.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
        replacementStopping.Dispose();
    }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo { public int Size; public string? Reserved; public string? Desktop; public string? Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public uint Id, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimit { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcesses; public IntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessMemoryCounters { public uint Size, PageFaults; public UIntPtr PeakWorkingSet, WorkingSet, PeakPagedPool, PagedPool, PeakNonPagedPool, NonPagedPool, PageFile, PeakPageFile, Private; }
    [DllImport("kernel32.dll", EntryPoint = "K32GetProcessMemoryInfo", SetLastError = true)] private static extern bool GetProcessMemoryInfo(SafeProcessHandle process, out ProcessMemoryCounters counters, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimit info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out ExtendedLimit info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string? application, [In, Out] char[] command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string? directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeFileHandle process, uint code);
    [DllImport("libc", EntryPoint = "statfs", SetLastError = true)] private static extern int StatFs([In] byte[] path, IntPtr info);
}
