using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace SparkStudio.Installer;

internal static partial class Program
{
    internal const string ProductId = "{C85DA4EA-0382-4B12-943A-CE73A1772FD8}";
    private const string RegistryPath = @"SOFTWARE\SparkStudio\Installer";
    private const string ServiceName = "SparkStudio";
    private static readonly string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SparkStudio");

    public static async Task<int> Main(string[] args)
    {
        string? report = null;
        try
        {
            var options = ParseOptions(args);
            options.TryGetValue("report", out report);
            var action = options.GetValueOrDefault("action") ?? throw new ArgumentException("Missing --action.");
            if (action != "probe" && options.ContainsKey("process-id")) throw new ArgumentException("--process-id is supported only by the read-only probe action.");
            if (action == "self-test") { await SelfTestAsync(); return 0; }
            if (action == "shutdown-test-child") { ShutdownTestChild(options.GetValueOrDefault("install-dir") ?? ""); return 0; }
            var directory = ValidateDirectory(options.GetValueOrDefault("install-dir") ?? throw new ArgumentException("Missing --install-dir."));
            if (!int.TryParse(options.GetValueOrDefault("port", "5090"), out var port) || port is < 1 or > 65535)
                throw new ArgumentException("Port must be an integer between 1 and 65535.");
            var network = ParseNetwork(options, port);
            if (action == "probe")
            {
                if (!int.TryParse(options.GetValueOrDefault("process-id"), out var processId) || processId <= 0)
                    throw new ArgumentException("The read-only probe requires a positive --process-id.");
                using var process = Process.GetProcessById(processId);
                var expected = Path.GetFullPath(Path.Combine(directory, "SparkStudio.Gateway.exe"));
                if (process.HasExited || process.MainModule?.FileName is not { } executable || !Path.GetFullPath(executable).Equals(expected, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The requested process is not the gateway executable in the supplied installation directory.");
                await WaitForReadinessAsync(port, () => process.HasExited ? 0 : (uint)process.Id);
                WriteReport(report, "PASS the expected gateway process and its bundled Python readiness endpoint responded without authentication; no service or registration was changed.");
                return 0;
            }
            if (action is not ("preflight" or "inspect-shutdown" or "prepare" or "install" or "resume" or "remove"))
                throw new ArgumentException("Unknown lifecycle action.");
            if (action != "preflight") RequireAdministrator();
            if (action is not ("remove" or "resume" or "inspect-shutdown")) CheckMachineEnvironment();
            var readOnly = action is "preflight" or "inspect-shutdown";
            using var manager = Native.OpenManager(readOnly);
            using var service = Native.OpenServiceIfPresent(manager, readOnly ? Native.ReadAccess : Native.FullAccess);
            var registration = ReadRegistration();
            var existing = service is null ? null : Native.ReadService(service);
            ValidateOwnership(directory, registration, existing);
            if (action is "preflight" or "prepare" or "install") ValidateNetwork(network, registration);
            string result;
            switch (action)
            {
                case "preflight":
                    ProbePort(port, existing, registration);
                    ProbeNetworkPort(network, existing, registration);
                    result = "Preflight passed. The owned service, selected ports and certificate settings are valid. Browser certificate trust and firewall rules are not changed.";
                    break;
                case "inspect-shutdown":
                    if (service is null || existing?.State != Native.Running)
                        throw new InvalidOperationException("The read-only shutdown diagnostic requires the owned SparkStudio service to be running.");
                    var processId = Native.RunningProcessId(service);
                    var previousPrivilege = Native.ReadDebugPrivilegeAttributes();
                    using (var pinned = Native.PinProcess(processId, Path.Combine(directory, "SparkStudio.Gateway.exe"), out var debugFallback))
                    {
                        if (Native.RunningProcessId(service) != processId)
                            throw new InvalidOperationException("The service process changed during the read-only shutdown diagnostic; retry once it is stable.");
                        var restoredPrivilege = Native.ReadDebugPrivilegeAttributes();
                        if (restoredPrivilege != previousPrivilege)
                            throw new InvalidOperationException("The temporary diagnostic privilege did not return to its original state.");
                        result = $"PASS read-only shutdown diagnostic for owned gateway PID {processId}: minimal query/synchronize handle and executable identity verified. " +
                            (debugFallback ? "Direct OpenProcess was denied; temporary SeDebugPrivilege allowed the handle, and its original token state was verified restored. " : "Direct OpenProcess succeeded; no debug privilege was enabled. ") +
                            "No service, process memory, registration or gateway data was changed; the service was not stopped.";
                    }
                    break;
                case "prepare":
                    ProbePort(port, existing, registration);
                    ProbeNetworkPort(network, existing, registration);
                    var running = existing is not null && existing.State != Native.Stopped;
                    if (service is not null) Native.StopAndWait(service, directory);
                    try { ProbePort(port, null, null); ProbeNetworkPort(network, null, null); }
                    catch { if (running && service is not null) Native.StartAndWait(service); throw; }
                    result = running ? "stopped" : "ready";
                    break;
                case "install":
                    if (!File.Exists(Path.Combine(directory, "SparkStudio.Gateway.exe")) ||
                        !File.Exists(Path.Combine(directory, "runtimes", "python", "windows-x64", "python.exe")))
                        throw new InvalidOperationException("The offline gateway/Python payload is incomplete.");
                    ProbePort(port, null, null);
                    RejectReparsePoints(DataDirectory);
                    Directory.CreateDirectory(DataDirectory);
                    await InstallAsync(manager, service, registration, directory, port, network);
                    result = $"SparkStudio is running at http://127.0.0.1:{port}. Data is retained in {DataDirectory}.";
                    if (network.Access == "network")
                        result += $" HTTPS is configured at https://{network.Hostname}:{network.HttpsPort}. Public certificate: {Path.Combine(DataDirectory, "certificates", "deployment", "gateway-public.cer")}. " +
                            $"Trust and renewal instructions: {Path.Combine(DataDirectory, "certificates", "deployment", "gateway-trust.txt")}. No operator trust or firewall rules were changed.";
                    break;
                case "resume":
                    if (service is not null) Native.StartAndWait(service);
                    result = "Previously owned service resumed.";
                    break;
                default:
                    if (service is not null)
                    {
                        Native.StopAndWait(service, directory);
                        Native.DeleteChecked(service);
                    }
                    if (registration is not null)
                        Registry.LocalMachine.DeleteSubKeyTree(RegistryPath, throwOnMissingSubKey: false);
                    result = $"Service removed. Existing data was retained in {DataDirectory}.";
                    break;
            }
            WriteReport(report, result);
            return 0;
        }
        catch (Exception error)
        {
            var message = error is Win32Exception windows ? $"{windows.Message} (Windows error {windows.NativeErrorCode})." : error.Message;
            try { WriteReport(report, message); } catch { /* Console still reports the original failure. */ }
            Console.Error.WriteLine(message);
            return 1;
        }
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        if (args.Length % 2 != 0) throw new ArgumentException("Arguments must be --name value pairs.");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var allowed = new HashSet<string>(["action", "install-dir", "port", "report", "process-id", "access", "https-port", "hostname", "certificate-mode", "certificate", "private-key"]);
        for (var index = 0; index < args.Length; index += 2)
        {
            var key = args[index].StartsWith("--", StringComparison.Ordinal) ? args[index][2..] : "";
            if (!allowed.Contains(key) || !result.TryAdd(key, args[index + 1])) throw new ArgumentException("Unknown or duplicate argument.");
        }
        return result;
    }

    private static void WriteReport(string? path, string message)
    {
        if (!string.IsNullOrEmpty(path)) File.WriteAllText(path, message);
        Console.WriteLine(message);
    }

    private static void RequireAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            throw new InvalidOperationException("Windows administrator approval is required to manage the service.");
    }

    private static void CheckMachineEnvironment()
    {
        foreach (System.Collections.DictionaryEntry setting in Environment.GetEnvironmentVariables(EnvironmentVariableTarget.Machine))
            if (setting.Key is string name && !string.IsNullOrWhiteSpace(setting.Value?.ToString()) && (name.StartsWith("Kestrel__", StringComparison.OrdinalIgnoreCase) || name.StartsWith("ASPNETCORE_Kestrel__", StringComparison.OrdinalIgnoreCase) || name.StartsWith("DOTNET_Kestrel__", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("Machine Kestrel endpoint overrides must be removed before using installer-managed listeners.");
        foreach (var key in new[] { "SPARKSTUDIO_DATA_DIR", "SPARKSTUDIO_PYTHON", "SPARKSTUDIO_DEPLOYMENT_DISABLE", "ASPNETCORE_URLS", "DOTNET_URLS", "ASPNETCORE_HTTP_PORTS", "ASPNETCORE_HTTPS_PORTS", "DOTNET_HTTP_PORTS", "DOTNET_HTTPS_PORTS" })
            if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key, EnvironmentVariableTarget.Machine)))
                throw new InvalidOperationException($"The machine environment variable {key} overrides installer configuration. Remove that override before installing this service.");
    }

    internal static string ValidateDirectory(string value)
    {
        if (value.Any(c => c < ' ' || c == '"') || !Path.IsPathFullyQualified(value) || value.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Installation must use a local absolute path without quotes or control characters.");
        var directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        if (directory.Equals(Path.GetPathRoot(directory), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The installation directory cannot be a drive root.");
        if (directory.Equals(DataDirectory, StringComparison.OrdinalIgnoreCase) || directory.StartsWith(DataDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || DataDirectory.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Program files and retained ProgramData must use separate directories.");
        RejectReparsePoints(directory);
        return directory;
    }

    private static void RejectReparsePoints(string directory)
    {
        for (string? current = Path.GetFullPath(directory); current is not null; current = Path.GetDirectoryName(current))
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new ArgumentException("Service installation/data paths cannot contain symbolic links or junctions.");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    internal static string Command(string directory, int port, int commandVersion = 1) => $"\"{Path.Combine(directory, "SparkStudio.Gateway.exe")}\" --contentRoot \"{directory}\" --DataDirectory \"{DataDirectory}\" {(commandVersion == 2 ? $"--InstallerManagementPort {port}" : $"--urls http://127.0.0.1:{port}")}";

    private static Registration? ReadRegistration()
    {
        using var key = Registry.LocalMachine.OpenSubKey(RegistryPath);
        if (key is null) return null;
        return new Registration(key.GetValue("ProductId") as string ?? "", key.GetValue("InstallDirectory") as string ?? "", key.GetValue("DataDirectory") as string ?? "", key.GetValue("Port") is int port ? port : 0, key.GetValue("CommandVersion") is int commandVersion ? commandVersion : 1);
    }

    private static void SaveRegistration(Registration value)
    {
        using var key = Registry.LocalMachine.CreateSubKey(RegistryPath);
        key.SetValue("ProductId", value.ProductId);
        key.SetValue("InstallDirectory", value.InstallDirectory);
        key.SetValue("DataDirectory", value.DataDirectory);
        key.SetValue("Port", value.Port, RegistryValueKind.DWord);
        key.SetValue("CommandVersion", value.CommandVersion, RegistryValueKind.DWord);
    }

    internal static void ValidateOwnership(string directory, Registration? registration, ServiceInfo? service)
    {
        if (registration is not null && (registration.ProductId != ProductId ||
            !registration.InstallDirectory.Equals(directory, StringComparison.OrdinalIgnoreCase) ||
            !registration.DataDirectory.Equals(DataDirectory, StringComparison.OrdinalIgnoreCase) || registration.Port is < 1 or > 65535 || registration.CommandVersion is not (1 or 2)))
            throw new InvalidOperationException("An incompatible SparkStudio installation registration exists. Use its original installer/location; this installer will not replace it.");
        if (service is not null && (registration is null ||
            !service.BinaryPath.Equals(Command(directory, registration.Port, registration.CommandVersion), StringComparison.OrdinalIgnoreCase) ||
            !service.Account.Equals(@"NT AUTHORITY\LocalService", StringComparison.OrdinalIgnoreCase) || service.ServiceType != Native.OwnProcess))
            throw new InvalidOperationException("The existing SparkStudio service is not owned by this installer or its configuration was changed. It has not been stopped or modified. Use its original management procedure.");
    }

    private static void ProbePort(int port, ServiceInfo? service, Registration? registration)
    {
        // An owned running service may currently occupy its recorded port. Prepare stops only
        // that verified service and repeats the bind before any payload files are overwritten.
        if (service is not null && service.State != Native.Stopped && (registration?.Port == port || (registration?.CommandVersion == 2 && ReadNetworkIntent(DataDirectory)?.HttpsPort == port))) return;
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Server.ExclusiveAddressUse = true;
        try { listener.Start(); }
        catch (SocketException) { throw new InvalidOperationException($"Port {port} is already in use. Choose another port in the wizard (for example 5092), or stop its application yourself. No running application was modified."); }
        finally { listener.Stop(); }
    }

    private static async Task InstallAsync(ServiceHandle manager, ServiceHandle? existing, Registration? previous, string directory, int port, NetworkOptions network)
    {
        ServiceHandle? created = null;
        DeploymentChange? deployment = null;
        try
        {
            var service = existing ?? (created = Native.CreateChecked(manager, Command(directory, port, 2)));
            if (existing is not null) Native.Configure(existing, Command(directory, port, 2));
            Native.ConfigureIdentity(service);
            // The gateway stores credentials and project code here. Do not inherit the
            // broad Users read access of ProgramData on a fresh installation.
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var identity in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(identity, null), FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            var serviceIdentity = (SecurityIdentifier)new NTAccount(@"NT SERVICE\SparkStudio").Translate(typeof(SecurityIdentifier));
            acl.SetAccessRule(new FileSystemAccessRule(serviceIdentity, FileSystemRights.Modify | FileSystemRights.Synchronize,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(DataDirectory).SetAccessControl(acl);
            deployment = InstallDeployment(DataDirectory, port, network);
            SaveRegistration(new Registration(ProductId, directory, DataDirectory, port, 2));
            Native.StartAndWait(service);
            await WaitForReadinessAsync(port, () => Native.RunningProcessId(service));
            if (ReadNetworkIntent(DataDirectory) is { } installedNetwork)
                await VerifyNetworkReadinessAsync(installedNetwork, () => Native.RunningProcessId(service));
        }
        catch (Exception failure)
        {
            try
            {
                if (created is not null)
                {
                    Native.StopAndWait(created, directory);
                    Native.DeleteChecked(created);
                    if (previous is null) Registry.LocalMachine.DeleteSubKeyTree(RegistryPath, false); else SaveRegistration(previous);
                }
                else if (existing is not null && previous is not null)
                {
                    Native.StopAndWait(existing, directory);
                    Native.Configure(existing, Command(previous.InstallDirectory, previous.Port, previous.CommandVersion));
                    SaveRegistration(previous);
                }
                deployment?.Rollback();
            }
            catch (Exception cleanup)
            {
                throw new InvalidOperationException($"{failure.Message} Installer service cleanup also failed: {cleanup.Message} Gateway data was retained. Inspect the owned service before retrying.", failure);
            }
            throw;
        }
        finally { created?.Dispose(); }
    }

    private static async Task WaitForReadinessAsync(int port, Func<uint> runningProcessId)
    {
        using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
        using var readinessDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var lastObservation = "No readiness response was received.";
        while (!readinessDeadline.IsCancellationRequested)
        {
            try
            {
                var processId = runningProcessId();
                if (processId == 0) throw new InvalidOperationException("The SparkStudio gateway process stopped before readiness completed. Inspect Windows Event Viewer before retrying. Existing data has been retained.");
                var readiness = await ProbeReadinessAsync(client, port, processId, readinessDeadline.Token);
                lastObservation = readiness.Message;
                if (readiness.Ready && runningProcessId() == processId) return;
                await Task.Delay(500, readinessDeadline.Token);
            }
            catch (OperationCanceledException) when (readinessDeadline.IsCancellationRequested) { break; }
        }
        throw new InvalidOperationException($"The gateway did not become ready with bundled Python within 45 seconds. {lastObservation} Inspect Windows Event Viewer before retrying. Existing data has been retained.");
    }

    internal static async Task<ReadinessProbe> ProbeReadinessAsync(HttpClient client, int port, uint expectedProcessId, CancellationToken cancellation, Uri? endpoint = null)
    {
        if (port is < 1 or > 65535 || expectedProcessId == 0) throw new ArgumentException("Readiness requires a local port and a running service process ID.");
        try
        {
            using var response = await client.GetAsync(new Uri(endpoint ?? new Uri($"http://127.0.0.1:{port}"), "/api/ready"), HttpCompletionOption.ResponseHeadersRead, cancellation);
            if (response.StatusCode != HttpStatusCode.OK)
                return new(false, response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                    ? $"The local readiness endpoint returned HTTP {(int)response.StatusCode}; it must not require an administrator login. Verify that installer and gateway versions match."
                    : $"The local readiness endpoint returned HTTP {(int)response.StatusCode} instead of a ready response.");
            if (!string.Equals(response.Content.Headers.ContentType?.MediaType, "application/json", StringComparison.OrdinalIgnoreCase))
                return new(false, "The local readiness response was not JSON.");
            if (response.Content.Headers.ContentLength > 4096) return new(false, "The local readiness response was larger than expected.");
            await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
            var bytes = new byte[4097]; var length = 0;
            while (length < bytes.Length)
            {
                var count = await stream.ReadAsync(bytes.AsMemory(length), cancellation);
                if (count == 0) break;
                length += count;
            }
            if (length > 4096) return new(false, "The local readiness response was larger than expected.");
            using var json = JsonDocument.Parse(bytes.AsMemory(0, length));
            var value = json.RootElement;
            if (value.ValueKind != JsonValueKind.Object ||
                !value.TryGetProperty("product", out var product) || product.ValueKind != JsonValueKind.String || product.GetString() != "SparkStudio" ||
                !value.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String || status.GetString() != "ready" ||
                !value.TryGetProperty("pythonAvailable", out var python) || python.ValueKind != JsonValueKind.True)
                return new(false, "The local gateway has not reported bundled Python readiness.");
            if (!value.TryGetProperty("processId", out var process) || process.ValueKind != JsonValueKind.Number || !process.TryGetUInt32(out var processId) || processId != expectedProcessId)
                return new(false, "The local readiness response did not identify the owned service process.");
            return new(true, "The owned SparkStudio service and bundled Python are ready.");
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return new(false, "The local readiness request timed out."); }
        catch (Exception error) when (error is HttpRequestException or IOException or JsonException)
        { return new(false, "The local readiness endpoint has not returned a usable response."); }
    }

    private static async Task SelfTestAsync()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "SparkStudio");
        var registration = new Registration(ProductId, dir, DataDirectory, 5090);
        var good = new ServiceInfo(Command(dir, 5090), @"NT AUTHORITY\LocalService", Native.OwnProcess, Native.Stopped);
        var checks = 0;
        void Accepted(Action action) { action(); checks++; }
        void Rejected(Action action) { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException) { checks++; return; } throw new InvalidOperationException("Expected ownership/path rejection."); }
        Accepted(() => ValidateOwnership(dir, null, null));
        Accepted(() => ValidateOwnership(dir, registration, null)); // A retained registration can be retried after owned-service cleanup.
        Accepted(() => ValidateOwnership(dir, registration, good));
        Accepted(() => ValidateOwnership(dir.ToUpperInvariant(), registration, good));
        Accepted(() => ValidateOwnership(dir, registration with { CommandVersion = 2 }, good with { BinaryPath = Command(dir, 5090, 2) }));
        Rejected(() => ValidateOwnership(dir, registration with { CommandVersion = 2 }, good));
        Rejected(() => ValidateOwnership(dir, registration with { CommandVersion = 3 }, good));
        Rejected(() => ValidateOwnership(dir, null, good));
        Rejected(() => ValidateOwnership(dir, registration with { ProductId = "other" }, good));
        Rejected(() => ValidateOwnership(dir, registration with { InstallDirectory = @"C:\Other" }, good));
        Rejected(() => ValidateOwnership(dir, registration with { DataDirectory = @"C:\Other" }, good));
        Rejected(() => ValidateOwnership(dir, registration with { Port = 0 }, good));
        Rejected(() => ValidateOwnership(dir, registration, good with { BinaryPath = @"C:\Other\service.exe" }));
        Rejected(() => ValidateOwnership(dir, registration, good with { Account = "LocalSystem" }));
        Rejected(() => ValidateOwnership(dir, registration, good with { ServiceType = 32 }));
        Rejected(() => ValidateDirectory(@"C:\"));
        Rejected(() => ValidateDirectory("relative"));
        Rejected(() => ValidateDirectory(@"\\server\share\SparkStudio"));
        Rejected(() => ValidateDirectory("C:\\unsafe\"path"));
        Rejected(() => ValidateDirectory(DataDirectory));
        Rejected(() => ValidateDirectory(Path.Combine(DataDirectory, "bin")));
        Rejected(() => ParseOptions(["--action", "remove", "--action", "install"]));
        Rejected(() => ParseOptions(["--unknown", "value"]));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Server.ExclusiveAddressUse = true;
        listener.Start();
        try { Rejected(() => ProbePort(((IPEndPoint)listener.LocalEndpoint).Port, null, null)); }
        finally { listener.Stop(); }
        Console.WriteLine($"PASS {checks} installer ownership, path, argument and occupied-port checks; no service or registration was changed.");
        await NetworkSelfTestAsync();
        await ReadinessSelfTestAsync();
        await ShutdownSelfTestAsync();
        Native.DebugPrivilegeSelfTest();
    }

    // A disposable diagnostic child maps an ordinary copied DLL so the self-test
    // exercises real Windows image-file locks without creating or stopping a service.
    private static void ShutdownTestChild(string directory)
    {
        var path = Path.Combine(ValidateDirectory(directory), "shutdown-test.dll");
        var library = NativeLibrary.Load(path);
        try
        {
            Console.WriteLine("image-loaded");
            if (Console.ReadLine() != "stop") return;
            Console.WriteLine("service-stopped");
            Thread.Sleep(700); // SCM notification can precede process teardown.
        }
        finally { NativeLibrary.Free(library); }
    }

    private static async Task ShutdownSelfTestAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio-shutdown-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var image = Path.Combine(directory, "shutdown-test.dll");
        File.Copy(Path.Combine(Environment.SystemDirectory, "version.dll"), image);
        var start = new ProcessStartInfo(Environment.ProcessPath ?? throw new InvalidOperationException("Missing helper executable path."))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("--action"); start.ArgumentList.Add("shutdown-test-child");
        start.ArgumentList.Add("--install-dir"); start.ArgumentList.Add(directory);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start isolated shutdown fixture.");
        var checks = 0;
        try
        {
            if (await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) != "image-loaded")
                throw new InvalidOperationException("The isolated shutdown fixture did not map its native image.");
            using var pinned = Native.PinProcess((uint)process.Id, Environment.ProcessPath!);
            try { File.Delete(image); throw new InvalidOperationException("The native image fixture did not hold a Windows file lock."); }
            catch (UnauthorizedAccessException) { checks++; }
            catch (IOException) { checks++; }
            try { Native.WaitForProcessExit(pinned, 40); throw new InvalidOperationException("A live process was accepted as exited."); }
            catch (TimeoutException) { if (process.HasExited) throw new InvalidOperationException("Timeout terminated the diagnostic process."); checks++; }
            await process.StandardInput.WriteLineAsync("stop");
            await process.StandardInput.FlushAsync();
            if (await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) != "service-stopped")
                throw new InvalidOperationException("The shutdown fixture did not publish its early stopped notification.");
            var wait = Stopwatch.StartNew();
            Native.WaitForStoppedAndExited(() => Native.Stopped, pinned, Stopwatch.StartNew());
            if (wait.ElapsedMilliseconds < 350 || !process.HasExited || process.ExitCode != 0)
                throw new InvalidOperationException("Reported service stop was confused with native process exit.");
            checks++;
            File.Delete(image);
            if (File.Exists(image)) throw new InvalidOperationException("The mapped native image remained locked after the process exited.");
            checks++;
            Native.WaitForProcessExit(pinned, 0); // Waiting on the original handle remains valid after exit.
            checks++;
            try { using var mismatch = Native.PinProcess((uint)Environment.ProcessId, Path.Combine(directory, "unrelated.exe")); throw new InvalidOperationException("An unrelated process image was accepted."); }
            catch (ArgumentException) { checks++; }
            Console.WriteLine($"PASS {checks} installer process-exit, early service-stop, native image-lock, bounded timeout and process-identity checks; no service or registration was changed.");
        }
        finally
        {
            // Close input to let our own fixture exit naturally even when an assertion
            // fails. Never terminate a service or another process to pass a test.
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            if (File.Exists(image)) File.Delete(image);
            Directory.Delete(directory);
        }
    }

    private static async Task ReadinessSelfTestAsync()
    {
        const uint processId = 1234;
        const string ready = "{\"product\":\"SparkStudio\",\"status\":\"ready\",\"pythonAvailable\":true,\"processId\":1234}";
        var checks = 0;
        async Task Check(HttpStatusCode code, string body, bool expected, string contentType = "application/json")
        {
            using var client = new HttpClient(new ReadinessFixtureHandler(request =>
            {
                if (request.RequestUri?.AbsoluteUri != "http://127.0.0.1:5092/api/ready") throw new InvalidOperationException("The installer readiness probe used the wrong endpoint.");
                return new HttpResponseMessage(code) { Content = new StringContent(body, System.Text.Encoding.UTF8, contentType) };
            }));
            if ((await ProbeReadinessAsync(client, 5092, processId, CancellationToken.None)).Ready != expected)
                throw new InvalidOperationException("Installer readiness regression failed.");
            checks++;
        }
        await Check(HttpStatusCode.OK, ready, true);
        await Check(HttpStatusCode.Unauthorized, ready, false);
        await Check(HttpStatusCode.Forbidden, ready, false);
        await Check(HttpStatusCode.ServiceUnavailable, ready, false);
        await Check(HttpStatusCode.Redirect, ready, false);
        await Check(HttpStatusCode.OK, "<html>Sign in</html>", false, "text/html");
        await Check(HttpStatusCode.OK, "{invalid", false);
        await Check(HttpStatusCode.OK, "[]", false);
        await Check(HttpStatusCode.OK, ready.Replace("true", "false", StringComparison.Ordinal), false);
        await Check(HttpStatusCode.OK, ready.Replace("1234", "4321", StringComparison.Ordinal), false);
        await Check(HttpStatusCode.OK, ready.Replace("1234", "\"1234\"", StringComparison.Ordinal), false);
        await Check(HttpStatusCode.OK, ready.Replace("SparkStudio", "Unrelated", StringComparison.Ordinal), false);
        await Check(HttpStatusCode.OK, ready.Replace("\"ready\"", "\"not-ready\"", StringComparison.Ordinal), false);
        await Check(HttpStatusCode.OK, new string('x', 4097), false);
        using (var client = new HttpClient(new ReadinessFixtureHandler(_ => throw new HttpRequestException("fixture connection failure"))))
        {
            if ((await ProbeReadinessAsync(client, 5092, processId, CancellationToken.None)).Ready) throw new InvalidOperationException("A failed connection was accepted as ready.");
            checks++;
        }
        using (var client = new HttpClient(new ReadinessFixtureHandler(_ => throw new TaskCanceledException("fixture request timeout"))))
        {
            if ((await ProbeReadinessAsync(client, 5092, processId, CancellationToken.None)).Ready) throw new InvalidOperationException("A timed-out request was accepted as ready.");
            checks++;
        }
        using (var deadline = new CancellationTokenSource())
        using (var client = new HttpClient(new ReadinessFixtureHandler(_ => new HttpResponseMessage(HttpStatusCode.OK))))
        {
            deadline.Cancel();
            try { await ProbeReadinessAsync(client, 5092, processId, deadline.Token); throw new InvalidOperationException("The readiness deadline was ignored."); }
            catch (OperationCanceledException) { checks++; }
            try { await ProbeReadinessAsync(client, 5092, 0, CancellationToken.None); throw new InvalidOperationException("A missing process identity was accepted."); }
            catch (ArgumentException) { checks++; }
        }
        Console.WriteLine($"PASS {checks} installer readiness endpoint, authentication, response and process-identity checks; no service or registration was changed.");
    }
}

internal sealed record ReadinessProbe(bool Ready, string Message);
internal sealed class ReadinessFixtureHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    { cancellationToken.ThrowIfCancellationRequested(); return Task.FromResult(respond(request)); }
}

internal sealed record Registration(string ProductId, string InstallDirectory, string DataDirectory, int Port, int CommandVersion = 1);
internal sealed record ServiceInfo(string BinaryPath, string Account, uint ServiceType, uint State);

internal sealed class ServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    internal ServiceHandle() : base(true) { }
    protected override bool ReleaseHandle() => Native.CloseServiceHandle(handle);
}

internal static class Native
{
    internal const uint OwnProcess = 0x10, Stopped = 1, Running = 4;
    internal const uint ReadAccess = 0x0001 | 0x0004, FullAccess = 0xF01FF;
    private const int ServiceDoesNotExist = 1060, ServiceNotActive = 1062, AlreadyRunning = 1056;

    internal static ServiceHandle OpenManager(bool readOnly = false)
    {
        var result = OpenSCManager(null, null, readOnly ? 0x0001u : 0x0001u | 0x0002u);
        if (result.IsInvalid)
        {
            result.Dispose();
            result = OpenSCManager(null, null, 0x0001);
            if (result.IsInvalid) throw new Win32Exception();
        }
        return result;
    }

    internal static ServiceHandle? OpenServiceIfPresent(ServiceHandle manager, uint access)
    {
        var result = OpenService(manager, "SparkStudio", access);
        if (!result.IsInvalid) return result;
        var error = Marshal.GetLastWin32Error();
        result.Dispose();
        if (error == ServiceDoesNotExist) return null;
        throw new Win32Exception(error);
    }

    internal static ServiceInfo ReadService(ServiceHandle service)
    {
        QueryServiceConfig(service, IntPtr.Zero, 0, out var needed);
        if (needed == 0) throw new Win32Exception();
        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!QueryServiceConfig(service, buffer, needed, out _)) throw new Win32Exception();
            var config = Marshal.PtrToStructure<ServiceConfiguration>(buffer);
            return new ServiceInfo(Marshal.PtrToStringUni(config.BinaryPath) ?? "", Marshal.PtrToStringUni(config.Account) ?? "", config.Type, Status(service).State);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static ServiceHandle CreateChecked(ServiceHandle manager, string command)
    {
        var result = CreateService(manager, "SparkStudio", "SparkStudio Gateway", FullAccess, OwnProcess, 2, 1, command, null, IntPtr.Zero, null, @"NT AUTHORITY\LocalService", null);
        if (result.IsInvalid) throw new Win32Exception();
        return result;
    }

    internal static void Configure(ServiceHandle service, string command)
    {
        if (!ChangeServiceConfig(service, OwnProcess, 2, 1, command, null, IntPtr.Zero, null, @"NT AUTHORITY\LocalService", null, "SparkStudio Gateway")) throw new Win32Exception();
    }

    internal static void ConfigureIdentity(ServiceHandle service)
    {
        var sid = Marshal.AllocHGlobal(4);
        try { Marshal.WriteInt32(sid, 1); if (!ChangeServiceConfig2(service, 5, sid)) throw new Win32Exception(); }
        finally { Marshal.FreeHGlobal(sid); }
    }

    internal static void StartAndWait(ServiceHandle service)
    {
        if (Status(service).State == Running) return;
        if (!StartService(service, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != AlreadyRunning) throw new Win32Exception();
        Wait(service, Running);
    }

    internal static void StopAndWait(ServiceHandle service, string directory)
    {
        var observed = ProcessStatus(service);
        if (observed.State == Stopped) return;
        // Pending states do not guarantee a valid SCM process ID. Do not guess a
        // process or start replacing files while another stop/start is in progress.
        if (observed.State is not (Running or 7) || observed.ProcessId == 0)
            throw new InvalidOperationException("The SparkStudio service is changing state. Wait for it to finish, then retry setup. Program files have not been replaced by this step.");
        using var process = PinProcess(observed.ProcessId, Path.Combine(directory, "SparkStudio.Gateway.exe"));
        var confirmed = ProcessStatus(service);
        if (confirmed.State != Stopped && confirmed.ProcessId != observed.ProcessId)
            throw new InvalidOperationException("The SparkStudio service process changed before shutdown. Retry setup after its state is stable.");
        var deadline = Stopwatch.StartNew();
        if (confirmed.State is not (Stopped or 3) && !ControlService(service, 1, out _) && Marshal.GetLastWin32Error() != ServiceNotActive)
            throw new Win32Exception();
        WaitForStoppedAndExited(() => Status(service).State, process, deadline);
        if (Status(service).State != Stopped)
            throw new InvalidOperationException("The SparkStudio service restarted during shutdown. Setup has not continued; check the service before retrying.");
    }

    internal static SafeProcessHandle PinProcess(uint processId, string expectedExecutable) => PinProcess(processId, expectedExecutable, out _);

    internal static SafeProcessHandle PinProcess(uint processId, string expectedExecutable, out bool debugFallback)
    {
        const uint synchronizeAndQuery = 0x00100000 | 0x1000;
        debugFallback = false;
        var process = OpenProcess(synchronizeAndQuery, false, processId);
        try
        {
            if (process.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                process.Dispose();
                if (error != 5) throw new Win32Exception(error, "OpenProcess could not acquire a read-only query/synchronize handle for the owned gateway.");
                // An elevated administrator can still be denied by a LocalService
                // process DACL. Enable only our existing debug privilege, only for
                // acquiring these two rights, and restore it before doing anything else.
                int fallbackError;
                using (DebugPrivilegeScope.Enable())
                {
                    process = OpenProcess(synchronizeAndQuery, false, processId);
                    fallbackError = Marshal.GetLastWin32Error();
                }
                debugFallback = true;
                if (process.IsInvalid)
                    throw new Win32Exception(fallbackError, "OpenProcess remained denied for the owned gateway after temporarily enabling SeDebugPrivilege.");
            }
            var path = new char[32768];
            var length = path.Length;
            if (!QueryFullProcessImageName(process, 0, path, ref length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryFullProcessImageName could not verify the owned gateway executable.");
            if (!Path.GetFullPath(new string(path, 0, length)).Equals(Path.GetFullPath(expectedExecutable), StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("The service process does not match the owned gateway executable. No process was stopped or terminated.");
            return process;
        }
        catch { process.Dispose(); throw; }
    }

    internal static uint? ReadDebugPrivilegeAttributes()
    {
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out var token))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken could not inspect the helper's own privilege state.");
        using (token)
        {
            if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out var luid))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupPrivilegeValue could not identify SeDebugPrivilege.");
            GetTokenInformation(token, 3, IntPtr.Zero, 0, out var required);
            if (required <= 0 || required > 65536)
                throw new InvalidOperationException("The helper token returned an invalid privilege-information size.");
            var buffer = Marshal.AllocHGlobal(required);
            try
            {
                if (!GetTokenInformation(token, 3, buffer, required, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation could not inspect the helper's own privileges.");
                var count = Marshal.ReadInt32(buffer);
                if (count < 0 || count > (required - 4) / 12) throw new InvalidOperationException("The helper token returned malformed privilege information.");
                for (var index = 0; index < count; index++)
                {
                    var value = Marshal.PtrToStructure<LuidAndAttributes>(buffer + 4 + index * 12);
                    if (value.Luid.LowPart == luid.LowPart && value.Luid.HighPart == luid.HighPart) return value.Attributes;
                }
                return null;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    internal static void DebugPrivilegeSelfTest()
    {
        var before = ReadDebugPrivilegeAttributes();
        var outcome = "";
        try
        {
            using (DebugPrivilegeScope.Enable())
            {
                if ((ReadDebugPrivilegeAttributes() & 2) != 2)
                    throw new InvalidOperationException("The diagnostic privilege was not enabled within its scope.");
            }
            if (before is null) throw new InvalidOperationException("A missing token privilege was unexpectedly added.");
            outcome = "temporary enable and exact restoration";
        }
        catch (Win32Exception error) when (error.NativeErrorCode == 1300 && before is null)
        {
            outcome = "missing privilege rejected (ERROR_NOT_ALL_ASSIGNED) without token mutation";
        }
        if (ReadDebugPrivilegeAttributes() != before)
            throw new InvalidOperationException("The privilege self-test changed the helper's original token privilege state.");
        Console.WriteLine($"PASS installer debug privilege scope: {outcome}; no service or registration was changed.");
    }

    private sealed class DebugPrivilegeScope(SafeAccessTokenHandle token, TokenPrivileges previous) : IDisposable
    {
        public static DebugPrivilegeScope Enable()
        {
            if (!OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, out var token))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken could not open the elevated helper's own token for temporary privilege adjustment.");
            try
            {
                if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out var luid))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupPrivilegeValue could not identify SeDebugPrivilege.");
                var desired = new TokenPrivileges { Count = 1, Privilege = new LuidAndAttributes { Luid = luid, Attributes = 2 } };
                var adjusted = AdjustTokenPrivileges(token, false, ref desired, Marshal.SizeOf<TokenPrivileges>(), out var previous, out _);
                var error = Marshal.GetLastWin32Error();
                if (!adjusted || error != 0)
                    throw new Win32Exception(error, error == 1300
                        ? "This installer token does not contain SeDebugPrivilege, so setup cannot safely acquire the gateway shutdown handle. The service has not been stopped; no program files have been replaced by this step."
                        : "AdjustTokenPrivileges could not temporarily enable the helper's existing SeDebugPrivilege.");
                return new DebugPrivilegeScope(token, previous);
            }
            catch { token.Dispose(); throw; }
        }

        public void Dispose()
        {
            try
            {
                if (previous.Count == 0) return;
                var restored = AdjustTokenPrivileges(token, false, ref previous, 0, IntPtr.Zero, IntPtr.Zero);
                var error = Marshal.GetLastWin32Error();
                if (!restored || error != 0)
                    throw new Win32Exception(error, "AdjustTokenPrivileges could not restore the helper's original debug privilege state; setup has not continued.");
            }
            finally { token.Dispose(); }
        }
    }

    internal static void WaitForStoppedAndExited(Func<uint> serviceState, SafeProcessHandle process, Stopwatch deadline)
    {
        while (serviceState() != Stopped)
        {
            if (deadline.ElapsedMilliseconds >= 40000)
                throw new TimeoutException("The SparkStudio service did not stop within 40 seconds. No process was terminated. Wait for shutdown to finish before retrying setup.");
            Thread.Sleep(100);
        }
        // SERVICE_STOPPED is a notification, not a process-exit barrier. Retain
        // the original kernel handle so PID reuse cannot change what we wait on.
        WaitForProcessExit(process, (int)Math.Max(0, 40000 - deadline.ElapsedMilliseconds));
    }

    internal static void WaitForProcessExit(SafeProcessHandle process, int timeoutMilliseconds)
    {
        var result = WaitForSingleObject(process, checked((uint)timeoutMilliseconds));
        if (result == 0) return;
        if (result == 258)
            throw new TimeoutException("The SparkStudio gateway process has not finished exiting. Setup has not continued and no process was terminated. Wait for shutdown to finish before retrying setup.");
        throw new Win32Exception();
    }

    private static void Wait(ServiceHandle service, uint desired)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(40))
        {
            if (Status(service).State == desired) return;
            Thread.Sleep(200);
        }
        throw new InvalidOperationException($"The SparkStudio service did not reach the expected state within 40 seconds. No unrelated process was terminated.");
    }

    private static ServiceStatus Status(ServiceHandle service)
    {
        if (!QueryServiceStatus(service, out var status)) throw new Win32Exception();
        return status;
    }

    internal static uint RunningProcessId(ServiceHandle service)
    {
        var status = ProcessStatus(service);
        return status.State == Running ? status.ProcessId : 0;
    }

    private static ServiceStatusProcess ProcessStatus(ServiceHandle service)
    {
        if (!QueryServiceStatusEx(service, 0, out var status, Marshal.SizeOf<ServiceStatusProcess>(), out _)) throw new Win32Exception();
        return status;
    }

    internal static void DeleteChecked(ServiceHandle service) { if (!DeleteService(service)) throw new Win32Exception(); }

    [StructLayout(LayoutKind.Sequential)] private struct ServiceConfiguration
    {
        public uint Type, StartType, ErrorControl;
        public IntPtr BinaryPath, LoadGroup;
        public uint Tag;
        public IntPtr Dependencies, Account, DisplayName;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus
    {
        public uint Type, State, AcceptedControls, Win32ExitCode, SpecificExitCode, CheckPoint, WaitHint;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatusProcess
    {
        public uint Type, State, AcceptedControls, Win32ExitCode, SpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] private struct LuidAndAttributes { public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct TokenPrivileges { public uint Count; public LuidAndAttributes Privilege; }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ServiceHandle OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ServiceHandle OpenService(ServiceHandle manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryServiceConfig(ServiceHandle service, IntPtr buffer, uint size, out uint required);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(ServiceHandle service, out ServiceStatus status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(ServiceHandle service, int infoLevel, out ServiceStatusProcess status, int bufferSize, out int required);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ServiceHandle CreateService(ServiceHandle manager, string name, string displayName, uint access, uint type, uint start, uint error, string path, string? group, IntPtr tag, string? dependencies, string account, string? password);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ChangeServiceConfig(ServiceHandle service, uint type, uint start, uint error, string path, string? group, IntPtr tag, string? dependencies, string account, string? password, string displayName);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ChangeServiceConfig2(ServiceHandle service, uint level, IntPtr info);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool StartService(ServiceHandle service, uint count, IntPtr arguments);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(ServiceHandle service, uint control, out ServiceStatus status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DeleteService(ServiceHandle service);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, [Out] char[] path, ref int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeValue(string? system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, IntPtr buffer, int length, out int required);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(SafeAccessTokenHandle token, bool disableAll, ref TokenPrivileges desired, int length, out TokenPrivileges previous, out int required);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(SafeAccessTokenHandle token, bool disableAll, ref TokenPrivileges desired, int length, IntPtr previous, IntPtr required);
}
